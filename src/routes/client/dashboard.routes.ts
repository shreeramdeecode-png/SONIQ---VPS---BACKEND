import type { FastifyInstance } from 'fastify';
import type { ClientDashboardService } from '../../clientPortal/clientDashboard.service.js';

export async function clientDashboardRoutes(app: FastifyInstance, svc: ClientDashboardService) {
    const auth = app.authenticate('client');

    app.get('/api/client/dashboard/stats', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = q['from'] ? new Date(q['from']) : undefined;
        const to = q['to'] ? new Date(q['to']) : undefined;
        if (to) to.setUTCHours(23, 59, 59, 999);
        return svc.getTodayStats(req.orgId, from, to, q['teamId']);
    });

    app.get('/api/client/dashboard/top-productive', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = q['from'] ? new Date(q['from']) : (q['date'] ? new Date(q['date']) : new Date());
        const to = q['to'] ? new Date(q['to']) : (q['date'] ? new Date(q['date']) : new Date());
        to.setUTCHours(23, 59, 59, 999);
        return svc.getTopProductive(req.orgId, from, to, Number(q['limit'] ?? 5), q['teamId']);
    });

    app.get('/api/client/dashboard/top-unproductive', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const date = q['date'] ? new Date(q['date']) : new Date();
        return svc.getTopUnproductive(req.orgId, date, Number(q['limit'] ?? 5), q['teamId']);
    });

    app.get('/api/client/dashboard/top-apps', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        to.setUTCHours(23, 59, 59, 999); // include all events through end of the `to` day
        return svc.getTopApps(req.orgId, from, to, Number(q['limit'] ?? 10), q['teamId']);
    });

    app.get('/api/client/dashboard/activity-table', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const date = q['date'] ? new Date(q['date']) : new Date();
        return svc.getTodayActivityTable(req.orgId, date, q['teamId']);
    });

    app.get('/api/client/dashboard/work-hour-chart', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        to.setUTCHours(23, 59, 59, 999); // include all events through end of the `to` day
        return svc.getWorkHourChart(req.orgId, from, to, q['teamId']);
    });

    app.get('/api/client/dashboard/work-mode-summary', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getWorkModeSummary(req.orgId, q['teamId']);
    });

    app.get('/api/client/dashboard/recent-screenshots', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getRecentScreenshots(req.orgId, Number(q['limit'] ?? 20), q['teamId']);
    });

    app.get('/api/client/dashboard/team-comparison', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const date = q['date'] ? new Date(q['date']) : new Date();
        return svc.getTeamComparison(req.orgId, date);
    });
}
