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

        const productivity = await this.resolveProductivity(
            mapping.orgId, appName, appDomain, payloadStatus,
        );

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

        await this.db.employee.update({
            where: { id: mapping.employeeId },
            data: {
                lastSeenAt: new Date(data.occurredAt),
                ...(os ? { operatingSystem: os } : {}),
                updatedAt: new Date(),
            },
        });

        await this.upsertDailySummary(
            mapping.orgId, mapping.employeeId,
            new Date(data.occurredAt), productivity, durationSeconds ?? 0,
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
            // 1. Org-level override
            const orgOverrides = await this.db.orgProductivityOverride.findMany({ where: { orgId } });
            const orgMatch = orgOverrides.find(o =>
                matchPattern(o.appNamePattern, appName) &&
                (!o.appDomainPattern || !appDomain || matchPattern(o.appDomainPattern, appDomain)),
            );
            if (orgMatch) return orgMatch.overriddenStatus;

            // 2. Global classification
            const globals = await this.db.globalProductivityClassification.findMany();
            const globalMatch = globals.find(g =>
                matchPattern(g.appNamePattern, appName) &&
                (!g.appDomainPattern || !appDomain || matchPattern(g.appDomainPattern, appDomain)),
            );
            if (globalMatch) return globalMatch.defaultStatus;
        }

        // 3. Payload status → 4. Default Neutral
        return normaliseStatus(payloadStatus) ?? 'Neutral';
    }

    private async upsertDailySummary(
        orgId: string, employeeId: string, date: Date,
        status: string, durationSeconds: number,
    ): Promise<void> {
        const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

        const existing = await this.db.dailySummary.findFirst({
            where: { orgId, employeeId, summaryDate: dayStart },
        });

        const productive = status === 'Productive' ? durationSeconds : 0;
        const unproductive = status === 'Unproductive' ? durationSeconds : 0;
        const neutral = status === 'Neutral' ? durationSeconds : 0;

        if (existing) {
            const newProductive = existing.productiveSeconds + productive;
            const newUnproductive = existing.unproductiveSeconds + unproductive;
            const newNeutral = existing.neutralSeconds + neutral;
            const total = newProductive + newUnproductive + newNeutral;
            const score = total > 0
                ? Math.round((newProductive / total) * 100 * 100) / 100
                : null;

            await this.db.dailySummary.update({
                where: { id: existing.id },
                data: {
                    productiveSeconds: newProductive,
                    unproductiveSeconds: newUnproductive,
                    neutralSeconds: newNeutral,
                    productivityScore: score,
                    isPresent: true,
                    updatedAt: new Date(),
                },
            });
        } else {
            const total = productive + unproductive + neutral;
            const score = total > 0 ? Math.round((productive / total) * 100 * 100) / 100 : null;

            await this.db.dailySummary.create({
                data: {
                    id: crypto.randomUUID(),
                    orgId, employeeId,
                    summaryDate: dayStart,
                    productiveSeconds: productive,
                    unproductiveSeconds: unproductive,
                    neutralSeconds: neutral,
                    productivityScore: score,
                    isPresent: true,
                    updatedAt: new Date(),
                },
            });
        }
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
