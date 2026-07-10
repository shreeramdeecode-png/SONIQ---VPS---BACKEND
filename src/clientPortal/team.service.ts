import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';
import type { TrackpilotsService } from '../infrastructure/agents/trackpilots.service.js';

export class TeamService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
        private readonly trackpilots?: TrackpilotsService,
    ) {}

    async listTeams(orgId: string) {
        const today = toDateOnly(new Date());

        const teams = await this.db.team.findMany({
            where: { orgId, deletedAt: null },
            orderBy: { name: 'asc' },
            include: { _count: { select: { employees: { where: { deletedAt: null, status: 'active' } } } } },
        });

        const teamIds = teams.map(t => t.id);

        const [liveEmployees, summaries] = await Promise.all([
            this.db.employee.findMany({
                where: { orgId, teamId: { in: teamIds }, deletedAt: null, status: 'active' },
                select: { teamId: true, isCurrentlyWorking: true },
            }),
            this.db.dailySummary.findMany({
                where: { orgId, summaryDate: today, teamId: { in: teamIds } },
                select: { teamId: true, productivityScore: true, isPresent: true },
            }),
        ]);

        const liveByTeam = new Map<string, { activeNow: number; offline: number }>();
        for (const e of liveEmployees) {
            if (!e.teamId) continue;
            const g = liveByTeam.get(e.teamId) ?? { activeNow: 0, offline: 0 };
            if (e.isCurrentlyWorking) g.activeNow++; else g.offline++;
            liveByTeam.set(e.teamId, g);
        }

        const scoreByTeam = new Map<string, { scored: number[]; present: number }>();
        for (const s of summaries) {
            if (!s.teamId) continue;
            const g = scoreByTeam.get(s.teamId) ?? { scored: [], present: 0 };
            if (s.productivityScore != null) g.scored.push(Number(s.productivityScore));
            if (s.isPresent) g.present++;
            scoreByTeam.set(s.teamId, g);
        }

        return teams.map(t => {
            const live = liveByTeam.get(t.id) ?? { activeNow: 0, offline: 0 };
            const score = scoreByTeam.get(t.id) ?? { scored: [], present: 0 };
            const avgScore = score.scored.length > 0
                ? Math.round((score.scored.reduce((a, b) => a + b, 0) / score.scored.length) * 100) / 100
                : null;
            return {
                id: t.id, name: t.name,
                employeeCount: t._count.employees,
                activeNow: live.activeNow,
                offline: live.offline,
                presentToday: score.present,
                avgProductivityScore: avgScore,
                createdAt: t.createdAt,
            };
        });
    }

    async getTeam(orgId: string, teamId: string) {
        const today = toDateOnly(new Date());

        const team = await this.db.team.findFirst({
            where: { id: teamId, orgId, deletedAt: null },
            include: { employees: { where: { deletedAt: null, status: 'active' }, include: { role: true } } },
        });
        if (!team) throw notFound('Team', teamId);

        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, teamId, summaryDate: today },
        }).then(rows => new Map(rows.map(r => [r.employeeId, r])));

        const scored = team.employees
            .map(e => summaries.get(e.id)?.productivityScore)
            .filter(s => s != null)
            .map(s => Number(s));
        const avgProductivityScore = scored.length > 0
            ? Math.round((scored.reduce((a, b) => a + Number(b), 0) / scored.length) * 100) / 100
            : null;

        return {
            id: team.id, name: team.name, createdAt: team.createdAt,
            avgProductivityScore,
            employees: team.employees.map(e => {
                const s = summaries.get(e.id);
                return {
                    id: e.id, name: e.name, email: e.email,
                    designation: e.designation, department: e.department, status: e.status,
                    teamId: e.teamId, teamName: team.name, roleName: e.role.name,
                    isCurrentlyWorking: e.isCurrentlyWorking, lastSeenAt: e.lastSeenAt,
                    today: {
                        isPresent: s?.isPresent ?? false,
                        firstCheckin: s?.firstCheckin ?? null,
                        lastCheckout: s?.lastCheckout ?? null,
                        productiveSeconds: s?.productiveSeconds ?? 0,
                        unproductiveSeconds: s?.unproductiveSeconds ?? 0,
                        idleSeconds: s?.idleSeconds ?? 0,
                        totalWorkSeconds: s?.totalWorkSeconds ?? 0,
                        productivityScore: s?.productivityScore ?? null,
                    },
                    createdAt: e.createdAt,
                };
            }),
        };
    }

    async getTeamCalendar(orgId: string, teamId: string, year: number, month: number) {
        const team = await this.db.team.findFirst({ where: { id: teamId, orgId, deletedAt: null } });
        if (!team) throw notFound('Team', teamId);

        const from = new Date(Date.UTC(year, month - 1, 1));
        const to = new Date(Date.UTC(year, month, 0));

        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, teamId, summaryDate: { gte: from, lte: to } },
            select: { summaryDate: true, employeeId: true, isPresent: true, productivityScore: true, productiveSeconds: true },
        });

        const byDate = new Map<string, { present: number; totalScore: number; scoreCount: number; totalProductive: number }>();
        for (const s of summaries) {
            const key = s.summaryDate.toISOString().slice(0, 10);
            const g = byDate.get(key) ?? { present: 0, totalScore: 0, scoreCount: 0, totalProductive: 0 };
            if (s.isPresent) g.present++;
            if (s.productivityScore != null) { g.totalScore += Number(s.productivityScore); g.scoreCount++; }
            g.totalProductive += s.productiveSeconds;
            byDate.set(key, g);
        }

        return Array.from(byDate.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, g]) => ({
                date,
                presentCount: g.present,
                avgProductivityScore: g.scoreCount > 0 ? Math.round((g.totalScore / g.scoreCount) * 100) / 100 : null,
                totalProductiveSeconds: g.totalProductive,
            }));
    }

    async createTeam(orgId: string, actorId: string, name: string) {
        const team = await this.db.team.create({ data: { id: randomUUID(), orgId, name, updatedAt: new Date() } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'team.created',
            orgId, targetType: 'Team', targetId: team.id, after: name });

        // Best-effort: create team in Trackpilots and store mapping
        if (this.trackpilots) {
            try {
                const tpTeam = await this.trackpilots.createTeam(orgId, name);
                await this.db.agentTeamMapping.create({
                    data: { id: randomUUID(), teamId: team.id, orgId, agentProvider: 'trackpilots', externalTeamId: tpTeam.id },
                });
            } catch { /* non-fatal */ }
        }

        return { id: team.id, name: team.name, employeeCount: 0, activeNow: 0, offline: 0, presentToday: 0, avgProductivityScore: null, createdAt: team.createdAt };
    }

    async updateTeam(orgId: string, actorId: string, teamId: string, name: string) {
        const team = await this.db.team.findFirst({ where: { id: teamId, orgId, deletedAt: null } });
        if (!team) throw notFound('Team', teamId);

        const before = team.name;
        await this.db.team.update({ where: { id: teamId }, data: { name } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'team.updated',
            orgId, targetType: 'Team', targetId: teamId, before, after: name });

        // Best-effort: rename team in Trackpilots
        if (this.trackpilots) {
            const mapping = await this.db.agentTeamMapping.findFirst({
                where: { teamId, orgId, agentProvider: 'trackpilots' },
            });
            if (mapping) {
                this.trackpilots.updateTeam(orgId, mapping.externalTeamId, name).catch(() => {});
            }
        }

        const count = await this.db.employee.count({ where: { teamId, deletedAt: null } });
        return { id: teamId, name, employeeCount: count, createdAt: team.createdAt };
    }

    async deleteTeam(orgId: string, actorId: string, teamId: string) {
        const team = await this.db.team.findFirst({ where: { id: teamId, orgId, deletedAt: null } });
        if (!team) throw notFound('Team', teamId);

        // Best-effort: delete team in Trackpilots
        if (this.trackpilots) {
            const mapping = await this.db.agentTeamMapping.findFirst({
                where: { teamId, orgId, agentProvider: 'trackpilots' },
            });
            if (mapping) {
                this.trackpilots.deleteTeam(orgId, mapping.externalTeamId).catch(() => {});
            }
        }

        await this.db.team.update({ where: { id: teamId }, data: { deletedAt: new Date() } });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'team.deleted',
            orgId, targetType: 'Team', targetId: teamId, before: team.name });
    }
}

function toDateOnly(d: Date): Date {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

function notFound(type: string, id: string) {
    return Object.assign(new Error(`${type} ${id} not found.`), { statusCode: 404 });
}
