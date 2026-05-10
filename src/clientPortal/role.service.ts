import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';

export class RoleService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
    ) {}

    async listRoles(orgId: string) {
        return this.db.role.findMany({
            where: { orgId },
            orderBy: { name: 'asc' },
        });
    }

    async createRole(orgId: string, actorId: string, req: { name: string; permissions?: unknown }) {
        const role = await this.db.role.create({
            data: {
                id: randomUUID(), orgId, name: req.name,
                permissions: (req.permissions ?? []) as Prisma.InputJsonValue,
                updatedAt: new Date(),
            },
        });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'role.created',
            orgId, targetType: 'Role', targetId: role.id, after: role.name });
        return role;
    }

    async updateRole(orgId: string, actorId: string, roleId: string, req: { name?: string; permissions?: unknown }) {
        const role = await this.db.role.findFirst({ where: { id: roleId, orgId } });
        if (!role) throw notFound('Role', roleId);
        if (role.isSystemDefault) throw Object.assign(new Error('Cannot modify system default roles.'), { statusCode: 400 });

        const before = role.name;
        const updated = await this.db.role.update({
            where: { id: roleId },
            data: {
                ...(req.name ? { name: req.name } : {}),
                ...(req.permissions ? { permissions: req.permissions as Prisma.InputJsonValue } : {}),
                updatedAt: new Date(),
            },
        });

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'role.updated',
            orgId, targetType: 'Role', targetId: roleId, before, after: updated.name });
        return updated;
    }

    async deleteRole(orgId: string, actorId: string, roleId: string) {
        const role = await this.db.role.findFirst({ where: { id: roleId, orgId } });
        if (!role) throw notFound('Role', roleId);
        if (role.isSystemDefault) throw Object.assign(new Error('Cannot delete system default roles.'), { statusCode: 400 });

        const inUse = await this.db.employee.count({ where: { roleId, deletedAt: null } });
        if (inUse > 0) throw Object.assign(
            new Error('Role is assigned to active employees and cannot be deleted.'), { statusCode: 409 });

        await this.db.role.delete({ where: { id: roleId } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'role.deleted',
            orgId, targetType: 'Role', targetId: roleId, before: role.name });
    }
}

function notFound(type: string, id: string) {
    return Object.assign(new Error(`${type} ${id} not found.`), { statusCode: 404 });
}
