import { Readable } from 'node:stream';
import axios from 'axios';
import sharp from 'sharp';
import type { PrismaClient } from '@prisma/client';
import type { S3Storage } from '../storage/s3Storage.js';
import type { LocalFileStorage } from '../storage/localFileStorage.js';
import type { WebhookJobData } from '../../routes/webhook.routes.js';

type Storage = S3Storage | LocalFileStorage;

export class ScreenshotEventJob {
    constructor(
        private readonly db: PrismaClient,
        private readonly storage: Storage,
    ) {}

    async execute(data: WebhookJobData): Promise<void> {
        const mapping = await this.db.agentEmployeeMapping.findFirst({
            where: { externalUserId: data.externalUserId ?? '', agentProvider: 'trackpilots' },
            include: { employee: true },
        });

        if (!mapping) {
            await markLog(this.db, data.webhookLogId, 'Failed');
            return;
        }

        if (data.externalTrackingId) {
            const exists = await this.db.screenshot.findFirst({
                where: { externalScreenshotId: data.externalTrackingId },
            });
            if (exists) {
                await markLog(this.db, data.webhookLogId, 'Processed');
                return;
            }
        }

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

        const rawImageField = screenshot.imageBuffer ?? null;

        const isSimulation = !rawImageField ||
            (typeof rawImageField === 'string' && rawImageField.startsWith('[simulation'));
        if (isSimulation) {
            await markLog(this.db, data.webhookLogId, 'Processed');
            return;
        }

        // Trackpilots sends imageBuffer as serialized Node Buffer: { type: 'Buffer', data: [255, 216, ...] }
        let imageUrl: string | null = null;
        let imageRawBuf: Buffer | null = null;

        if (typeof rawImageField === 'string') {
            if (rawImageField.startsWith('http://') || rawImageField.startsWith('https://')) {
                imageUrl = rawImageField;
            } else {
                imageRawBuf = Buffer.from(rawImageField, 'base64');
            }
        } else if (rawImageField?.type === 'Buffer' && Array.isArray(rawImageField.data)) {
            imageRawBuf = Buffer.from(rawImageField.data as number[]);
        } else if (Array.isArray(rawImageField)) {
            imageRawBuf = Buffer.from(rawImageField as number[]);
        } else {
            await markLog(this.db, data.webhookLogId, 'Failed');
            return;
        }

        const appName: string | null = app.name ?? null;
        const appDomain: string | null = app.domain ?? null;
        const appTypeRaw: string | null = app.type ?? null;
        const appCategory: string | null = app.category ?? null;
        const appFullUrl: string | null = app.fullUrl ?? null;
        const appIconUrl: string | null = app.iconUrl ?? null;
        const productivityStatus: string | null = app.productivityStatus ?? null;
        const isIdle: boolean = screenshot.isIdle ?? false;
        const os: string | null = screenshot.operatingSystem ?? null;
        const workType: string | null = screenshot.workType ?? null;
        const capturedAt = time.capturedAt ? new Date(time.capturedAt) : new Date(data.occurredAt);
        const appType = appTypeRaw?.toLowerCase() === 'website' ? 'Website' : 'Application';

        const screenshotId = crypto.randomUUID();
        const keyPrefix = `${mapping.orgId}/${mapping.employeeId}/${screenshotId}`;

        const { fullKey, thumbKey } = await this.downloadAndUpload(imageUrl, imageRawBuf, keyPrefix, blurEnabled);

        const dayStart = new Date(Date.UTC(
            capturedAt.getUTCFullYear(), capturedAt.getUTCMonth(), capturedAt.getUTCDate(),
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
                appName, appType, appCategory, appDomain, appFullUrl, appIconUrl,
                productivityStatus, isIdle, operatingSystem: os, workType, capturedAt,
            },
        });

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
        sourceUrl: string | null, sourceBuffer: Buffer | null, keyPrefix: string, blur: boolean,
    ): Promise<{ fullKey: string; thumbKey: string }> {
        let buf: Buffer;
        if (sourceUrl) {
            const res = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
            buf = Buffer.from(res.data as ArrayBuffer);
        } else {
            buf = sourceBuffer!;
        }

        if (blur) {
            buf = Buffer.from(await sharp(buf).blur(10).jpeg().toBuffer());
        }

        const fullKey = `${keyPrefix}/full.jpg`;
        await this.storage.upload(Readable.from(buf), fullKey, 'image/jpeg');

        const thumb = await sharp(buf)
            .resize({ width: 320, withoutEnlargement: true })
            .jpeg()
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
