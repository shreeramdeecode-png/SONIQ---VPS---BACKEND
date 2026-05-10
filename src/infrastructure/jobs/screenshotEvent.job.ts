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
        const d = payload.data ?? payload;

        const imageUrl: string | null = d.image_url ?? null;
        if (!imageUrl) {
            await markLog(this.db, data.webhookLogId, 'Failed');
            return;
        }

        const appName: string | null = d.app_name ?? null;
        const appDomain: string | null = d.app_domain ?? null;
        const appTypeRaw: string | null = d.app_type ?? null;
        const appCategory: string | null = d.app_category ?? null;
        const appFullUrl: string | null = d.app_full_url ?? null;
        const isIdle: boolean = d.is_idle ?? false;
        const os: string | null = d.operating_system ?? null;
        const workType: string | null = d.work_type ?? null;
        const capturedAt = d.captured_at ? new Date(d.captured_at) : new Date(data.occurredAt);
        const appType = appTypeRaw?.toLowerCase() === 'website' ? 'Website' : 'Application';

        const screenshotId = crypto.randomUUID();
        const keyPrefix = `${mapping.orgId}/${mapping.employeeId}/${screenshotId}`;

        const { fullKey, thumbKey } = await this.downloadAndUpload(imageUrl, keyPrefix, blurEnabled);

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
                appName, appType, appCategory, appDomain, appFullUrl,
                isIdle, operatingSystem: os, workType, capturedAt,
            },
        });

        // Increment daily summary screenshot count
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
        sourceUrl: string, keyPrefix: string, blur: boolean,
    ): Promise<{ fullKey: string; thumbKey: string }> {
        const res = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
        let buf = Buffer.from(res.data as ArrayBuffer);

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
