import type { FastifyInstance } from 'fastify';
import type { TeamService } from '../../clientPortal/team.service.js';
import { createModuleGuard } from '../../middleware/permissions.js';
import { MODULE_INDEX, LEVEL } from '../../utils/modulePerms.js';

export async function clientTeamRoutes(app: FastifyInstance, svc: TeamService) {
    const auth = app.authenticate('client');
    const guard = createModuleGuard(app.prisma);
    const view = guard(MODULE_INDEX.teams, LEVEL.VIEW);
    const full = guard(MODULE_INDEX.teams, LEVEL.FULL);

    // List is a cross-page helper (team dropdowns on Dashboard/Attendance), so it's
    // not module-gated — only scoped by role. Detail/calendar/writes are gated below.
    app.get('/api/client/teams', { preHandler: [auth] }, async (req) => {
        const teams = await svc.listTeams(req.orgId);
        // Scoped roles only see their own team; org scope (Admin) sees all.
        if (req.scope === 'org') return teams;
        return teams.filter(t => t.id === req.teamId);
    });

    app.get('/api/client/teams/:id', { preHandler: [auth, view] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        // Self scope has no team-member view; team scope only its own team.
        if (req.scope === 'self') return reply.status(403).send({ error: 'Forbidden' });
        if (req.scope === 'team' && id !== req.teamId) return reply.status(403).send({ error: 'Forbidden' });
        return svc.getTeam(req.orgId, id);
    });

    app.get('/api/client/teams/:id/calendar', { preHandler: [auth, view] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        if (req.scope === 'self') return reply.status(403).send({ error: 'Forbidden' });
        if (req.scope === 'team' && id !== req.teamId) return reply.status(403).send({ error: 'Forbidden' });
        const q = req.query as Record<string, string>;
        const now = new Date();
        const year = Number(q['year'] ?? now.getUTCFullYear());
        const month = Number(q['month'] ?? now.getUTCMonth() + 1);
        return svc.getTeamCalendar(req.orgId, id, year, month);
    });

    // Team management needs Full access to the Teams module.
    app.post('/api/client/teams', { preHandler: [auth, full] }, async (req, reply) => {
        const { name } = req.body as { name: string };
        const result = await svc.createTeam(req.orgId, req.actorId, name);
        return reply.status(201).send(result);
    });

    app.put('/api/client/teams/:id', { preHandler: [auth, full] }, async (req) => {
        const { id } = req.params as { id: string };
        const { name } = req.body as { name: string };
        return svc.updateTeam(req.orgId, req.actorId, id, name);
    });

    app.delete('/api/client/teams/:id', { preHandler: [auth, full] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await svc.deleteTeam(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });
}
