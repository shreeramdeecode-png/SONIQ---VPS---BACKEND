import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';

export class OrgSettingsService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
    ) {}

    async getSettings(orgId: string) {
        const s = await this.db.orgDefaultSetting.findFirst({ where: { orgId } });
        return s ?? defaultSettings(orgId);
    }

    async updateSettings(orgId: string, actorId: string, req: Record<string, unknown>) {
        const existing = await this.db.orgDefaultSetting.findFirst({ where: { orgId } });

        const s = existing
            ? await this.db.orgDefaultSetting.update({ where: { id: existing.id }, data: { ...req, updatedAt: new Date() } })
            : await this.db.orgDefaultSetting.create({ data: { id: randomUUID(), orgId, updatedAt: new Date(), ...(req as any) } });

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'org.settings_updated', orgId });
        return s;
    }

    async listOverrides(orgId: string) {
        return this.db.orgProductivityOverride.findMany({
            where: { orgId },
            orderBy: { appNamePattern: 'asc' },
        });
    }

    async createOverride(orgId: string, actorId: string, req: {
        appNamePattern: string; appDomainPattern?: string; overriddenStatus: string;
    }) {
        const override = await this.db.orgProductivityOverride.create({
            data: { id: randomUUID(), orgId, updatedAt: new Date(), ...req },
        });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'org.override_created',
            orgId, targetType: 'OrgProductivityOverride', targetId: override.id, after: req.appNamePattern });
        return override;
    }

    async deleteOverride(orgId: string, actorId: string, overrideId: string) {
        const override = await this.db.orgProductivityOverride.findFirst({ where: { id: overrideId, orgId } });
        if (!override) throw Object.assign(new Error(`Override ${overrideId} not found.`), { statusCode: 404 });

        await this.db.orgProductivityOverride.delete({ where: { id: overrideId } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'org.override_deleted',
            orgId, targetType: 'OrgProductivityOverride', targetId: overrideId, before: override.appNamePattern });
    }
}

function defaultSettings(orgId: string) {
    return {
        orgId,
        defaultWorkHoursPerDay: 8, defaultProductiveHoursPerDay: 6,
        defaultExpectedInTime: '08:00',
        defaultScreenshotEnabled: true, defaultBlurEnabled: false, defaultCaptureIntervalMinutes: 1,
        defaultIdleAlertEnabled: true, defaultMinIdleTimeMinutes: 5,
        defaultStealthEnabled: false, timezone: 'UTC',
    };
}
