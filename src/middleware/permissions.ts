import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest, FastifyReply } from 'fastify';

export type PermissionGuard = (permission: string) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function createPermissionGuard(db: PrismaClient): PermissionGuard {
    return (permission: string) => async (req: FastifyRequest, reply: FastifyReply) => {
        const roleName = (req.user as { role?: string })?.role;
        const orgId = req.orgId;
        if (!roleName || !orgId) return reply.status(403).send({ error: 'Forbidden' });

        const role = await db.role.findFirst({ where: { orgId, name: roleName } });
        const permissions = Array.isArray(role?.permissions) ? role.permissions as string[] : [];
        if (!permissions.includes(permission)) {
            return reply.status(403).send({ error: 'Forbidden' });
        }
    };
}
