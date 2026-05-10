import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type PgBoss from 'pg-boss';
import type { PrismaClient } from '@prisma/client';
import type { EncryptionService } from '../infrastructure/encryption.service.js';

interface WebhookPayload {
    event: string;
    organisationId: string;
    userId?: string;
    teamId?: string;
    trackingId?: string;
    timestamp?: string;
    data: unknown;
}

export interface WebhookJobData {
    webhookLogId: string;
    eventType: string;
    externalOrgId: string;
    externalUserId: string | null;
    externalTrackingId: string | null;
    rawJson: string;
    occurredAt: string;
}

function validateSignature(
    rawBody: Buffer,
    signature: string,
    timestamp: string,
    decryptedSecret: string,
): boolean {
    const payload = `${timestamp}.${rawBody.toString('utf8')}`;
    const computed = createHmac('sha256', decryptedSecret)
        .update(payload, 'utf8')
        .digest('hex');
    try {
        return timingSafeEqual(
            Buffer.from(computed.toLowerCase(), 'utf8'),
            Buffer.from(signature.toLowerCase(), 'utf8'),
        );
    } catch {
        return false; // timingSafeEqual throws when lengths differ
    }
}

export async function webhookRoutes(
    app: FastifyInstance,
    db: PrismaClient,
    boss: PgBoss,
    encryption: EncryptionService,
) {
    app.post('/api/webhooks/ingest', async (req, reply) => {
        const rawBody: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
        const signature = (req.headers['x-webhook-signature'] as string) ?? '';
        const timestamp = (req.headers['x-webhook-timestamp'] as string) ?? '';

        if (!signature || !timestamp) return reply.status(401).send({ error: 'Unauthorized' });

        // Replay guard: reject events older than 5 minutes
        const ts = parseInt(timestamp, 10);
        if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }

        const payload = req.body as WebhookPayload;

        const orgMapping = await db.agentOrgMapping.findFirst({
            where: { externalOrgId: payload.organisationId, isActive: true },
        });

        // Decrypt webhook secret before HMAC validation
        let signatureValid = false;
        if (orgMapping) {
            try {
                const decryptedSecret = encryption.decrypt(orgMapping.webhookSecretEncrypted);
                signatureValid = validateSignature(rawBody, signature, timestamp, decryptedSecret);
            } catch {
                signatureValid = false;
            }
        }

        const log = await db.webhookLog.create({
            data: {
                id: crypto.randomUUID(),
                agentProvider: 'trackpilots',
                orgId: orgMapping?.orgId,
                eventType: payload.event,
                signatureValid,
                processingStatus: signatureValid ? 'Queued' : 'Failed',
                payloadSizeBytes: rawBody.length,
                receivedAt: new Date(),
                errorMessage: signatureValid ? null : 'Invalid signature',
            },
        });

        if (!signatureValid || !orgMapping) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }

        const jobData: WebhookJobData = {
            webhookLogId: log.id,
            eventType: payload.event,
            externalOrgId: payload.organisationId,
            externalUserId: payload.userId ?? null,
            externalTrackingId: payload.trackingId ?? null,
            rawJson: rawBody.toString('utf8'),
            occurredAt: payload.timestamp ?? new Date().toISOString(),
        };

        switch (payload.event) {
            case 'desktop.activity_tracking.captured':
                await boss.send('activity-tracking', jobData);
                break;
            case 'desktop.app_tracking.captured':
                await boss.send('app-tracking', jobData);
                break;
            case 'desktop.screenshot_tracking.captured':
                await boss.send('screenshot-processing', jobData);
                break;
            default:
                app.log.warn(`Unknown webhook event type: ${payload.event}`);
        }

        return reply.status(200).send();
    });
}
