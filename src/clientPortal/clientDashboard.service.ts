import type { PrismaClient } from '@prisma/client';

export class ClientDashboardService {
    constructor(private readonly db: PrismaClient) {}

    async getTodayStats(orgId: string, teamId?: string) {
        const today = toDateOnly(new Date());
        const empWhere = { orgId, deletedAt: null, status: 'active', ...(teamId ? { teamId } : {}) };

        const [totalEmployees, activeNow, summaries] = await Promise.all([
            this.db.employee.count({ where: empWhere }),
            this.db.employee.count({ where: { ...empWhere, isCurrentlyWorking: true } }),
            this.db.dailySummary.findMany({ where: { orgId, summaryDate: today, ...(teamId ? { teamId } : {}) } }),
        ]);

        const presentToday = summaries.filter(s => s.isPresent).length;
        const scored = summaries.filter(s => s.productivityScore != null);
        const avgScore = scored.length > 0
            ? Math.round((scored.reduce((sum, s) => sum + Number(s.productivityScore!), 0) / scored.length) * 100) / 100
            : 0;
        const totalWorkSeconds = summaries.reduce((sum, s) => sum + (s.totalWorkSeconds ?? 0), 0);

        return { date: today, totalEmployees, activeNow, avgProductivityScore: avgScore, totalWorkSeconds, presentToday };
    }

    async getTopProductive(orgId: string, date: Date, limit = 5, teamId?: string) {
        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: toDateOnly(date), ...(teamId ? { teamId } : {}) },
            orderBy: { productiveSeconds: 'desc' },
            take: limit,
        });
        const empIds = summaries.map(s => s.employeeId);
        const employees = await this.db.employee.findMany({
            where: { id: { in: empIds } }, select: { id: true, name: true },
        }).then(rows => new Map(rows.map(r => [r.id, r.name])));

        return summaries.map(s => ({
            employeeId: s.employeeId,
            name: employees.get(s.employeeId) ?? 'Unknown',
            productiveSeconds: s.productiveSeconds,
            productivityScore: s.productivityScore,
        }));
    }

    async getTopUnproductive(orgId: string, date: Date, limit = 5, teamId?: string) {
        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: toDateOnly(date), ...(teamId ? { teamId } : {}) },
            orderBy: { unproductiveSeconds: 'desc' },
            take: limit,
        });
        const empIds = summaries.map(s => s.employeeId);
        const employees = await this.db.employee.findMany({
            where: { id: { in: empIds } }, select: { id: true, name: true },
        }).then(rows => new Map(rows.map(r => [r.id, r.name])));

        return summaries.map(s => ({
            employeeId: s.employeeId,
            name: employees.get(s.employeeId) ?? 'Unknown',
            unproductiveSeconds: s.unproductiveSeconds,
            productivityScore: s.productivityScore,
        }));
    }

    async getTopApps(orgId: string, from: Date, to: Date, limit = 10, teamId?: string) {
        const empWhere = teamId
            ? await this.db.employee.findMany({ where: { orgId, teamId, deletedAt: null }, select: { id: true } })
                .then(rows => rows.map(r => r.id))
            : undefined;

        const events = await this.db.activityEvent.findMany({
            where: {
                orgId,
                eventType: 'App',
                startTime: { gte: from, lte: to },
                appName: { not: null },
                ...(empWhere ? { employeeId: { in: empWhere } } : {}),
            },
            select: { appName: true, appDomain: true, appCategory: true, productivityStatus: true, durationSeconds: true },
        });

        const groups = new Map<string, { totalDuration: number; productivityStatus: string; appDomain: string | null; appCategory: string | null }>();
        for (const e of events) {
            const key = e.appName!;
            const g = groups.get(key) ?? { totalDuration: 0, productivityStatus: e.productivityStatus ?? 'Neutral', appDomain: e.appDomain, appCategory: e.appCategory };
            g.totalDuration += e.durationSeconds ?? 0;
            groups.set(key, g);
        }

        return Array.from(groups.entries())
            .map(([appName, g]) => ({ appName, appDomain: g.appDomain, appCategory: g.appCategory, productivityStatus: g.productivityStatus, totalDurationSeconds: g.totalDuration }))
            .sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds)
            .slice(0, limit);
    }

    async getTodayActivityTable(orgId: string, date: Date, teamId?: string) {
        const today = toDateOnly(date);
        const empWhere = { orgId, deletedAt: null, status: 'active', ...(teamId ? { teamId } : {}) };

        const [employees, summaries] = await Promise.all([
            this.db.employee.findMany({
                where: empWhere,
                select: { id: true, name: true, team: { select: { name: true } }, isCurrentlyWorking: true, lastSeenAt: true },
                orderBy: { name: 'asc' },
            }),
            this.db.dailySummary.findMany({ where: { orgId, summaryDate: today } })
                .then(rows => new Map(rows.map(r => [r.employeeId, r]))),
        ]);

        return employees.map(e => {
            const s = summaries.get(e.id);
            return {
                employeeId: e.id, name: e.name, teamName: e.team?.name ?? null,
                isCurrentlyWorking: e.isCurrentlyWorking, lastSeenAt: e.lastSeenAt,
                isPresent: s?.isPresent ?? false,
                firstCheckin: s?.firstCheckin ?? null,
                lastCheckout: s?.lastCheckout ?? null,
                productiveSeconds: s?.productiveSeconds ?? 0,
                unproductiveSeconds: s?.unproductiveSeconds ?? 0,
                idleSeconds: s?.idleSeconds ?? 0,
                totalWorkSeconds: s?.totalWorkSeconds ?? 0,
                productivityScore: s?.productivityScore ?? null,
                screenshotsCount: s?.screenshotsCount ?? 0,
            };
        });
    }

    async getWorkHourChart(orgId: string, from: Date, to: Date, teamId?: string) {
        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: { gte: from, lte: to }, ...(teamId ? { teamId } : {}) },
            orderBy: { summaryDate: 'asc' },
        });

        const byDate = new Map<string, { productive: number; unproductive: number; neutral: number; idle: number }>();
        for (const s of summaries) {
            const key = s.summaryDate.toISOString().slice(0, 10);
            const g = byDate.get(key) ?? { productive: 0, unproductive: 0, neutral: 0, idle: 0 };
            g.productive += s.productiveSeconds;
            g.unproductive += s.unproductiveSeconds;
            g.neutral += s.neutralSeconds;
            g.idle += s.idleSeconds;
            byDate.set(key, g);
        }

        return Array.from(byDate.entries()).map(([date, g]) => ({ date, ...g }));
    }

    async getWorkModeSummary(orgId: string, teamId?: string) {
        const where = { orgId, deletedAt: null, status: 'active', ...(teamId ? { teamId } : {}) };
        const [total, activeNow] = await Promise.all([
            this.db.employee.count({ where }),
            this.db.employee.count({ where: { ...where, isCurrentlyWorking: true } }),
        ]);
        return { total, activeNow, offline: total - activeNow };
    }

    async getRecentScreenshots(orgId: string, limit = 20, teamId?: string) {
        const empIds = teamId
            ? await this.db.employee.findMany({ where: { orgId, teamId, deletedAt: null }, select: { id: true } })
                .then(rows => rows.map(r => r.id))
            : undefined;

        const screenshots = await this.db.screenshot.findMany({
            where: { orgId, ...(empIds ? { employeeId: { in: empIds } } : {}) },
            orderBy: { capturedAt: 'desc' },
            take: limit,
            select: { id: true, employeeId: true, thumbnailUrl: true, appName: true, capturedAt: true, isBlurred: true, productivityStatus: true },
        });

        const empNames = await this.db.employee.findMany({
            where: { id: { in: screenshots.map(s => s.employeeId) } },
            select: { id: true, name: true },
        }).then(rows => new Map(rows.map(r => [r.id, r.name])));

        return screenshots.map(s => ({ ...s, employeeName: empNames.get(s.employeeId) ?? 'Unknown' }));
    }

    async getTeamComparison(orgId: string, date: Date) {
        const today = toDateOnly(date);
        const teams = await this.db.team.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true } });
        const summaries = await this.db.dailySummary.findMany({ where: { orgId, summaryDate: today } });

        return teams.map(t => {
            const teamSummaries = summaries.filter(s => s.teamId === t.id);
            const scored = teamSummaries.filter(s => s.productivityScore != null);
            const avgScore = scored.length > 0
                ? Math.round((scored.reduce((sum, s) => sum + Number(s.productivityScore!), 0) / scored.length) * 100) / 100
                : null;
            return {
                teamId: t.id, teamName: t.name,
                employeeCount: teamSummaries.length,
                presentCount: teamSummaries.filter(s => s.isPresent).length,
                avgProductivityScore: avgScore,
                totalProductiveSeconds: teamSummaries.reduce((sum, s) => sum + s.productiveSeconds, 0),
            };
        });
    }
}

function toDateOnly(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
