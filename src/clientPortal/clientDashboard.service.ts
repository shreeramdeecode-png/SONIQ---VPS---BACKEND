import type { PrismaClient } from '@prisma/client';

export class ClientDashboardService {
    constructor(private readonly db: PrismaClient) {}

    async getTodayStats(orgId: string, from?: Date, to?: Date, teamId?: string) {
        const today = toIstDateOnly(new Date());
        const rangeFrom = from ? toDateOnly(from) : today;
        const rangeTo = to ? toDateOnly(to) : today;
        const empWhere = { orgId, deletedAt: null, status: 'active', ...(teamId ? { teamId } : {}) };

        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        const [totalEmployees, activeNow, summaries] = await Promise.all([
            this.db.employee.count({ where: empWhere }),
            this.db.employee.count({ where: { ...empWhere, isCurrentlyWorking: true, lastSeenAt: { gte: tenMinAgo } } }),
            this.db.dailySummary.findMany({
                where: { orgId, summaryDate: { gte: rangeFrom, lte: rangeTo }, ...(teamId ? { teamId } : {}) },
            }),
        ]);

        const presentSummaries = summaries.filter(s => s.isPresent);
        const presentToday = new Set(presentSummaries.map(s => s.employeeId)).size;

        const scored = presentSummaries.filter(s => s.productivityScore != null);
        const avgScore = scored.length > 0
            ? Math.round((scored.reduce((sum, s) => sum + Number(s.productivityScore!), 0) / scored.length) * 100) / 100
            : 0;

        const totalWorkSeconds = presentSummaries.reduce((sum, s) => sum + (s.totalWorkSeconds ?? 0), 0);
        const avgWorkSecondsPerDay = presentSummaries.length > 0 ? totalWorkSeconds / presentSummaries.length : 0;
        const totalProductiveSeconds = presentSummaries.reduce((sum, s) => sum + (s.productiveSeconds ?? 0), 0);
        const totalIdleSeconds = presentSummaries.reduce((sum, s) => sum + (s.idleSeconds ?? 0), 0);
        const totalUnproductiveSeconds = presentSummaries.reduce((sum, s) => sum + (s.unproductiveSeconds ?? 0), 0);
        const totalNeutralSeconds = presentSummaries.reduce((sum, s) => sum + (s.neutralSeconds ?? 0), 0);

        return {
            date: today, totalEmployees, activeNow, avgProductivityScore: avgScore,
            totalWorkSeconds, avgWorkSecondsPerDay, presentToday,
            totalProductiveSeconds, totalIdleSeconds, totalUnproductiveSeconds, totalNeutralSeconds,
        };
    }

    async getTopProductive(orgId: string, from: Date, to: Date, limit = 5, teamId?: string) {
        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: { gte: toDateOnly(from), lte: toDateOnly(to) }, isPresent: true, ...(teamId ? { teamId } : {}) },
        });

        const byEmployee = new Map<string, { productiveSeconds: number; scored: number[]; }>();
        for (const s of summaries) {
            const entry = byEmployee.get(s.employeeId) ?? { productiveSeconds: 0, scored: [] };
            entry.productiveSeconds += s.productiveSeconds ?? 0;
            if (s.productivityScore != null) entry.scored.push(Number(s.productivityScore));
            byEmployee.set(s.employeeId, entry);
        }

        const ranked = [...byEmployee.entries()]
            .sort((a, b) => b[1].productiveSeconds - a[1].productiveSeconds)
            .slice(0, limit);

        const empIds = ranked.map(([id]) => id);
        const employees = await this.db.employee.findMany({
            where: { id: { in: empIds } }, select: { id: true, name: true },
        }).then(rows => new Map(rows.map(r => [r.id, r.name])));

        return ranked.map(([employeeId, agg]) => ({
            employeeId,
            name: employees.get(employeeId) ?? 'Unknown',
            productiveSeconds: agg.productiveSeconds,
            productivityScore: agg.scored.length > 0
                ? agg.scored.reduce((a, b) => a + b, 0) / agg.scored.length
                : null,
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
                OR: [
                    { startTime: { gte: from, lte: to } },
                    { startTime: null, receivedAt: { gte: from, lte: to } },
                ],
                AND: [
                    { appName: { not: null } },
                    { appName: { not: '' } },
                ],
                ...(empWhere ? { employeeId: { in: empWhere } } : {}),
            },
            select: { appName: true, appDomain: true, appCategory: true, appType: true, appIconUrl: true, productivityStatus: true, durationSeconds: true },
        });

        const groups = new Map<string, { appName: string; appDomain: string | null; appCategory: string | null; appType: string | null; appIconUrl: string | null; totalDuration: number; productivityStatus: string }>();
        for (const e of events) {
            // Skip Trackpilots system events (Idle, Start, …) — not real apps
            if (e.appCategory === 'trackpilots-category') continue;
            const isWebsite = e.appType === 'Website' && !!e.appDomain;
            const displayName = isWebsite ? e.appDomain! : cleanAppName(e.appName!);
            const key = (isWebsite ? 'w:' : 'a:') + displayName;
            const g = groups.get(key) ?? {
                appName: displayName,
                appDomain: isWebsite ? e.appDomain : null,
                appCategory: e.appCategory,
                appType: isWebsite ? 'Website' : 'Application',
                appIconUrl: e.appIconUrl ?? null,
                totalDuration: 0,
                productivityStatus: e.productivityStatus ?? 'Neutral',
            };
            if (!g.appIconUrl && e.appIconUrl) g.appIconUrl = e.appIconUrl;
            g.totalDuration += e.durationSeconds ?? 0;
            groups.set(key, g);
        }

        return Array.from(groups.values())
            .map(g => ({ appName: g.appName, appDomain: g.appDomain, appCategory: g.appCategory, appType: g.appType, appIconUrl: g.appIconUrl, productivityStatus: g.productivityStatus, totalDurationSeconds: g.totalDuration }))
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
                neutralSeconds: s?.neutralSeconds ?? 0,
                idleSeconds: s?.idleSeconds ?? 0,
                totalWorkSeconds: s?.totalWorkSeconds ?? 0,
                productivityScore: s?.productivityScore ?? null,
                screenshotsCount: s?.screenshotsCount ?? 0,
            };
        });
    }

    async getWorkHourChart(orgId: string, from: Date, to: Date, teamId?: string) {
        let empIds: string[] | undefined;
        if (teamId) {
            const emps = await this.db.employee.findMany({
                where: { orgId, teamId, deletedAt: null },
                select: { id: true },
            });
            empIds = emps.map(e => e.id);
        }
        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: { gte: from, lte: to }, ...(empIds ? { employeeId: { in: empIds } } : {}) },
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
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        const [total, activeNow] = await Promise.all([
            this.db.employee.count({ where }),
            this.db.employee.count({ where: { ...where, isCurrentlyWorking: true, lastSeenAt: { gte: tenMinAgo } } }),
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
            select: { id: true, employeeId: true, thumbnailUrl: true, appName: true, appIconUrl: true, capturedAt: true, isBlurred: true, productivityStatus: true },
        });

        const empNames = await this.db.employee.findMany({
            where: { id: { in: screenshots.map(s => s.employeeId) } },
            select: { id: true, name: true },
        }).then(rows => new Map(rows.map(r => [r.id, r.name])));

        return screenshots.map(s => ({
            ...s,
            thumbnailUrl: s.thumbnailUrl
                ? (s.thumbnailUrl.startsWith('http') ? s.thumbnailUrl : `/screenshots/${s.thumbnailUrl}`)
                : null,
            employeeName: empNames.get(s.employeeId) ?? 'Unknown',
        }));
    }

    async getTeamComparison(orgId: string, date: Date) {
        const today = toDateOnly(date);
        const teams = await this.db.team.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true } });

        const allEmployees = await this.db.employee.findMany({
            where: { orgId, teamId: { in: teams.map(t => t.id) }, deletedAt: null },
            select: { id: true, teamId: true },
        });
        const empTeamMap = new Map(allEmployees.map(e => [e.id, e.teamId]));
        const allEmpIds = allEmployees.map(e => e.id);

        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: today, employeeId: { in: allEmpIds } },
        });

        return teams.map(t => {
            const teamEmpIds = new Set(allEmployees.filter(e => e.teamId === t.id).map(e => e.id));
            const teamSummaries = summaries.filter(s => teamEmpIds.has(s.employeeId));
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

function toIstDateOnly(d: Date): Date {
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

// Trackpilots sends raw process names like "WhatsApp.Root" — strip window/process suffixes
function cleanAppName(name: string): string {
    return name.replace(/\.(Root|exe)$/i, '').trim();
}
