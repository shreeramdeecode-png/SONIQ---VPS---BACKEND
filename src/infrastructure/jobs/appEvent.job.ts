import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type { WebhookJobData } from '../../routes/webhook.routes.js';
import { broadcastEmployeeActive } from '../../hubs/liveStatus.hub.js';

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

        // Use actual activity time for lastSeenAt, not webhook delivery time
        const activityTime = endTime ?? startTime ?? new Date(data.occurredAt);

        await this.db.employee.update({
            where: { id: mapping.employeeId },
            data: {
                lastSeenAt: activityTime,
                ...(os ? { operatingSystem: os } : {}),
                updatedAt: new Date(),
            },
        });

        // Use startTime for day bucketing so delayed webhooks land in the correct IST day
        await this.upsertDailySummary(
            mapping.orgId, mapping.employeeId, mapping.employee.teamId,
            startTime ?? new Date(data.occurredAt), productivity, durationSeconds ?? 0,
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
