import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AgentSyncService } from '../../superAdmin/agentSync.service.js';
import type { EncryptionService } from '../../infrastructure/encryption.service.js';

export async function clientIntegrationRoutes(
    app: FastifyInstance,
    db: PrismaClient,
    agentSync: AgentSyncService,
    encryption: EncryptionService,
) {
    const auth = app.authenticate('client');

    // GET /api/client/settings/trackpilots — returns connection status; never exposes keys
    app.get('/api/client/settings/trackpilots', { preHandler: [auth] }, async (req) => {
        const mapping = await db.agentOrgMapping.findFirst({
            where: { orgId: req.orgId, isActive: true },
            select: { id: true, externalOrgId: true, createdAt: true, updatedAt: true },
        });
        return {
            connected: !!mapping,
            externalOrgId: mapping?.externalOrgId ?? null,
            lastUpdated: mapping?.updatedAt ?? null,
        };
    });

    // POST /api/client/settings/trackpilots — upsert credentials (encrypt before storing)
    app.post('/api/client/settings/trackpilots', { preHandler: [auth] }, async (req, reply) => {
        const body = req.body as { externalOrgId?: string; apiKey?: string; webhookSecret?: string };
        if (!body.externalOrgId || !body.apiKey) {
            return reply.status(400).send({ error: 'externalOrgId and apiKey are required' });
        }

        const apiKeyEncrypted = encryption.encrypt(body.apiKey);
        // webhookSecret is optional — only needed if receiving inbound webhooks from Trackpilots
        const webhookSecretEncrypted = body.webhookSecret
            ? encryption.encrypt(body.webhookSecret)
            : encryption.encrypt(crypto.randomUUID());

        const existing = await db.agentOrgMapping.findFirst({
            where: { orgId: req.orgId, agentProvider: 'trackpilots' },
        });
        if (existing) {
            await db.agentOrgMapping.update({
                where: { id: existing.id },
                data: { externalOrgId: body.externalOrgId, apiKeyEncrypted, webhookSecretEncrypted, isActive: true },
            });
        } else {
            await db.agentOrgMapping.create({
                data: {
                    id: crypto.randomUUID(),
                    orgId: req.orgId!,
                    agentProvider: 'trackpilots',
                    externalOrgId: body.externalOrgId,
                    apiKeyEncrypted,
                    webhookSecretEncrypted,
                    isActive: true,
                    updatedAt: new Date(),
                },
            });
        }

        return { ok: true };
    });

    // POST /api/client/settings/trackpilots/sync — pull from Trackpilots and create/map employees
    app.post('/api/client/settings/trackpilots/sync', { preHandler: [auth] }, async (req) => {
        const report = await agentSync.syncOrg(req.actorId!, req.orgId!);
        return { ok: true, ...report };
    });
}
