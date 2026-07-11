import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type { WebhookJobData } from '../../routes/webhook.routes.js';
import { broadcastEmployeeActive } from '../../hubs/liveStatus.hub.js';

// System states Trackpilots emits as App events — never counted as real productive/neutral work.
// Keep in sync with dailySummary.job.ts and clientDashboard.service.ts.
const SYSTEM_APP_BLOCKLIST = new Set(['Locked', 'Idle', 'Screen Lock', 'TrackPilots', 'Activity ITR']);

export class AppEventJob {
    constructor(
        private readonly db: PrismaClient,
        private readonly io: Server,
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

        // Idempotency
        if (data.externalTrackingId) {
            const exists = await this.db.activityEvent.findFirst({
                where: { externalTrackingId: data.externalTrackingId },
            });
            if (exists) {
                await markLog(this.db, data.webhookLogId, 'Processed');
                return;
            }
        }

        const payload = JSON.parse(data.rawJson);
        const item = Array.isArray(payload.data) ? payload.data[0] : payload.data;
        const tracking = item?.tracking ?? {};
        const app = tracking.app ?? {};
        const time = tracking.time ?? {};

        const appName: string | null = app.name ?? null;
        const appTypeRaw: string | null = app.type ?? null;
        const appCategory: string | null = app.category ?? null;
        const appDomain: string | null = app.domain ?? null;
        const appFullUrl: string | null = app.fullUrl ?? null;
        const durationSeconds: number | null = time.durationInSeconds ?? null;
        const startTime = time.startDate ? new Date(time.startDate) : null;
        const endTime = time.endDate ? new Date(time.endDate) : null;
        const os: string | null = tracking.operatingSystem ?? null;
        const payloadStatus: string | null = app.productivityStatus ?? null;
        const appType = appTypeRaw?.toLowerCase() === 'website' ? 'Website' : 'Application';

        const productivity = await this.resolveProductivity(mapping.orgId, appName, appDomain, payloadStatus);

        // Locked/Idle etc. are system states, not real app usage — they must not add to the
        // productive/neutral/unproductive seconds (the 5-min cron excludes them too). Without this,
        // a single "Locked" event with a large durationSeconds inflates neutralSeconds for hours.
        const isSystemApp = !!(appName && SYSTEM_APP_BLOCKLIST.has(appName));
        const classifiedDuration = isSystemApp ? 0 : (durationSeconds ?? 0);

        await this.db.activityEvent.create({
            data: {
                id: crypto.randomUUID(),
                orgId: mapping.orgId,
                teamId: mapping.employee.teamId,
                employeeId: mapping.employeeId,
                eventType: 'App',
                appName, appType, appCategory, appDomain, appFullUrl,
                productivityStatus: productivity,
                durationSeconds, startTime, endTime,
                operatingSystem: os,
                externalTrackingId: data.externalTrackingId,
                rawPayload: payload,
                receivedAt: new Date(data.occurredAt),
            },
        });

        // Prefer actual activity timestamps; fall back to webhook delivery time only when
        // Trackpilots sends no startDate/endDate (common for older agent versions).
        const activityTime = endTime ?? startTime ?? new Date(data.occurredAt);
        const bucketTime = startTime ?? new Date(data.occurredAt);

        await this.db.employee.update({
            where: { id: mapping.employeeId },
            data: {
                isCurrentlyWorking: true,
                lastSeenAt: activityTime,
                ...(os ? { operatingSystem: os } : {}),
                updatedAt: new Date(),
            },
        });

        await this.upsertDailySummary(
            mapping.orgId, mapping.employeeId, mapping.employee.teamId,
            bucketTime, productivity, classifiedDuration,
        );

        await markLog(this.db, data.webhookLogId, 'Processed');

        broadcastEmployeeActive(this.io, mapping.orgId, {
            employeeId: mapping.employeeId,
            status: appName ?? 'Unknown',
            timestamp: data.occurredAt,
        });
    }

    private async resolveProductivity(
        orgId: string,
        appName: string | null,
        appDomain: string | null,
        payloadStatus: string | null,
    ): Promise<string> {
        if (appName) {
            const orgOverrides = await this.db.orgProductivityOverride.findMany({ where: { orgId } });
            const orgMatch = orgOverrides.find(o =>
                matchPattern(o.appNamePattern, appName) &&
                (!o.appDomainPattern || !appDomain || matchPattern(o.appDomainPattern, appDomain)),
            );
            if (orgMatch) return orgMatch.overriddenStatus;

            const globals = await this.db.globalProductivityClassification.findMany();
            const globalMatch = globals.find(g =>
                matchPattern(g.appNamePattern, appName) &&
                (!g.appDomainPattern || !appDomain || matchPattern(g.appDomainPattern, appDomain)),
            );
            if (globalMatch) return globalMatch.defaultStatus;
        }

        return normaliseStatus(payloadStatus) ?? 'Neutral';
    }

    private async upsertDailySummary(
        orgId: string, employeeId: string, teamId: string | null, date: Date,
        status: string, durationSeconds: number,
    ): Promise<void> {
        // IST-aligned day boundary to match dailySummary.job.ts keying
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(date.getTime() + IST_OFFSET_MS);
        const dayStart = new Date(Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()));

        const productive = status === 'Productive' ? durationSeconds : 0;
        const unproductive = status === 'Unproductive' ? durationSeconds : 0;
        const neutral = status === 'Neutral' ? durationSeconds : 0;

        // Atomic upsert — no read-modify-write race condition
        // Score is intentionally omitted here; the 5-min cron recalculates it from raw events
        await this.db.dailySummary.upsert({
            where: { orgId_employeeId_summaryDate: { orgId, employeeId, summaryDate: dayStart } },
            update: {
                productiveSeconds: { increment: productive },
                unproductiveSeconds: { increment: unproductive },
                neutralSeconds: { increment: neutral },
                isPresent: true,
                updatedAt: new Date(),
            },
            create: {
                id: crypto.randomUUID(),
                orgId, employeeId, teamId,
                summaryDate: dayStart,
                productiveSeconds: productive,
                unproductiveSeconds: unproductive,
                neutralSeconds: neutral,
                isPresent: true,
                updatedAt: new Date(),
            },
        });
    }
}

function matchPattern(pattern: string, value: string): boolean {
    return pattern === '*' || value.toLowerCase().includes(pattern.toLowerCase());
}

function normaliseStatus(s: string | null): string | null {
    switch (s?.toLowerCase()) {
        case 'productive': return 'Productive';
        case 'unproductive': return 'Unproductive';
        case 'neutral': return 'Neutral';
        default: return null;
    }
}

async function markLog(db: PrismaClient, logId: string, status: 'Processed' | 'Failed') {
    await db.webhookLog.update({
        where: { id: logId },
        data: { processingStatus: status, processedAt: new Date() },
    });
}
