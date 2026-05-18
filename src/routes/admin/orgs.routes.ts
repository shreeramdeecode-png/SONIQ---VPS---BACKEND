import type { FastifyInstance } from 'fastify';
import type { OrgManagementService } from '../../superAdmin/orgManagement.service.js';
import type { AgentSyncService } from '../../superAdmin/agentSync.service.js';

export async function adminOrgRoutes(app: FastifyInstance, svc: OrgManagementService, sync: AgentSyncService) {
    const auth = app.authenticate('admin');

    app.get('/api/admin/orgs', { preHandler: [auth] }, async (req) => {
        const { page, pageSize, search } = req.query as Record<string, string>;
        return svc.listOrgs(Number(page ?? 1), Number(pageSize ?? 20), search);
    });

    app.get('/api/admin/orgs/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getOrg(id);
    });

    app.post('/api/admin/orgs', { preHandler: [auth] }, async (req, reply) => {
        const result = await svc.createOrg(req.user['sub'] as string, req.body as any);
        return reply.status(201).send(result);
    });

    app.put('/api/admin/orgs/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateOrg(req.user['sub'] as string, id, req.body as any);
    });

    app.post('/api/admin/orgs/:id/suspend', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.suspendOrg(req.user['sub'] as string, id);
        return reply.status(204).send();
    });

    app.post('/api/admin/orgs/:id/reactivate', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.reactivateOrg(req.user['sub'] as string, id);
        return reply.status(204).send();
    });

    app.delete('/api/admin/orgs/:id', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.deleteOrg(req.user['sub'] as string, id);
        return reply.status(204).send();
    });

    app.get('/api/admin/orgs/:id/employees', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        const { page, pageSize } = req.query as Record<string, string>;
        return svc.getOrgEmployees(id, Number(page ?? 1), Number(pageSize ?? 20));
    });

    app.get('/api/admin/orgs/:id/teams', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getOrgTeams(id);
    });

    app.get('/api/admin/orgs/:id/settings', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getOrgSettings(id);
    });

    app.put('/api/admin/orgs/:id/settings', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateOrgSettings(req.user['sub'] as string, id, req.body as any);
    });

    app.get('/api/admin/orgs/:id/billing', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getBilling(id);
    });

    app.put('/api/admin/orgs/:id/billing', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateBilling(req.user['sub'] as string, id, req.body as any);
    });

    app.get('/api/admin/orgs/:id/audit-logs', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        const { page, pageSize } = req.query as Record<string, string>;
        return svc.getAuditLogs(id, Number(page ?? 1), Number(pageSize ?? 50));
    });

    app.post('/api/admin/orgs/:id/agent-sync', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const report = await sync.syncOrg(req.user['sub'] as string, id);
        return reply.status(200).send(report);

    app.get('/api/admin/orgs/:id/agent-mapping', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getAgentMapping(id);
    });

    app.post('/api/admin/orgs/:id/agent-mapping', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const result = await svc.upsertAgentMapping(req.user['sub'] as string, id, req.body as any);
        return reply.status(201).send(result);
    });

    app.delete('/api/admin/orgs/:id/agent-mapping', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.deleteAgentMapping(req.user['sub'] as string, id);
        return reply.status(204).send();
    });
}
