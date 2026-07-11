import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';
import type { TrackpilotsService } from '../infrastructure/agents/trackpilots.service.js';

function formatTimeField(val: unknown): string {
    if (!val) return '08:00';
    if (val instanceof Date) {
        return `${String(val.getUTCHours()).padStart(2, '0')}:${String(val.getUTCMinutes()).padStart(2, '0')}`;
    }
    // Already a string (e.g. from defaultSettings fallback)
    return String(val).slice(0, 5); // take "HH:MM" from "HH:MM:SS" or ISO
}

function normaliseSettings(s: Record<string, unknown>): Record<string, unknown> {
    return { ...s, defaultExpectedInTime: formatTimeField(s['defaultExpectedInTime']) };
}

export class OrgSettingsService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
        private readonly trackpilots?: TrackpilotsService,
    ) {}

    async getSettings(orgId: string) {
        const s = await this.db.orgDefaultSetting.findFirst({ where: { orgId } });
        return normaliseSettings((s ?? defaultSettings(orgId)) as Record<string, unknown>);
    }

    async updateSettings(orgId: string, actorId: string, req: Record<string, unknown>) {
        const existing = await this.db.orgDefaultSetting.findFirst({ where: { orgId } });

        const s = existing
            ? await this.db.orgDefaultSetting.update({ where: { id: existing.id }, data: { ...req, updatedAt: new Date() } })
            : await this.db.orgDefaultSetting.create({ data: { id: randomUUID(), orgId, updatedAt: new Date(), ...(req as any) } });

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'org.settings_updated', orgId });

        // Best-effort: push org defaults to Trackpilots. Logs outcome — grep pm2 for "[TP-SYNC]".
        if (this.trackpilots) {
            this.pushToTrackpilots(orgId, s as Record<string, unknown>)
                .then(() => console.log(`[TP-SYNC] OK — pushed org default settings to Trackpilots for org=${orgId}`))
                .catch((err: any) => {
                    const status = err?.response?.status ?? '';
                    const body = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : '';
                    console.error(`[TP-SYNC] FAILED org default settings for org=${orgId}: ${status} ${err?.message ?? err} ${body}`);
                });
        }

        return normaliseSettings(s as Record<string, unknown>);
    }

    private async pushToTrackpilots(orgId: string, s: Record<string, unknown>): Promise<void> {
        const inTime = formatTimeField(s['defaultExpectedInTime']);
        await this.trackpilots!.updateDefaultSettings(orgId, {
            workHours: {
                expectedWorkMinutesPerDay: Math.round(Number(s['defaultWorkHoursPerDay'] ?? 8) * 60),
                expectedProductiveWorkMinutesPerDay: Math.round(Number(s['defaultProductiveHoursPerDay'] ?? 6) * 60),
                expectedInTime: inTime,
            },
            screenshot: {
                enableScreenCapture: Boolean(s['defaultScreenshotEnabled'] ?? true),
                enableBlurScreenCapture: Boolean(s['defaultBlurEnabled'] ?? false),
                screenCaptureIntervalMinutes: Number(s['defaultCaptureIntervalMinutes'] ?? 1),
            },
            idleAlert: {
                enableIdleTimeAlert: Boolean(s['defaultIdleAlertEnabled'] ?? true),
                minimumIdleTimeMinutes: Number(s['defaultMinIdleTimeMinutes'] ?? 5),
            },
            stealth: {
                enableStealthMonitoring: Boolean(s['defaultStealthEnabled'] ?? false),
            },
            ...(s['timezone'] ? { timezone: String(s['timezone']) } : {}),
        });
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
