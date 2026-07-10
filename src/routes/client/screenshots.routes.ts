import type { FastifyInstance } from 'fastify';
import type { ScreenshotService } from '../../clientPortal/screenshot.service.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDayStart(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS); }
function istDayEnd(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS + 86400000); }

export async function clientScreenshotRoutes(app: FastifyInstance, svc: ScreenshotService) {
    const auth = app.authenticate('client');

    app.get('/api/client/screenshots', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.listScreenshots(req.orgId, {
            employeeId: q['employeeId'],
            from: q['from'] ? istDayStart(q['from']) : undefined,
            to: q['to'] ? istDayEnd(q['to']) : undefined,
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
