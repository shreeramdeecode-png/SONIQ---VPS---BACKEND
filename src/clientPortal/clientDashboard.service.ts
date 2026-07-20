import type { PrismaClient } from '@prisma/client';

export class ClientDashboardService {
    constructor(private readonly db: PrismaClient) {}

    async getTodayStats(orgId: string, teamId?: string, from?: Date, to?: Date) {
        const today = toDateOnly(new Date());
        const empWhere = { orgId, deletedAt: null, status: 'active', ...(teamId ? { teamId } : {}) };

        // Productivity metrics honor the selected date range; live counts always reflect "now".
        const rangeFilter = from && to
            ? { summaryDate: { gte: toDateOnly(from), lte: toDateOnly(to) } }
            : { summaryDate: today };

        const [totalEmployees, activeNow, summaries, todaySummaries] = await Promise.all([
            this.db.employee.count({ where: empWhere }),
            this.db.employee.count({ where: { ...empWhere, isCurrentlyWorking: true } }),
            this.db.dailySummary.findMany({ where: { orgId, ...rangeFilter, ...(teamId ? { teamId } : {}) } }),
            this.db.dailySummary.findMany({ where: { orgId, summaryDate: today, ...(teamId ? { teamId } : {}) } }),
        ]);

        // "Checked in today" is a live figure — always today, regardless of the selected range
        const presentToday = todaySummaries.filter(s => s.isPresent).length;

        // Present employee-days across the range — the denominator for a true per-day work average
        const presentEmployeeDays = summaries.filter(s => s.isPresent).length;

        const scored = summaries.filter(s => s.productivityScore != null);
        const avgScore = scored.length > 0
            ? Math.round((scored.reduce((sum, s) => sum + Number(s.productivityScore!), 0) / scored.length) * 100) / 100
            : 0;
        const totalWorkSeconds = summaries.reduce((sum, s) => sum + (s.totalWorkSeconds ?? 0), 0);

        // Org-wide productivity breakdown (drives the Org Productivity Score legend bars)
        const totalProductiveSeconds = summaries.reduce((sum, s) => sum + (s.productiveSeconds ?? 0), 0);
        const totalNeutralSeconds = summaries.reduce((sum, s) => sum + (s.neutralSeconds ?? 0), 0);
        const totalUnproductiveSeconds = summaries.reduce((sum, s) => sum + (s.unproductiveSeconds ?? 0), 0);
        const totalIdleSeconds = summaries.reduce((sum, s) => sum + (s.idleSeconds ?? 0), 0);

        // Average work time per present employee-day (drives Org Health "Avg work time / day")
        const avgWorkSecondsPerDay = presentEmployeeDays > 0 ? Math.round(totalWorkSeconds / presentEmployeeDays) : 0;

        return {
            date: today, totalEmployees, activeNow, avgProductivityScore: avgScore,
            totalWorkSeconds, presentToday,
            totalProductiveSeconds, totalNeutralSeconds, totalUnproductiveSeconds, totalIdleSeconds,
            avgWorkSecondsPerDay,
        };
    }

    /**
     * Wellbeing signals over a trailing window (default 7 days). Flags each employee by their
     * highest-severity signal. Signals: Overwork (sustained long hours vs. expected), acute Long
     * day (today), and Low engagement (persistent low productivity / high idle). Thresholds are
     * relative to each employee's expected work hours (fallback: org default, then 8h).
     */
    async getWellbeingSignals(orgId: string, days = 7, teamId?: string, from?: Date, to?: Date) {
        // Window: explicit from/to when supplied (dashboard date picker), otherwise a
        // trailing `days` window ending today. The "acute long day" signal keys off the
        // LAST day of the window, which is today for the default range.
        const windowEnd = toDateOnly(to ?? new Date());
        const windowStart = from ? toDateOnly(from) : new Date(windowEnd.getTime() - (days - 1) * 86400000);
        const empWhere = { orgId, deletedAt: null, status: 'active', ...(teamId ? { teamId } : {}) };

        const [employees, orgDefault, expectedSettings, summaries] = await Promise.all([
            this.db.employee.findMany({ where: empWhere, select: { id: true, name: true } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
            this.db.expectedWorkHoursSetting.findMany({ where: { orgId } }),
            this.db.dailySummary.findMany({
                where: { orgId, summaryDate: { gte: windowStart, lte: windowEnd }, ...(teamId ? { teamId } : {}) },
            }),
        ]);

        const expectedByEmp = new Map(expectedSettings.map(s => [s.employeeId, Number(s.expectedWorkHoursPerDay)]));
        const orgExpected = orgDefault ? Number(orgDefault.defaultWorkHoursPerDay) : 8;

        const byEmp = new Map<string, typeof summaries>();
        for (const s of summaries) {
            const g = byEmp.get(s.employeeId) ?? [];
            g.push(s);
            byEmp.set(s.employeeId, g);
        }

        const fmtH = (sec: number) => `${Math.round(sec / 360) / 10}h`;

        return employees.map(emp => {
            const rows = (byEmp.get(emp.id) ?? []).filter(r => r.isPresent);
            const expectedH = expectedByEmp.get(emp.id) ?? orgExpected;
            const expectedSec = expectedH * 3600;
            const overSec = expectedSec + 2 * 3600; // expected + 2h = overwork line

            const presentDays = rows.length;
            const totalWork = rows.reduce((s, r) => s + (r.totalWorkSeconds ?? 0), 0);
            const avgDailyWork = presentDays > 0 ? totalWork / presentDays : 0;
            const daysOver = rows.filter(r => (r.totalWorkSeconds ?? 0) >= overSec).length;

            const todayRow = rows.find(r => r.summaryDate.getTime() === windowEnd.getTime());
            const todayWork = todayRow?.totalWorkSeconds ?? 0;

            // Engagement is judged only on days with real work (>= 1h), to avoid noise
            const workingDays = rows.filter(r => (r.totalWorkSeconds ?? 0) >= 3600);
            const scored = workingDays.filter(r => r.productivityScore != null);
            const avgScore = scored.length > 0
                ? scored.reduce((s, r) => s + Number(r.productivityScore!), 0) / scored.length : null;
            const idleSum = workingDays.reduce((s, r) => s + (r.idleSeconds ?? 0), 0);
            const workSum = workingDays.reduce((s, r) => s + (r.totalWorkSeconds ?? 0), 0);
            const idleRatio = workSum > 0 ? idleSum / workSum : 0;

            let severity: 'high' | 'medium' | null = null;
            let signal: 'overwork' | 'longday' | 'engagement' | null = null;
            let reason = '';

            // 1. Overwork — takes precedence (sustained long hours vs. expected)
            if (presentDays > 0 && (avgDailyWork >= overSec || daysOver >= 3)) {
                severity = 'high'; signal = 'overwork';
                reason = daysOver >= 3
                    ? `${daysOver} long days (>${Math.round(expectedH + 2)}h) this week`
                    : `Avg ${fmtH(avgDailyWork)}/day vs ${expectedH}h expected`;
            } else if (presentDays > 0 && (avgDailyWork >= expectedSec + 3600 || daysOver >= 2)) {
                severity = 'medium'; signal = 'overwork';
                reason = `Avg ${fmtH(avgDailyWork)}/day vs ${expectedH}h expected`;
            }

            // 2. Acute long day today (only if not already flagged)
            if (!severity && todayWork >= overSec) {
                severity = 'medium'; signal = 'longday';
                reason = `${fmtH(todayWork)} today vs ${expectedH}h expected`;
            }

            // 3. Low engagement — persistent low productivity or high idle
            if (!severity && scored.length >= 3 && avgScore != null && avgScore < 30) {
                severity = 'medium'; signal = 'engagement';
                reason = `${Math.round(avgScore)}% avg productivity over ${scored.length} days`;
            } else if (!severity && workingDays.length >= 3 && idleRatio > 0.5) {
                severity = 'medium'; signal = 'engagement';
                reason = `${Math.round(idleRatio * 100)}% idle time this week`;
            }

            const summaryLine = presentDays > 0
                ? `Avg ${fmtH(avgDailyWork)}/day${avgScore != null ? ` · ${Math.round(avgScore)}%` : ''}`
                : 'No activity this week';

            return {
                employeeId: emp.id,
                name: emp.name,
                severity,
                signal,
                reason: reason || summaryLine,
                avgDailyHours: Math.round(avgDailyWork / 360) / 10,
                avgScore: avgScore != null ? Math.round(avgScore) : null,
                presentDays,
                expectedHours: expectedH,
            };
        // Only employees with real activity in the window belong in wellbeing signals —
        // drop inactive users (no present days) so they don't clutter the card.
        }).filter(r => r.presentDays > 0);
    }

    // Ranks employees over a DATE RANGE (single day = pass the same date for from/to).
    // Sums each employee's seconds across the range and averages their score, so the
    // dashboard's date picker actually scopes the list.
    private async rankEmployeesByField(
        orgId: string, from: Date, to: Date, field: 'productiveSeconds' | 'unproductiveSeconds',
        limit = 5, teamId?: string,
    ) {
        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: { gte: toDateOnly(from), lte: toDateOnly(to) }, ...(teamId ? { teamId } : {}) },
        });

        const byEmp = new Map<string, { seconds: number; scoreSum: number; scoreCount: number }>();
        for (const s of summaries) {
            const g = byEmp.get(s.employeeId) ?? { seconds: 0, scoreSum: 0, scoreCount: 0 };
            g.seconds += s[field] ?? 0;
            if (s.productivityScore != null) { g.scoreSum += Number(s.productivityScore); g.scoreCount++; }
            byEmp.set(s.employeeId, g);
        }

        const ranked = [...byEmp.entries()]
            .sort((a, b) => b[1].seconds - a[1].seconds)
            .slice(0, limit);

        const employees = await this.db.employee.findMany({
            where: { id: { in: ranked.map(([id]) => id) } }, select: { id: true, name: true },
        }).then(rows => new Map(rows.map(r => [r.id, r.name])));

        return ranked.map(([employeeId, g]) => ({
            employeeId,
            name: employees.get(employeeId) ?? 'Unknown',
            [field]: g.seconds,
            productivityScore: g.scoreCount > 0 ? Math.round(g.scoreSum / g.scoreCount) : null,
        }));
    }

    async getTopProductive(orgId: string, from: Date, to: Date, limit = 5, teamId?: string) {
        return this.rankEmployeesByField(orgId, from, to, 'productiveSeconds', limit, teamId);
    }

    async getTopUnproductive(orgId: string, from: Date, to: Date, limit = 5, teamId?: string) {
        return this.rankEmployeesByField(orgId, from, to, 'unproductiveSeconds', limit, teamId);
    }

    async getTopApps(orgId: string, from: Date, to: Date, limit = 10, teamId?: string) {
        const empIds = teamId
            ? await this.db.employee.findMany({ where: { orgId, teamId, deletedAt: null }, select: { id: true } })
                .then(rows => rows.map(r => r.id))
            : undefined;

        const timeFilter = {
            OR: [
                { startTime: { gte: from, lte: to } },
                { startTime: null, receivedAt: { gte: from, lte: to } },
            ],
        };
        const empFilter = empIds ? { employeeId: { in: empIds } } : {};

        // System states that Trackpilots emits as app events — exclude from all app charts
        const SYSTEM_APP_BLOCKLIST = ['Locked', 'Idle', 'Screen Lock', 'TrackPilots', 'Activity ITR'];

        // Native apps grouped by appName; websites grouped by domain for per-site breakdown
        const [appGroups, webGroups] = await Promise.all([
            this.db.activityEvent.groupBy({
                by: ['appName'],
                where: {
                    orgId, eventType: 'App' as const, appType: 'Application',
                    appName: { not: null },
                    NOT: { appName: { in: SYSTEM_APP_BLOCKLIST } },
                    ...empFilter, ...timeFilter,
                },
                _sum: { durationSeconds: true },
                orderBy: { _sum: { durationSeconds: 'desc' } },
                take: limit,
            }),
            this.db.activityEvent.groupBy({
                by: ['appDomain'],
                where: {
                    orgId, eventType: 'App' as const, appType: 'Website',
                    appDomain: { not: null },
                    ...empFilter, ...timeFilter,
                },
                _sum: { durationSeconds: true },
                orderBy: { _sum: { durationSeconds: 'desc' } },
                take: limit,
            }),
        ]);

        const [appResults, webResults] = await Promise.all([
            Promise.all(appGroups.map(async g => {
                const meta = await this.db.activityEvent.findFirst({
                    where: { orgId, appName: g.appName, eventType: 'App', appType: 'Application', ...timeFilter },
                    select: { appCategory: true, productivityStatus: true },
                });
                return {
                    appName: g.appName,
                    appDomain: null as string | null,
                    appCategory: meta?.appCategory ?? null,
                    productivityStatus: meta?.productivityStatus ?? 'Neutral',
                    appType: 'Application',
                    totalDurationSeconds: g._sum.durationSeconds ?? 0,
                };
            })),
            Promise.all(webGroups.map(async g => {
                const meta = await this.db.activityEvent.findFirst({
                    where: { orgId, appDomain: g.appDomain, eventType: 'App', appType: 'Website', ...timeFilter },
                    select: { appName: true, appCategory: true, productivityStatus: true },
                });
                return {
                    appName: meta?.appName ?? g.appDomain,
                    appDomain: g.appDomain,
                    appCategory: meta?.appCategory ?? null,
                    productivityStatus: meta?.productivityStatus ?? 'Neutral',
                    appType: 'Website',
                    totalDurationSeconds: g._sum.durationSeconds ?? 0,
                };
            })),
        ]);

        return [...appResults, ...webResults].sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds);
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
    // Align to IST day boundary — matches how dailySummary.job.ts keys summaryDate
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
