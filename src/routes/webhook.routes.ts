import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type PgBoss from 'pg-boss';
import type { PrismaClient } from '@prisma/client';
import type { EncryptionService } from '../infrastructure/encryption.service.js';

// Simple in-memory rate limiter: 120 req/min per IP (resets every window)
const rateMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = rateMap.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
    entry.count++;
    rateMap.set(ip, entry);
    return entry.count <= 120;
}
// Prevent the map from growing unboundedly (prune stale entries every ~5 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rateMap) { if (now > e.resetAt) rateMap.delete(ip); }
}, 5 * 60_000).unref();

interface WebhookPayload {
    event: string;
    timestamp?: number;
    data: Record<string, any> | Record<string, any>[];
}

function extractItem(data: WebhookPayload['data']): Record<string, any> {
    return Array.isArray(data) ? (data[0] ?? {}) : (data ?? {});
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
    app.post('/webhooks/trackpilots', async (req, reply) => {
        const clientIp = req.ip ?? req.headers['x-forwarded-for']?.toString() ?? 'unknown';
        if (!checkRateLimit(clientIp)) {
            return reply.status(429).send({ error: 'Too many requests' });
        }

        const rawBody: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
        const signature = (req.headers['x-webhook-signature'] as string) ?? '';
        const timestamp = (req.headers['x-webhook-timestamp'] as string) ?? '';

        app.log.info({
            webhookHeaders: req.headers,
            hasSignature: !!signature,
            hasTimestamp: !!timestamp,
            signature,
            timestamp,
        }, 'Webhook incoming headers');

        if (!signature || !timestamp) {
            app.log.warn({ signature, timestamp }, 'Webhook rejected: missing signature or timestamp');
            return reply.status(401).send({ error: 'Unauthorized' });
        }

        // Replay guard: normalize ms or seconds timestamp, reject if older than 5 min
        const ts = parseInt(timestamp, 10);
        const tsSeconds = ts > 1e12 ? ts / 1000 : ts;
        const ageDiff = Math.abs(Date.now() / 1000 - tsSeconds);
        if (isNaN(ts) || ageDiff > 300) {
            app.log.warn({ timestamp, ts, tsSeconds, ageDiff }, 'Webhook rejected: replay guard');
            return reply.status(401).send({ error: 'Unauthorized' });
        }

        const payload = req.body as WebhookPayload;

        // data can be array (app/screenshot) or object (activity) — always grab first item
        const item = extractItem(payload.data);
        const externalOrgId: string = item.organisation?.organisationId ?? '';
        const externalUserId: string | null = item.user?.userId ?? null;
        const externalTrackingId: string | null =
            item.tracking?.trackingId ?? item.screenshot?.screenshotId ?? null;

        const orgMapping = await db.agentOrgMapping.findFirst({
            where: { externalOrgId, isActive: true },
        });

        // Decrypt webhook secret before HMAC validation
        let signatureValid = false;
        if (orgMapping) {
            try {
                const decryptedSecret = encryption.decrypt(orgMapping.webhookSecretEncrypted);
                const signingPayload = `${timestamp}.${rawBody.toString('utf8')}`;
                const computed = createHmac('sha256', decryptedSecret)
                    .update(signingPayload, 'utf8')
                    .digest('hex');
                app.log.info({
                    webhookDebug: true,
                    receivedSignature: signature,
                    computedSignature: computed,
                    timestamp,
                    rawBodyLength: rawBody.length,
                    signingPayloadPreview: signingPayload.slice(0, 100),
                }, 'Webhook signature debug');
                signatureValid = validateSignature(rawBody, signature, timestamp, decryptedSecret);
            } catch {
                signatureValid = false;
            }
        } else {
            app.log.warn({ externalOrgId }, 'No agent mapping found for externalOrgId');
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

        const occurredAt = payload.timestamp
            ? new Date(payload.timestamp).toISOString()
            : new Date().toISOString();

        const jobData: WebhookJobData = {
            webhookLogId: log.id,
            eventType: payload.event,
            externalOrgId,
            externalUserId,
            externalTrackingId,
            rawJson: rawBody.toString('utf8'),
            occurredAt,
        };

        switch (payload.event) {
            case 'desktop.activity_tracking.captured':
                await boss.send('activity-tracking', jobData, { retryLimit: 2, retryDelay: 30 });
                break;
            case 'desktop.app_tracking.captured':
                await boss.send('app-tracking', jobData, { retryLimit: 2, retryDelay: 30 });
                break;
            case 'desktop.screenshot_tracking.captured':
                // More retries for screenshots — image download can be transiently slow
                await boss.send('screenshot-processing', jobData, {
                    retryLimit: 3,
                    retryDelay: 60,
                    retryBackoff: true,
                    expireInSeconds: 300,
                });
                break;
            default:
                app.log.warn(`Unknown webhook event type: ${payload.event}`);
        }

        return reply.status(200).send();
    });
}
