import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';

export class TeamService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
    ) {}

    async listTeams(orgId: string) {
        const teams = await this.db.team.findMany({
            where: { orgId, deletedAt: null },
            orderBy: { name: 'asc' },
            include: { _count: { select: { employees: { where: { deletedAt: null } } } } },
        });
        return teams.map(t => ({ id: t.id, name: t.name, employeeCount: t._count.employees, createdAt: t.createdAt }));
    }

    async getTeam(orgId: string, teamId: string) {
        const team = await this.db.team.findFirst({
            where: { id: teamId, orgId, deletedAt: null },
            include: {
                employees: {
                    where: { deletedAt: null },
                    include: { role: true },
                },
            },
        });
        if (!team) throw notFound('Team', teamId);

        return {
            id: team.id, name: team.name, createdAt: team.createdAt,
            employees: team.employees.map(e => ({
                id: e.id, name: e.name, email: e.email,
                designation: e.designation, department: e.department, status: e.status,
                teamId: e.teamId, teamName: team.name, roleName: e.role.name,
                isCurrentlyWorking: e.isCurrentlyWorking, lastSeenAt: e.lastSeenAt, createdAt: e.createdAt,
            })),
        };
    }

    async createTeam(orgId: string, actorId: string, name: string) {
        const team = await this.db.team.create({ data: { id: randomUUID(), orgId, name, updatedAt: new Date() } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'team.created',
            orgId, targetType: 'Team', targetId: team.id, after: name });
        return { id: team.id, name: team.name, employeeCount: 0, createdAt: team.createdAt };
    }

    async updateTeam(orgId: string, actorId: string, teamId: string, name: string) {
        const team = await this.db.team.findFirst({ where: { id: teamId, orgId, deletedAt: null } });
        if (!team) throw notFound('Team', teamId);

        const before = team.name;
        await this.db.team.update({ where: { id: teamId }, data: { name } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'team.updated',
            orgId, targetType: 'Team', targetId: teamId, before, after: name });

        const count = await this.db.employee.count({ where: { teamId, deletedAt: null } });
        return { id: teamId, name, employeeCount: count, createdAt: team.createdAt };
    }

    async deleteTeam(orgId: string, actorId: string, teamId: string) {
        const team = await this.db.team.findFirst({ where: { id: teamId, orgId, deletedAt: null } });
        if (!team) throw notFound('Team', teamId);

        await this.db.team.update({ where: { id: teamId }, data: { deletedAt: new Date() } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'team.deleted',
            orgId, targetType: 'Team', targetId: teamId, before: team.name });
    }
}

function notFound(type: string, id: string) {
    return Object.assign(new Error(`${type} ${id} not found.`), { statusCode: 404 });
}
