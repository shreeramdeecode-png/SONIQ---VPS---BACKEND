import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type { WebhookJobData } from '../../routes/webhook.routes.js';
import { broadcastEmployeeActive } from '../../hubs/liveStatus.hub.js';

export class ActivityEventJob {
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

        // Idempotency — skip if already processed
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
        const activity = item?.activity ?? {};

        const workMode = activity.workMode ?? null;
        const os = item?.operatingSystem ?? null;
        const agentVersion = item?.agentVersion ?? null;
        const durationSeconds = activity.durationInSeconds ?? null;
        const startTime = activity.startDate ? new Date(activity.startDate) : null;
        const endTime = activity.endDate ? new Date(activity.endDate) : null;
        const trackingMode = activity.trackingMode ?? null;

        await this.db.activityEvent.create({
            data: {
                id: crypto.randomUUID(),
                orgId: mapping.orgId,
                teamId: mapping.employee.teamId,
                employeeId: mapping.employeeId,
                eventType: 'Activity',
                workMode,
                durationSeconds,
                startTime,
                endTime,
                trackingMode,
                operatingSystem: os,
                externalTrackingId: data.externalTrackingId,
                rawPayload: payload,
                receivedAt: new Date(data.occurredAt),
            },
        });

        await this.db.employee.update({
            where: { id: mapping.employeeId },
            data: {
                isCurrentlyWorking: true,
                lastSeenAt: new Date(data.occurredAt),
                ...(os ? { operatingSystem: os } : {}),
                ...(agentVersion ? { agentVersion } : {}),
                updatedAt: new Date(),
            },
        });

        await markLog(this.db, data.webhookLogId, 'Processed');

        broadcastEmployeeActive(this.io, mapping.orgId, {
            employeeId: mapping.employeeId,
            status: 'active',
            timestamp: data.occurredAt,
        });
    }
}

async function markLog(db: PrismaClient, logId: string, status: 'Processed' | 'Failed') {
    await db.webhookLog.update({
        where: { id: logId },
        data: { processingStatus: status, processedAt: new Date() },
    });
}
