import type { FastifyInstance } from 'fastify';
import type { ReportsService } from '../../clientPortal/reports.service.js';

export async function clientReportRoutes(app: FastifyInstance, svc: ReportsService) {
    const auth = app.authenticate('client');

    app.get('/api/client/reports/productivity-trend', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        return svc.getProductivityTrend(req.orgId, from, to, q['teamId']);
    });

    app.get('/api/client/reports/app-usage', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        return svc.getAppUsage(req.orgId, from, to, q['employeeId']);
    });
}
