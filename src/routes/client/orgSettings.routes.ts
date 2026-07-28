import type { FastifyInstance } from 'fastify';
import type { OrgSettingsService } from '../../clientPortal/orgSettings.service.js';
import type { RoleService } from '../../clientPortal/role.service.js';
import { createModuleGuard, invalidateRoleCache } from '../../middleware/permissions.js';
import { MODULE_INDEX, LEVEL } from '../../utils/modulePerms.js';

export async function clientOrgSettingsRoutes(app: FastifyInstance, settings: OrgSettingsService, roles: RoleService) {
    const auth = app.authenticate('client');
    const guard = createModuleGuard(app.prisma);
    const settingsView = guard(MODULE_INDEX.settings, LEVEL.VIEW);
    const settingsFull = guard(MODULE_INDEX.settings, LEVEL.FULL);
    const accessView = guard(MODULE_INDEX.access_control, LEVEL.VIEW);
    const accessFull = guard(MODULE_INDEX.access_control, LEVEL.FULL);

    app.get('/api/client/settings', { preHandler: [auth, settingsView] }, async (req) => settings.getSettings(req.orgId));

    app.put('/api/client/settings', { preHandler: [auth, settingsFull] }, async (req) => {
        return settings.updateSettings(req.orgId, req.actorId, req.body as any);
    });

    app.get('/api/client/settings/overrides', { preHandler: [auth, settingsView] }, async (req) => settings.listOverrides(req.orgId));

    app.post('/api/client/settings/overrides', { preHandler: [auth, settingsFull] }, async (req, reply) => {
        const result = await settings.createOverride(req.orgId, req.actorId, req.body as any);
        return reply.status(201).send(result);
    });

    app.delete('/api/client/settings/overrides/:id', { preHandler: [auth, settingsFull] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await settings.deleteOverride(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });

    // Roles — governed by the Access Control module.
    app.get('/api/client/roles', { preHandler: [auth, accessView] }, async (req) => roles.listRoles(req.orgId));

    app.post('/api/client/roles', { preHandler: [auth, accessFull] }, async (req, reply) => {
        const result = await roles.createRole(req.orgId, req.actorId, req.body as any);
        invalidateRoleCache();
        return reply.status(201).send(result);
    });

    app.put('/api/client/roles/:id', { preHandler: [auth, accessFull] }, async (req) => {
        const { id } = req.params as { id: string };
        const result = await roles.updateRole(req.orgId, req.actorId, id, req.body as any);
        invalidateRoleCache(); // enforce permission edits immediately
        return result;
    });

    app.delete('/api/client/roles/:id', { preHandler: [auth, accessFull] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await roles.deleteRole(req.orgId, req.actorId, id);
        invalidateRoleCache();
        return reply.status(204).send();
    });
}
