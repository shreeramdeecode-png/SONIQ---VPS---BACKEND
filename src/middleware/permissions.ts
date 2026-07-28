import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest, FastifyReply } from 'fastify';
import NodeCache from 'node-cache';
import { moduleLevel } from '../utils/modulePerms.js';

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

// ── Per-module access guard (Permissions & Access grid) ──────────────────────
// Enforces a role's stored level for a module. minLevel 1 = needs View, 2 = needs Full.
// System-default roles (Admin) always pass. Role lookups are cached ~30s, so a
// permission change in the UI takes effect within about half a minute.
// Pass a single module index, or an array — the guard allows the request if ANY of
// the listed modules meets the level (for endpoints shared by more than one page,
// e.g. the hourly heatmap used by both Dashboard and Reports).
export type ModuleGuard = (modules: number | number[], minLevel: number) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const roleCache = new NodeCache({ stdTTL: 30, useClones: false });

export function createModuleGuard(db: PrismaClient): ModuleGuard {
    async function loadRole(orgId: string, roleName: string) {
        const key = `${orgId}:${roleName}`;
        const cached = roleCache.get<{ permissions: unknown; isSystemDefault: boolean } | null>(key);
        if (cached !== undefined) return cached;
        const role = await db.role.findFirst({
            where: { orgId, name: roleName },
            select: { permissions: true, isSystemDefault: true },
        });
        roleCache.set(key, role ?? null);
        return role ?? null;
    }
    return (modules: number | number[], minLevel: number) => async (req: FastifyRequest, reply: FastifyReply) => {
        const roleName = (req.user as { role?: string })?.role;
        const orgId = req.orgId;
        if (!roleName || !orgId) return reply.status(403).send({ error: 'Forbidden' });
        const role = await loadRole(orgId, roleName);
        if (!role) return reply.status(403).send({ error: 'Forbidden' });
        if (role.isSystemDefault) return; // Admin / system roles = full access
        const idxs = Array.isArray(modules) ? modules : [modules];
        if (!idxs.some(i => moduleLevel(role.permissions, i) >= minLevel)) {
            return reply.status(403).send({ error: 'Forbidden' });
        }
    };
}

// Clear cached role permissions (call after a role's permissions are updated so the
// change is enforced immediately rather than after the TTL).
export function invalidateRoleCache() {
    roleCache.flushAll();
}
