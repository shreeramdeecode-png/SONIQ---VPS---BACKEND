import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveScope, type Scope } from '../utils/roleScope.js';

declare module 'fastify' {
    interface FastifyRequest {
        orgId: string;
        actorId: string;
        scope: Scope;
        teamId: string | null;
    }
}

export function registerTenantMiddleware(app: FastifyInstance) {
    app.decorateRequest('orgId', '');
    app.decorateRequest('actorId', '');
    app.decorateRequest('scope', 'self');
    app.decorateRequest('teamId', null);

    app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
        const user = req.user as
            | { org_id?: string; sub?: string; role?: string; scope?: Scope; team_id?: string | null }
            | undefined;
        if (user?.org_id) {
            req.orgId = user.org_id;
            req.actorId = user.sub ?? '';
            // Prefer the scope baked into the token; fall back to deriving it from
            // the role name so older tokens (issued before scope existed) still work.
            req.scope = user.scope ?? resolveScope(user.role);
            req.teamId = user.team_id ?? null;
        }
    });
}
