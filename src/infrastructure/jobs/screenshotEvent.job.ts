import { Readable } from 'node:stream';
import axios from 'axios';
import sharp from 'sharp';
import type { PrismaClient } from '@prisma/client';
import type { S3Storage } from '../storage/s3Storage.js';
import type { LocalFileStorage } from '../storage/localFileStorage.js';
import type { WebhookJobData } from '../../routes/webhook.routes.js';

type Storage = S3Storage | LocalFileStorage;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export class ScreenshotEventJob {
    constructor(
        private readonly db: PrismaClient,
        private readonly storage: Storage,
    ) {}

    async execute(data: WebhookJobData): Promise<void> {
        try {
            await this._process(data);
        } catch (err) {
            // Ensure webhook log is marked failed even if internal markLog throws
            await markLog(this.db, data.webhookLogId, 'Failed').catch(() => {});
            throw err; // Re-throw so pg-boss marks the job as failed and can retry
        }
    }

    private async _process(data: WebhookJobData): Promise<void> {
        const mapping = await this.db.agentEmployeeMapping.findFirst({
            where: { externalUserId: data.externalUserId ?? '', agentProvider: 'trackpilots' },
            include: { employee: true },
        });

        if (!mapping) {
            await markLog(this.db, data.webhookLogId, 'Failed');
            return;
        }

        // Idempotency — check by external screenshot ID
        if (data.externalTrackingId) {
            const exists = await this.db.screenshot.findFirst({
                where: { externalScreenshotId: data.externalTrackingId },
            });
            if (exists) {
                await markLog(this.db, data.webhookLogId, 'Processed');
                return;
            }
        }

        // Check if screen capture is enabled for this employee
        const [screenshotSetting, orgDefault] = await Promise.all([
            this.db.screenshotSetting.findFirst({ where: { employeeId: mapping.employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId: mapping.orgId } }),
        ]);

        const captureEnabled = screenshotSetting?.screenCaptureEnabled
            ?? orgDefault?.defaultScreenshotEnabled
            ?? true;

        if (!captureEnabled) {
            await markLog(this.db, data.webhookLogId, 'Processed');
            return;
        }

        const blurEnabled = screenshotSetting?.blurEnabled ?? orgDefault?.defaultBlurEnabled ?? false;

        const payload = JSON.parse(data.rawJson);
        const item = Array.isArray(payload.data) ? payload.data[0] : payload.data;
        const screenshot = item?.screenshot ?? {};
        const app = screenshot.app ?? {};
        const time = screenshot.time ?? {};

        // Skip simulation placeholders
        const imageBuffer: string | null = screenshot.imageBuffer ?? null;
        const isSimulation = !imageBuffer || imageBuffer.startsWith('[simulation');
        if (isSimulation) {
            await markLog(this.db, data.webhookLogId, 'Processed');
            return;
        }

        const appName: string | null = app.name ?? null;
        const appDomain: string | null = app.domain ?? null;
        const appTypeRaw: string | null = app.type ?? null;
        const appCategory: string | null = app.category ?? null;
        const appFullUrl: string | null = app.fullUrl ?? null;
        const productivityStatus: string | null = app.productivityStatus ?? null;
        const isIdle: boolean = screenshot.isIdle ?? false;
        const os: string | null = screenshot.operatingSystem ?? null;
        const workType: string | null = screenshot.workType ?? null;
        const capturedAt = time.capturedAt ? new Date(time.capturedAt) : new Date(data.occurredAt);
        const appType = appTypeRaw?.toLowerCase() === 'website' ? 'Website' : 'Application';

        const imageUrl = imageBuffer.startsWith('http') ? imageBuffer : null;
        const imageBase64 = !imageBuffer.startsWith('http') ? imageBuffer : null;
        if (!imageUrl && !imageBase64) {
            await markLog(this.db, data.webhookLogId, 'Failed');
            return;
        }

        const screenshotId = crypto.randomUUID();
        const keyPrefix = `${mapping.orgId}/${mapping.employeeId}/${screenshotId}`;

        const { fullKey, thumbKey } = await this.downloadAndUpload(imageUrl, imageBase64, keyPrefix, blurEnabled);

        // IST-aligned day boundary to match dailySummary keying
        const capturedAtIst = new Date(capturedAt.getTime() + IST_OFFSET_MS);
        const dayStart = new Date(Date.UTC(
            capturedAtIst.getUTCFullYear(), capturedAtIst.getUTCMonth(), capturedAtIst.getUTCDate(),
        ));

        await this.db.screenshot.create({
            data: {
                id: screenshotId,
                orgId: mapping.orgId,
                teamId: mapping.employee.teamId,
                employeeId: mapping.employeeId,
                externalScreenshotId: data.externalTrackingId,
                imageUrl: fullKey,
                thumbnailUrl: thumbKey,
                isBlurred: blurEnabled,
                appName, appType, appCategory, appDomain, appFullUrl,
                productivityStatus, isIdle, operatingSystem: os, workType, capturedAt,
            },
        });

        // Increment the matching daily summary's screenshot count
        const summary = await this.db.dailySummary.findFirst({
            where: { orgId: mapping.orgId, employeeId: mapping.employeeId, summaryDate: dayStart },
        });
        if (summary) {
            await this.db.dailySummary.update({
                where: { id: summary.id },
                data: { screenshotsCount: { increment: 1 }, updatedAt: new Date() },
            });
        }

        await markLog(this.db, data.webhookLogId, 'Processed');
    }

    private async downloadAndUpload(
        sourceUrl: string | null, sourceBase64: string | null, keyPrefix: string, blur: boolean,
    ): Promise<{ fullKey: string; thumbKey: string }> {
        let buf: Buffer;
        if (sourceUrl) {
            const res = await axios.get(sourceUrl, {
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: 25 * 1024 * 1024, // 25 MB cap
            });
            buf = Buffer.from(res.data as ArrayBuffer);
        } else {
            buf = Buffer.from(sourceBase64!, 'base64');
        }

        if (buf.length === 0) throw new Error('Empty image buffer received');

        // Validate it's a real image before heavy processing
        const meta = await sharp(buf).metadata();
        if (!meta.width || !meta.height) throw new Error('Invalid image: no dimensions detected');

        if (blur) {
            buf = await sharp(buf).blur(10).jpeg({ quality: 80 }).toBuffer();
        }

        const fullKey = `${keyPrefix}/full.jpg`;
        await this.storage.upload(Readable.from(buf), fullKey, 'image/jpeg');

        const thumb = await sharp(buf)
            .resize({ width: 320, withoutEnlargement: true })
            .jpeg({ quality: 75 })
            .toBuffer();
        const thumbKey = `${keyPrefix}/thumb.jpg`;
        await this.storage.upload(Readable.from(thumb), thumbKey, 'image/jpeg');

        return { fullKey, thumbKey };
    }
}

async function markLog(db: PrismaClient, logId: string, status: 'Processed' | 'Failed') {
    await db.webhookLog.update({
        where: { id: logId },
        data: { processingStatus: status, processedAt: new Date() },
    });
}
