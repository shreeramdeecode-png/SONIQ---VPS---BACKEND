import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';
import { paged, type PagedResult } from '../types/common.js';

export class PlatformSettingsService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
    ) {}

    async listClassifications(page = 1, pageSize = 50): Promise<PagedResult<unknown>> {
        const [total, items] = await Promise.all([
            this.db.globalProductivityClassification.count(),
            this.db.globalProductivityClassification.findMany({
                orderBy: { appNamePattern: 'asc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);
        return paged(items, total, page, pageSize);
    }

    async createClassification(actorId: string, req: {
        appNamePattern: string;
        appDomainPattern?: string;
        appCategory?: string;
        defaultStatus: string;
    }) {
        const entity = await this.db.globalProductivityClassification.create({ data: { id: randomUUID(), updatedAt: new Date(), ...req } });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'classification.created',
            targetType: 'GlobalProductivityClassification', targetId: entity.id, after: req.appNamePattern });
        return entity;
    }

    async updateClassification(actorId: string, id: string, req: {
        appNamePattern?: string;
        appDomainPattern?: string;
        appCategory?: string;
        defaultStatus?: string;
    }) {
        const existing = await this.db.globalProductivityClassification.findUnique({ where: { id } });
        if (!existing) throw Object.assign(new Error(`Classification ${id} not found.`), { statusCode: 404 });

        const entity = await this.db.globalProductivityClassification.update({ where: { id }, data: req });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'classification.updated',
            targetType: 'GlobalProductivityClassification', targetId: id,
            before: existing.appNamePattern, after: entity.appNamePattern });
        return entity;
    }

    async deleteClassification(actorId: string, id: string) {
        const existing = await this.db.globalProductivityClassification.findUnique({ where: { id } });
        if (!existing) throw Object.assign(new Error(`Classification ${id} not found.`), { statusCode: 404 });

        await this.db.globalProductivityClassification.delete({ where: { id } });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'classification.deleted',
            targetType: 'GlobalProductivityClassification', targetId: id, before: existing.appNamePattern });
    }
}
