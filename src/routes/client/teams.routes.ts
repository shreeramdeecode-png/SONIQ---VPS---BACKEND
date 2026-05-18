import type { FastifyInstance } from 'fastify';
import type { TeamService } from '../../clientPortal/team.service.js';

export async function clientTeamRoutes(app: FastifyInstance, svc: TeamService) {
    const auth = app.authenticate('client');

    app.get('/api/client/teams', { preHandler: [auth] }, async (req) => svc.listTeams(req.orgId));

    app.get('/api/client/teams/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getTeam(req.orgId, id);
    });

    app.get('/api/client/teams/:id/calendar', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        const q = req.query as Record<string, string>;
        const now = new Date();
        const year = Number(q['year'] ?? now.getUTCFullYear());
        const month = Number(q['month'] ?? now.getUTCMonth() + 1);
        return svc.getTeamCalendar(req.orgId, id, year, month);
    });

    app.post('/api/client/teams', { preHandler: [auth] }, async (req, reply) => {
        const { name } = req.body as { name: string };
        const result = await svc.createTeam(req.orgId, req.actorId, name);
        return reply.status(201).send(result);
    });

    app.put('/api/client/teams/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        const { name } = req.body as { name: string };
        return svc.updateTeam(req.orgId, req.actorId, id, name);
    });

    app.delete('/api/client/teams/:id', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.deleteTeam(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });
}
