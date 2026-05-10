import type { FastifyInstance } from 'fastify';
import type { OrgSettingsService } from '../../clientPortal/orgSettings.service.js';
import type { RoleService } from '../../clientPortal/role.service.js';

export async function clientOrgSettingsRoutes(app: FastifyInstance, settings: OrgSettingsService, roles: RoleService) {
    const auth = app.authenticate('client');

    app.get('/api/client/settings', { preHandler: [auth] }, async (req) => settings.getSettings(req.orgId));

    app.put('/api/client/settings', { preHandler: [auth] }, async (req) => {
        return settings.updateSettings(req.orgId, req.actorId, req.body as any);
    });

    app.get('/api/client/settings/overrides', { preHandler: [auth] }, async (req) => settings.listOverrides(req.orgId));

    app.post('/api/client/settings/overrides', { preHandler: [auth] }, async (req, reply) => {
        const result = await settings.createOverride(req.orgId, req.actorId, req.body as any);
        return reply.status(201).send(result);
    });

    app.delete('/api/client/settings/overrides/:id', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await settings.deleteOverride(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });

    // Roles
    app.get('/api/client/roles', { preHandler: [auth] }, async (req) => roles.listRoles(req.orgId));

    app.post('/api/client/roles', { preHandler: [auth] }, async (req, reply) => {
        const result = await roles.createRole(req.orgId, req.actorId, req.body as any);
        return reply.status(201).send(result);
    });

    app.put('/api/client/roles/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return roles.updateRole(req.orgId, req.actorId, id, req.body as any);
    });

    app.delete('/api/client/roles/:id', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await roles.deleteRole(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });
}
