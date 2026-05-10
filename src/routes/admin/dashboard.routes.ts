import type { FastifyInstance } from 'fastify';
import type { DashboardService } from '../../superAdmin/dashboard.service.js';
import type { PlatformSettingsService } from '../../superAdmin/platformSettings.service.js';

export async function adminDashboardRoutes(app: FastifyInstance, dashboard: DashboardService, platform: PlatformSettingsService) {
    const auth = app.authenticate('admin');

    app.get('/api/admin/dashboard/stats', { preHandler: [auth] }, async () => dashboard.getStats());

    app.get('/api/admin/platform-settings/classifications', { preHandler: [auth] }, async (req) => {
        const { page, pageSize } = req.query as Record<string, string>;
        return platform.listClassifications(Number(page ?? 1), Number(pageSize ?? 50));
    });

    app.post('/api/admin/platform-settings/classifications', { preHandler: [auth] }, async (req, reply) => {
        const result = await platform.createClassification(req.user['sub'] as string, req.body as any);
        return reply.status(201).send(result);
    });

    app.put('/api/admin/platform-settings/classifications/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return platform.updateClassification(req.user['sub'] as string, id, req.body as any);
    });

    app.delete('/api/admin/platform-settings/classifications/:id', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        await platform.deleteClassification(req.user['sub'] as string, id);
        return reply.status(204).send();
    });
}
