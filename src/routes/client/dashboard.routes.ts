import type { FastifyInstance } from 'fastify';
import type { ClientDashboardService } from '../../clientPortal/clientDashboard.service.js';

export async function clientDashboardRoutes(app: FastifyInstance, svc: ClientDashboardService) {
    const auth = app.authenticate('client');

    app.get('/api/client/dashboard/stats', { preHandler: [auth] }, async (req) => {
        return svc.getTodayStats(req.orgId);
    });
}
