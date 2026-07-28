import type { FastifyInstance } from 'fastify';
import type { ScreenshotService } from '../../clientPortal/screenshot.service.js';
import { scopeForRequest } from '../../utils/roleScope.js';
import { createModuleGuard } from '../../middleware/permissions.js';
import { MODULE_INDEX, LEVEL } from '../../utils/modulePerms.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDayStart(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS); }
function istDayEnd(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS + 86400000); }

export async function clientScreenshotRoutes(app: FastifyInstance, svc: ScreenshotService) {
    const auth = app.authenticate('client');
    const guard = createModuleGuard(app.prisma);
    const view = guard(MODULE_INDEX.screenshots, LEVEL.VIEW);
    const full = guard(MODULE_INDEX.screenshots, LEVEL.FULL);

    app.get('/api/client/screenshots', { preHandler: [auth, view] }, async (req) => {
        const q = req.query as Record<string, string>;
        const { empIds } = await scopeForRequest(app.prisma, req);
        return svc.listScreenshots(req.orgId, {
            employeeId: q['employeeId'],
            from: q['from'] ? istDayStart(q['from']) : undefined,
            to: q['to'] ? istDayEnd(q['to']) : undefined,
            page: Number(q['page'] ?? 1),
            pageSize: Number(q['pageSize'] ?? 30),
            productivityStatus: q['productivityStatus'],
            empIds,
        });
    });

    app.get('/api/client/screenshots/:id', { preHandler: [auth, view] }, async (req) => {
        const { id } = req.params as { id: string };
        const { empIds } = await scopeForRequest(app.prisma, req);
        return svc.getScreenshot(req.orgId, id, empIds);
    });

    app.patch('/api/client/screenshots/:id/blur', { preHandler: [auth, full] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const { blur } = req.body as { blur: boolean };
        const { empIds } = await scopeForRequest(app.prisma, req);
        await svc.toggleBlur(req.orgId, id, blur, empIds);
        return reply.status(204).send();
    });
}
