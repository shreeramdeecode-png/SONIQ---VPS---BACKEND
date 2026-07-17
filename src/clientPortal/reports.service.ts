import type { PrismaClient } from '@prisma/client';
import { toCsv } from '../utils/csvExport.js';

export class ReportsService {
    constructor(private readonly db: PrismaClient) {}

    async getProductivityTrend(orgId: string, from: Date, to: Date, teamId?: string) {
        const where = {
            orgId,
            summaryDate: { gte: from, lte: to },
            ...(teamId ? { teamId } : {}),
        };

        const [summaries, employeeMap] = await Promise.all([
            this.db.dailySummary.findMany({ where, orderBy: { summaryDate: 'asc' } }),
            this.db.employee.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true, designation: true, team: { select: { name: true } } } })
                .then(rows => new Map(rows.map(r => [r.id, r]))),
        ]);

        return summaries.map(s => {
            const emp = employeeMap.get(s.employeeId);
            return {
                date: s.summaryDate.toISOString().slice(0, 10),
                employeeId: s.employeeId,
                name: emp?.name ?? 'Unknown',
                designation: emp?.designation ?? null,
                team: emp?.team?.name ?? null,
                totalWorkSeconds: s.totalWorkSeconds,
                productiveSeconds: s.productiveSeconds,
                unproductiveSeconds: s.unproductiveSeconds,
                idleSeconds: s.idleSeconds,
                productivityScore: s.productivityScore,
                isPresent: s.isPresent,
                isLate: s.isLate,
            };
        });
    }

    async getAppUsage(orgId: string, from: Date, to: Date, employeeId?: string) {
        const where = {
            orgId,
            eventType: 'App' as const,
            appName: { not: null },
            durationSeconds: { not: null },
            ...(employeeId ? { employeeId } : {}),
            OR: [
                { startTime: { gte: from, lte: to } },
                { startTime: null, receivedAt: { gte: from, lte: to } },
            ],
        };

        const events = await this.db.activityEvent.findMany({
            where,
            select: { appName: true, appType: true, appDomain: true, appCategory: true, productivityStatus: true, durationSeconds: true },
        });

        const groups = new Map<string, { totalDuration: number; count: number; meta: typeof events[0] }>();
        for (const e of events) {
            const key = `${e.appName}|${e.appDomain ?? ''}|${e.appCategory ?? ''}|${e.productivityStatus ?? 'Neutral'}`;
            const g = groups.get(key) ?? { totalDuration: 0, count: 0, meta: e };
            g.totalDuration += e.durationSeconds ?? 0;
            g.count++;
            groups.set(key, g);
        }

        return Array.from(groups.values())
            .map(({ totalDuration, count, meta }) => ({
                appName: meta.appName,
                appType: meta.appType, // 'Application' | 'Website' — lets the UI split apps vs sites correctly
                appDomain: meta.appDomain,
                appCategory: meta.appCategory,
                productivityStatus: meta.productivityStatus ?? 'Neutral',
                totalDurationSeconds: totalDuration,
                eventCount: count,
            }))
            .sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds);
    }

    // Hourly productivity heatmap: buckets App events by IST calendar DATE × IST hour
    // (8AM–7PM) → { productive, total } seconds, keyed by 'YYYY-MM-DD'. The frontend
    // groups the dates into weeks (Mon–Fri, weekends skipped) and renders one grid per
    // week, so no two dates are ever merged into a single weekday row.
    async getHourlyHeatmap(orgId: string, from: Date, to: Date, employeeId?: string) {
        const SYSTEM_APP_BLOCKLIST = ['Locked', 'Idle', 'Screen Lock', 'TrackPilots', 'Activity ITR'];
        const where = {
            orgId,
            eventType: 'App' as const,
            appName: { not: null },
            durationSeconds: { not: null },
            NOT: { appName: { in: SYSTEM_APP_BLOCKLIST } },
            ...(employeeId ? { employeeId } : {}),
            OR: [
                { startTime: { gte: from, lte: to } },
                { startTime: null, receivedAt: { gte: from, lte: to } },
            ],
        };

        const events = await this.db.activityEvent.findMany({
            where,
            select: { startTime: true, receivedAt: true, durationSeconds: true, productivityStatus: true },
        });

        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        // bucket['YYYY-MM-DD'][hour 8-19] = { productive, total } in seconds.
        // One entry per real calendar date — the frontend groups these into weeks.
        const bucket: Record<string, Record<number, { productive: number; total: number }>> = {};

        for (const e of events) {
            const ts = e.startTime ?? e.receivedAt;
            if (!ts) continue;
            const ist = new Date(ts.getTime() + IST_OFFSET_MS); // shift to IST wall-clock
            const hour = ist.getUTCHours();
            if (hour < 8 || hour > 19) continue;    // 8AM–7PM only (matches the grid columns)
            const dateStr = ist.toISOString().slice(0, 10); // IST calendar date
            const dur = e.durationSeconds ?? 0;
            if (!bucket[dateStr]) bucket[dateStr] = {};
            if (!bucket[dateStr][hour]) bucket[dateStr][hour] = { productive: 0, total: 0 };
            bucket[dateStr][hour].total += dur;
            if (e.productivityStatus === 'Productive') bucket[dateStr][hour].productive += dur;
        }

        return bucket;
    }

    // Focus-session metrics reconstructed from the raw App-event timeline (per employee):
    //  - deepSessionsPerDay: productive runs >= 30 min, averaged over active days
    //  - longestStreakMin / avgStreakMin: length of continuous productive runs
    //  - switchesPerHour: app/context switches per tracked hour
    // A productive "run" is consecutive productive events with <= 5 min gaps; any
    // non-productive event or a larger gap ends the run. System apps are excluded.
    async getFocusMetrics(orgId: string, from: Date, to: Date, teamId?: string) {
        const SYSTEM_APP_BLOCKLIST = ['Locked', 'Idle', 'Screen Lock', 'TrackPilots', 'Activity ITR'];
        const empWhere = { orgId, deletedAt: null, ...(teamId ? { teamId } : {}) };
        const employees = await this.db.employee.findMany({ where: empWhere, select: { id: true } });
        const empIds = employees.map(e => e.id);
        if (empIds.length === 0) return [];

        const events = await this.db.activityEvent.findMany({
            where: {
                orgId,
                eventType: 'App' as const,
                appName: { not: null },
                durationSeconds: { not: null },
                NOT: { appName: { in: SYSTEM_APP_BLOCKLIST } },
                employeeId: { in: empIds },
                OR: [
                    { startTime: { gte: from, lte: to } },
                    { startTime: null, receivedAt: { gte: from, lte: to } },
                ],
            },
            select: { employeeId: true, startTime: true, receivedAt: true, durationSeconds: true, productivityStatus: true, appName: true },
        });

        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const GAP_MS = 5 * 60 * 1000;   // <= 5 min gap keeps a productive run alive
        const DEEP_S = 30 * 60;         // >= 30 min productive run = one deep session

        const byEmp = new Map<string, typeof events>();
        for (const e of events) {
            if (!byEmp.has(e.employeeId)) byEmp.set(e.employeeId, []);
            byEmp.get(e.employeeId)!.push(e);
        }

        const result: {
            employeeId: string; deepSessionsPerDay: number; longestStreakMin: number;
            avgStreakMin: number; switchesPerHour: number;
        }[] = [];

        for (const [employeeId, evs] of byEmp.entries()) {
            const timeline = evs
                .map(e => ({ ts: e.startTime ?? e.receivedAt, dur: e.durationSeconds ?? 0, prod: e.productivityStatus === 'Productive', app: e.appName }))
                .filter((e): e is { ts: Date; dur: number; prod: boolean; app: string | null } => e.ts != null)
                .sort((a, b) => a.ts.getTime() - b.ts.getTime());
            if (timeline.length === 0) continue;

            const runs: number[] = [];       // productive run durations (seconds)
            let curRun = 0;
            let curEnd: number | null = null; // end time (ms) of last productive event
            let switches = 0;
            let prevApp: string | null = null;
            let totalTracked = 0;
            const activeDates = new Set<string>();

            for (const e of timeline) {
                totalTracked += e.dur;
                if (prevApp !== null && e.app !== prevApp) switches++;
                prevApp = e.app;

                const startMs = e.ts.getTime();
                if (e.prod) {
                    activeDates.add(new Date(startMs + IST_OFFSET_MS).toISOString().slice(0, 10));
                    if (curEnd !== null && startMs - curEnd <= GAP_MS) {
                        curRun += e.dur; // extend the current run
                    } else {
                        if (curRun > 0) runs.push(curRun);
                        curRun = e.dur;  // start a new run
                    }
                    curEnd = startMs + e.dur * 1000;
                } else if (curRun > 0) {
                    runs.push(curRun);   // non-productive event breaks the run
                    curRun = 0;
                    curEnd = null;
                }
            }
            if (curRun > 0) runs.push(curRun);

            const activeDays = Math.max(1, activeDates.size);
            const deepSessions = runs.filter(r => r >= DEEP_S).length;
            const trackedHours = totalTracked / 3600;

            result.push({
                employeeId,
                deepSessionsPerDay: Math.round((deepSessions / activeDays) * 10) / 10,
                longestStreakMin: runs.length ? Math.round(Math.max(...runs) / 60) : 0,
                avgStreakMin: runs.length ? Math.round((runs.reduce((s, r) => s + r, 0) / runs.length) / 60) : 0,
                switchesPerHour: trackedHours > 0 ? Math.round(switches / trackedHours) : 0,
            });
        }

        return result;
    }

    async getEffortUtilization(orgId: string, from: Date, to: Date, teamId?: string) {
        const where = { orgId, summaryDate: { gte: from, lte: to }, ...(teamId ? { teamId } : {}) };

        const [summaries, employees, workHourSettings, orgDefaults] = await Promise.all([
            this.db.dailySummary.findMany({ where, orderBy: [{ summaryDate: 'asc' }, { employeeId: 'asc' }] }),
            this.db.employee.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true, designation: true, team: { select: { name: true } } } })
                .then(rows => new Map(rows.map(r => [r.id, r]))),
            this.db.expectedWorkHoursSetting.findMany({ where: { orgId } })
                .then(rows => new Map(rows.map(r => [r.employeeId, r]))),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);

        const defaultHours = Number(orgDefaults?.defaultWorkHoursPerDay ?? 8);
        const defaultProductiveHours = Number(orgDefaults?.defaultProductiveHoursPerDay ?? 6);

        return summaries.map(s => {
            const emp = employees.get(s.employeeId);
            const wh = workHourSettings.get(s.employeeId);
            const targetHours = Number(wh?.expectedWorkHoursPerDay ?? defaultHours);
            const targetProductiveHours = Number(wh?.expectedProductiveHoursPerDay ?? defaultProductiveHours);
            const actualHours = s.totalWorkSeconds / 3600;
            const actualProductiveHours = s.productiveSeconds / 3600;
            return {
                date: s.summaryDate.toISOString().slice(0, 10),
                employeeId: s.employeeId,
                name: emp?.name ?? 'Unknown',
                designation: emp?.designation ?? null,
                team: emp?.team?.name ?? null,
                targetWorkHours: targetHours,
                targetProductiveHours,
                actualWorkHours: Math.round(actualHours * 100) / 100,
                actualProductiveHours: Math.round(actualProductiveHours * 100) / 100,
                workUtilizationPct: targetHours > 0 ? Math.round((actualHours / targetHours) * 100) : 0,
                productiveUtilizationPct: targetProductiveHours > 0 ? Math.round((actualProductiveHours / targetProductiveHours) * 100) : 0,
                isPresent: s.isPresent,
            };
        });
    }

    async getAttendanceReport(orgId: string, from: Date, to: Date, teamId?: string) {
        const where = { orgId, summaryDate: { gte: from, lte: to }, ...(teamId ? { teamId } : {}) };

        const [summaries, employees] = await Promise.all([
            this.db.dailySummary.findMany({ where, orderBy: [{ summaryDate: 'asc' }, { employeeId: 'asc' }] }),
            this.db.employee.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true, designation: true, department: true, team: { select: { name: true } } } })
                .then(rows => new Map(rows.map(r => [r.id, r]))),
        ]);

        return summaries.map(s => {
            const emp = employees.get(s.employeeId);
            return {
                date: s.summaryDate.toISOString().slice(0, 10),
                employeeId: s.employeeId,
                name: emp?.name ?? 'Unknown',
                designation: emp?.designation ?? null,
                department: emp?.department ?? null,
                team: emp?.team?.name ?? null,
                isPresent: s.isPresent,
                isLate: s.isLate,
                firstCheckin: s.firstCheckin,
                lastCheckout: s.lastCheckout,
                totalWorkSeconds: s.totalWorkSeconds,
                productiveSeconds: s.productiveSeconds,
                unproductiveSeconds: s.unproductiveSeconds,
                idleSeconds: s.idleSeconds,
                productivityScore: s.productivityScore,
                screenshotsCount: s.screenshotsCount,
            };
        });
    }

    async getTimesheetReport(orgId: string, from: Date, to: Date, employeeId?: string) {
        const empWhere = { orgId, deletedAt: null, status: 'active', ...(employeeId ? { id: employeeId } : {}) };
        const employees = await this.db.employee.findMany({
            where: empWhere,
            select: { id: true, name: true, designation: true, department: true, team: { select: { name: true } } },
        });

        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, summaryDate: { gte: from, lte: to }, ...(employeeId ? { employeeId } : {}) },
            orderBy: [{ employeeId: 'asc' }, { summaryDate: 'asc' }],
        });

        const empMap = new Map(employees.map(e => [e.id, e]));

        return summaries.map(s => {
            const emp = empMap.get(s.employeeId);
            const totalHours = s.totalWorkSeconds / 3600;
            const checkinTime = s.firstCheckin?.toISOString() ?? null;
            const checkoutTime = s.lastCheckout?.toISOString() ?? null;
            return {
                date: s.summaryDate.toISOString().slice(0, 10),
                employeeId: s.employeeId,
                name: emp?.name ?? 'Unknown',
                designation: emp?.designation ?? null,
                department: emp?.department ?? null,
                team: emp?.team?.name ?? null,
                checkIn: checkinTime,
                checkOut: checkoutTime,
                totalHours: Math.round(totalHours * 100) / 100,
                productiveHours: Math.round((s.productiveSeconds / 3600) * 100) / 100,
                unproductiveHours: Math.round((s.unproductiveSeconds / 3600) * 100) / 100,
                idleHours: Math.round((s.idleSeconds / 3600) * 100) / 100,
                productivityScore: s.productivityScore,
            };
        });
    }

    async exportReportCsv(
        orgId: string,
        type: 'productivity' | 'app-usage' | 'effort' | 'attendance' | 'timesheet',
        from: Date,
        to: Date,
        opts: { teamId?: string; employeeId?: string } = {},
    ): Promise<string> {
        switch (type) {
            case 'productivity': {
                const rows = await this.getProductivityTrend(orgId, from, to, opts.teamId);
                return toCsv(rows.map(r => ({
                    Date: r.date, 'Employee ID': r.employeeId, Name: r.name,
                    Designation: r.designation ?? '', Team: r.team ?? '',
                    'Total Work (hrs)': (r.totalWorkSeconds / 3600).toFixed(2),
                    'Productive (hrs)': (r.productiveSeconds / 3600).toFixed(2),
                    'Unproductive (hrs)': (r.unproductiveSeconds / 3600).toFixed(2),
                    'Idle (hrs)': (r.idleSeconds / 3600).toFixed(2),
                    'Score': r.productivityScore != null ? String(r.productivityScore) : '',
                    Present: r.isPresent ? 'Yes' : 'No', Late: r.isLate ? 'Yes' : 'No',
                })));
            }
            case 'app-usage': {
                const rows = await this.getAppUsage(orgId, from, to, opts.employeeId);
                return toCsv(rows.map(r => ({
                    App: r.appName ?? '', Domain: r.appDomain ?? '', Category: r.appCategory ?? '',
                    'Productivity Status': r.productivityStatus,
                    'Total Duration (hrs)': (r.totalDurationSeconds / 3600).toFixed(2),
                    'Event Count': String(r.eventCount),
                })));
            }
            case 'effort': {
                const rows = await this.getEffortUtilization(orgId, from, to, opts.teamId);
                return toCsv(rows.map(r => ({
                    Date: r.date, Name: r.name, Team: r.team ?? '',
                    'Target Work (hrs)': String(r.targetWorkHours),
                    'Actual Work (hrs)': String(r.actualWorkHours),
                    'Work Utilization %': String(r.workUtilizationPct),
                    'Target Productive (hrs)': String(r.targetProductiveHours),
                    'Actual Productive (hrs)': String(r.actualProductiveHours),
                    'Productive Utilization %': String(r.productiveUtilizationPct),
                })));
            }
            case 'attendance': {
                const rows = await this.getAttendanceReport(orgId, from, to, opts.teamId);
                return toCsv(rows.map(r => ({
                    Date: r.date, Name: r.name, Team: r.team ?? '',
                    Present: r.isPresent ? 'Yes' : 'No', Late: r.isLate ? 'Yes' : 'No',
                    'Check-in': r.firstCheckin?.toISOString() ?? '',
                    'Check-out': r.lastCheckout?.toISOString() ?? '',
                    'Total Work (hrs)': (r.totalWorkSeconds / 3600).toFixed(2),
                    'Score': r.productivityScore != null ? String(r.productivityScore) : '',
                })));
            }
            case 'timesheet': {
                const rows = await this.getTimesheetReport(orgId, from, to, opts.employeeId);
                return toCsv(rows.map(r => ({
                    Date: r.date, Name: r.name, Team: r.team ?? '',
                    'Check-in': r.checkIn ?? '', 'Check-out': r.checkOut ?? '',
                    'Total (hrs)': String(r.totalHours),
                    'Productive (hrs)': String(r.productiveHours),
                    'Unproductive (hrs)': String(r.unproductiveHours),
                    'Idle (hrs)': String(r.idleHours),
                    'Score': r.productivityScore != null ? String(r.productivityScore) : '',
                })));
            }
        }
    }
}
