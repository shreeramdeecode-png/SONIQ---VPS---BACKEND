import type { PrismaClient } from '@prisma/client';
import { paged, type PagedResult } from '../types/common.js';

export class ScreenshotService {
    constructor(private readonly db: PrismaClient) {}

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

        return paged(items.map(s => ({
            id: s.id, employeeId: s.employeeId,
            employeeName: employeeNames.get(s.employeeId) ?? 'Unknown',
            imageUrl: s.imageUrl, thumbnailUrl: s.thumbnailUrl, isBlurred: s.isBlurred,
            appName: s.appName, appDomain: s.appDomain, isIdle: s.isIdle,
            productivityStatus: s.productivityStatus, capturedAt: s.capturedAt,
        })), total, page, pageSize);
    }

    async toggleBlur(orgId: string, screenshotId: string, blur: boolean) {
        const screenshot = await this.db.screenshot.findFirst({ where: { id: screenshotId, orgId } });
        if (!screenshot) throw Object.assign(new Error(`Screenshot ${screenshotId} not found.`), { statusCode: 404 });
        await this.db.screenshot.update({ where: { id: screenshotId }, data: { isBlurred: blur } });
    }
}
