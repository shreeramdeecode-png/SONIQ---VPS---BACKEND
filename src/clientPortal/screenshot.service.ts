import type { PrismaClient } from '@prisma/client';
import type { S3Storage } from '../infrastructure/storage/s3Storage.js';
import type { LocalFileStorage } from '../infrastructure/storage/localFileStorage.js';
import { paged, type PagedResult } from '../types/common.js';

type Storage = S3Storage | LocalFileStorage;

export class ScreenshotService {
    constructor(private readonly db: PrismaClient, private readonly storage: Storage) {}

    private async toUrl(key: string | null): Promise<string | null> {
        if (!key) return null;
        return this.storage.generateSignedUrl(key, 3600);
    }

    async listScreenshots(orgId: string, opts: {
        employeeId?: string; from?: Date; to?: Date; page?: number; pageSize?: number;
        productivityStatus?: string;
    } = {}): Promise<PagedResult<unknown>> {
        const { employeeId, from, to, page = 1, pageSize = 30, productivityStatus } = opts;
        const where = {
            orgId,
            ...(employeeId ? { employeeId } : {}),
            ...(productivityStatus ? { productivityStatus } : {}),
            ...(from || to ? {
                capturedAt: {
                    ...(from ? { gte: from } : {}),
                    ...(to ? { lte: to } : {}),
                },
            } : {}),
        };

        const [total, items, employeeNames] = await Promise.all([
            this.db.screenshot.count({ where }),
            this.db.screenshot.findMany({
                where, orderBy: { capturedAt: 'desc' },
                skip: (page - 1) * pageSize, take: pageSize,
            }),
            this.db.employee.findMany({ where: { orgId }, select: { id: true, name: true } })
                .then(rows => new Map(rows.map(r => [r.id, r.name]))),
        ]);

        const urls = await Promise.all(items.map(async s => ({
            imageUrl: await this.toUrl(s.imageUrl),
            thumbnailUrl: await this.toUrl(s.thumbnailUrl),
        })));

        return paged(items.map((s, i) => ({
            id: s.id, employeeId: s.employeeId,
            employeeName: employeeNames.get(s.employeeId) ?? 'Unknown',
            imageUrl: urls[i].imageUrl, thumbnailUrl: urls[i].thumbnailUrl, isBlurred: s.isBlurred,
            appName: s.appName, appDomain: s.appDomain, isIdle: s.isIdle,
            productivityStatus: s.productivityStatus, capturedAt: s.capturedAt,
        })), total, page, pageSize);
    }

    async getScreenshot(orgId: string, screenshotId: string) {
        const s = await this.db.screenshot.findFirst({ where: { id: screenshotId, orgId } });
        if (!s) throw Object.assign(new Error(`Screenshot ${screenshotId} not found.`), { statusCode: 404 });
        return {
            id: s.id, employeeId: s.employeeId,
            imageUrl: await this.toUrl(s.imageUrl),
            thumbnailUrl: await this.toUrl(s.thumbnailUrl),
            isBlurred: s.isBlurred,
            appName: s.appName, appDomain: s.appDomain, isIdle: s.isIdle,
            productivityStatus: s.productivityStatus, capturedAt: s.capturedAt,
        };
    }

    async toggleBlur(orgId: string, screenshotId: string, blur: boolean) {
        const screenshot = await this.db.screenshot.findFirst({ where: { id: screenshotId, orgId } });
        if (!screenshot) throw Object.assign(new Error(`Screenshot ${screenshotId} not found.`), { statusCode: 404 });
        await this.db.screenshot.update({ where: { id: screenshotId }, data: { isBlurred: blur } });
    }
}
