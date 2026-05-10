import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
    interface FastifyRequest {
        orgId: string;
        actorId: string;
    }
}

export function registerTenantMiddleware(app: FastifyInstance) {
    app.decorateRequest('orgId', '');
    app.decorateRequest('actorId', '');

    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        const user = req.user as { org_id?: string; sub?: string } | undefined;
        if (user?.org_id) {
            req.orgId = user.org_id;
            req.actorId = user.sub ?? '';
        }
    });
}
