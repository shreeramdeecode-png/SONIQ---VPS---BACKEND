import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type { WebhookJobData } from '../../routes/webhook.routes.js';
import { broadcastEmployeeActive } from '../../hubs/liveStatus.hub.js';
// System states Trackpilots emits as App events — never counted as real productive/neutral work.
import { isSystemApp as isSystemAppName } from '../../utils/systemApps.js';

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

        const payload = JSON.parse(data.rawJson);
        // Trackpilots BATCHES multiple activity events into one webhook's `data` array
        // (up to ~12 per webhook). We must process EVERY item — reading only data[0] dropped
        // ~2/3 of all activity. Each item gets a unique externalTrackingId (base::index).
        const items: any[] = Array.isArray(payload.data) ? payload.data : (payload.data ? [payload.data] : []);
        const baseId = data.externalTrackingId ?? data.webhookLogId;

        // Idempotency — if the first item of this batch is already stored, the batch was processed
        const already = await this.db.activityEvent.findFirst({ where: { externalTrackingId: `${baseId}::0` } });
        if (already) {
            await markLog(this.db, data.webhookLogId, 'Processed');
            return;
        }

        let latestActivity: Date | null = null;
        let latestOs: string | null = null;
        let latestApp: string | null = null;
        const receivedAt = new Date(data.occurredAt);

        for (let i = 0; i < items.length; i++) {
            const tracking = items[i]?.tracking ?? {};
            const app = tracking.app ?? {};
            const time = tracking.time ?? {};

            const appName: string | null = app.name ?? null;
            const appTypeRaw: string | null = app.type ?? null;
            const appCategory: string | null = app.category ?? null;
            const appDomain: string | null = app.domain ?? null;
            const appFullUrl: string | null = app.fullUrl ?? null;
            const durationSeconds: number | null = time.durationInSeconds ?? null;
            // Real activity times from time.startTime/endTime (fallback startDate/endDate).
            const startRaw = time.startTime ?? time.startDate;
            const endRaw = time.endTime ?? time.endDate;
            const startTime = startRaw ? new Date(startRaw) : null;
            const endTime = endRaw ? new Date(endRaw) : null;
            const os: string | null = tracking.operatingSystem ?? null;
            const payloadStatus: string | null = app.productivityStatus ?? null;
            const appType = appTypeRaw?.toLowerCase() === 'website' ? 'Website' : 'Application';

            const productivity = await this.resolveProductivity(mapping.orgId, appName, appDomain, payloadStatus);
            // Locked/Idle are system states — excluded from productive/neutral/unproductive seconds.
            const isSystemApp = isSystemAppName(appName);
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
                    externalTrackingId: `${baseId}::${i}`,
                    // Store just this item (wrapped) so per-event rawPayload.data[0] stays consistent
                    rawPayload: { ...payload, data: [items[i]] },
                    receivedAt,
                },
            });

            const bucketTime = startTime ?? receivedAt;
            await this.upsertDailySummary(
                mapping.orgId, mapping.employeeId, mapping.employee.teamId,
                bucketTime, productivity, classifiedDuration,
            );

            const activityTime = endTime ?? startTime ?? receivedAt;
            if (!latestActivity || activityTime > latestActivity) { latestActivity = activityTime; latestApp = appName; }
            if (os) latestOs = os;
        }

        // Update live status once, from the most recent event in the batch
        await this.db.employee.update({
            where: { id: mapping.employeeId },
            data: {
                isCurrentlyWorking: true,
                lastSeenAt: latestActivity ?? receivedAt,
                ...(latestOs ? { operatingSystem: latestOs } : {}),
                updatedAt: new Date(),
            },
        });

        await markLog(this.db, data.webhookLogId, 'Processed');

        broadcastEmployeeActive(this.io, mapping.orgId, {
            employeeId: mapping.employeeId,
            status: latestApp ?? 'Unknown',
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
