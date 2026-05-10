import type { FastifyInstance } from 'fastify';
import type { EmployeeService } from '../../clientPortal/employee.service.js';

export async function clientEmployeeRoutes(app: FastifyInstance, svc: EmployeeService) {
    const auth = app.authenticate('client');

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

    app.post('/api/client/employees/invite', { preHandler: [auth] }, async (req, reply) => {
        const result = await svc.inviteEmployee(req.orgId, req.actorId, req.body as any);
        return reply.status(201).send(result);
    });

    app.put('/api/client/employees/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateEmployee(req.orgId, req.actorId, id, req.body as any);
    });

    app.post('/api/client/employees/:id/deactivate', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.deactivateEmployee(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });

    app.get('/api/client/employees/:id/settings', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getSettings(req.orgId, id);
    });

    app.put('/api/client/employees/:id/settings', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.updateSettings(req.orgId, req.actorId, id, req.body as any);
    });
}
