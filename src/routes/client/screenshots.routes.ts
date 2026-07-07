import type { FastifyInstance } from 'fastify';
import type { ScreenshotService } from '../../clientPortal/screenshot.service.js';

export async function clientScreenshotRoutes(app: FastifyInstance, svc: ScreenshotService) {
    const auth = app.authenticate('client');

    app.get('/api/client/screenshots', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.listScreenshots(req.orgId, {
            employeeId: q['employeeId'],
            from: q['from'] ? new Date(q['from']) : undefined,
            to: q['to'] ? new Date(q['to'] + 'T23:59:59.999Z') : undefined,
            page: Number(q['page'] ?? 1),
            pageSize: Number(q['pageSize'] ?? 30),
            productivityStatus: q['productivityStatus'],
        });
    });

    app.get('/api/client/screenshots/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        return svc.getScreenshot(req.orgId, id);
    });

    app.patch('/api/client/screenshots/:id/blur', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const { blur } = req.body as { blur: boolean };
        await svc.toggleBlur(req.orgId, id, blur);
        return reply.status(204).send();
    });
}
