import type { FastifyInstance } from 'fastify';
import type { TeamService } from '../../clientPortal/team.service.js';

export async function clientTeamRoutes(app: FastifyInstance, svc: TeamService) {
    const auth = app.authenticate('client');

    app.get('/api/client/teams', { preHandler: [auth] }, async (req) => {
        const teams = await svc.listTeams(req.orgId);
        // Scoped roles only see their own team; Admin (org) sees all.
        if (req.scope === 'org') return teams;
        return teams.filter(t => t.id === req.teamId);
    });

    app.get('/api/client/teams/:id', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        // Employee (self) has no team-member view; Manager only their own team.
        if (req.scope === 'self') return reply.status(403).send({ error: 'Forbidden' });
        if (req.scope === 'team' && id !== req.teamId) return reply.status(403).send({ error: 'Forbidden' });
        return svc.getTeam(req.orgId, id);
    });

    app.get('/api/client/teams/:id/calendar', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        if (req.scope === 'self') return reply.status(403).send({ error: 'Forbidden' });
        if (req.scope === 'team' && id !== req.teamId) return reply.status(403).send({ error: 'Forbidden' });
        const q = req.query as Record<string, string>;
        const now = new Date();
        const year = Number(q['year'] ?? now.getUTCFullYear());
        const month = Number(q['month'] ?? now.getUTCMonth() + 1);
        return svc.getTeamCalendar(req.orgId, id, year, month);
    });

    // Team management is Admin-only (org scope).
    app.post('/api/client/teams', { preHandler: [auth] }, async (req, reply) => {
        if (req.scope !== 'org') return reply.status(403).send({ error: 'Forbidden' });
        const { name } = req.body as { name: string };
        const result = await svc.createTeam(req.orgId, req.actorId, name);
        return reply.status(201).send(result);
    });

    app.put('/api/client/teams/:id', { preHandler: [auth] }, async (req, reply) => {
        if (req.scope !== 'org') return reply.status(403).send({ error: 'Forbidden' });
        const { id } = req.params as { id: string };
        const { name } = req.body as { name: string };
        return svc.updateTeam(req.orgId, req.actorId, id, name);
    });

    app.delete('/api/client/teams/:id', { preHandler: [auth] }, async (req, reply) => {
        if (req.scope !== 'org') return reply.status(403).send({ error: 'Forbidden' });
        const { id } = req.params as { id: string };
        await svc.deleteTeam(req.orgId, req.actorId, id);
        return reply.status(204).send();
    });
}
