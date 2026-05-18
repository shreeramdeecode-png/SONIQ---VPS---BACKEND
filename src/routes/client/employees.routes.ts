import type { FastifyInstance } from 'fastify';
import type { EmployeeService } from '../../clientPortal/employee.service.js';
import type { PermissionGuard } from '../../middleware/permissions.js';

export async function clientEmployeeRoutes(app: FastifyInstance, svc: EmployeeService, perm: PermissionGuard) {
    const auth = app.authenticate('client');
    const manageEmployees = perm('manage_employees');
    const manageSettings = perm('manage_settings');

    app.get('/api/client/employees', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.listEmployees(req.orgId, {
            teamId: q['teamId'], search: q['search'],
            page: Number(q['page'] ?? 1), pageSize: Number(q['pageSize'] ?? 20),
        });
    });

    app.get('/api/client/employees/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getEmployee(req.orgId, id);
    });

    app.post('/api/client/employees/invite', { preHandler: [auth, manageEmployees] }, async (req, reply) => {
        const result = await svc.inviteEmployee(req.orgId, req.actorId, req.body as any);
        return reply.status(201).send(result);
    });

    app.put('/api/client/employees/:id', { preHandler: [auth, manageEmployees] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateEmployee(req.orgId, req.actorId, id, req.body as any);
    });

    app.post('/api/client/employees/:id/deactivate', { preHandler: [auth, manageEmployees] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.deactivateEmployee(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });

    // ── Bundled settings (legacy, keep for backwards compat) ─────────────────
    app.get('/api/client/employees/:id/settings', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getSettings(req.orgId, id);
    });

    app.put('/api/client/employees/:id/settings', { preHandler: [auth, manageSettings] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateSettings(req.orgId, req.actorId, id, req.body as any);
    });

    // ── Dedicated per-setting routes ──────────────────────────────────────────
    app.get('/api/client/employees/:id/settings/work-days', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getWorkDaySettings(req.orgId, id);
    });

    app.put('/api/client/employees/:id/settings/work-days', { preHandler: [auth, manageSettings] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateWorkDaySettings(req.orgId, req.actorId, id, req.body as any);
    });

    app.get('/api/client/employees/:id/settings/work-hours', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getWorkHourSettings(req.orgId, id);
    });

    app.put('/api/client/employees/:id/settings/work-hours', { preHandler: [auth, manageSettings] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateWorkHourSettings(req.orgId, req.actorId, id, req.body as any);
    });

    app.get('/api/client/employees/:id/settings/screenshot', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getScreenshotSettings(req.orgId, id);
    });

    app.put('/api/client/employees/:id/settings/screenshot', { preHandler: [auth, manageSettings] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateScreenshotSettings(req.orgId, req.actorId, id, req.body as any);
    });

    app.get('/api/client/employees/:id/settings/idle-alert', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getIdleAlertSettings(req.orgId, id);
    });

    app.put('/api/client/employees/:id/settings/idle-alert', { preHandler: [auth, manageSettings] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateIdleAlertSettings(req.orgId, req.actorId, id, req.body as any);
    });

    app.get('/api/client/employees/:id/settings/stealth', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getStealthSettings(req.orgId, id);
    });

    app.put('/api/client/employees/:id/settings/stealth', { preHandler: [auth, manageSettings] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateStealthSettings(req.orgId, req.actorId, id, req.body as any);
    });
}
