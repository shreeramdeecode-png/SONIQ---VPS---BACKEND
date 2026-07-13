import type { PrismaClient } from '@prisma/client';
import { toCsv } from '../utils/csvExport.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// System states Trackpilots emits as App events — not real activity, excluded from the timeline.
// Keep in sync with dailySummary.job.ts, appEvent.job.ts and clientDashboard.service.ts.
const SYSTEM_APP_BLOCKLIST = new Set(['Locked', 'Idle', 'Screen Lock', 'TrackPilots', 'Activity ITR']);

function toIstDay(d: Date): Date {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

export class AttendanceService {
    constructor(private readonly db: PrismaClient) {}

    async getDailyAttendance(orgId: string, date: Date, teamId?: string) {
        const summaryDate = toIstDay(date);
        const employeesWhere = {
            orgId, deletedAt: null, status: 'active',
            ...(teamId ? { teamId } : {}),
        };

        const [employees, summaryMap] = await Promise.all([
            this.db.employee.findMany({
                where: employeesWhere,
                select: { id: true, name: true, team: { select: { name: true } }, isCurrentlyWorking: true, lastSeenAt: true },
            }),
            this.db.dailySummary.findMany({
                where: { orgId, summaryDate },
            }).then(rows => new Map(rows.map(r => [r.employeeId, r]))),
        ]);

        return employees.map(emp => {
            const s = summaryMap.get(emp.id);
            return {
                employeeId: emp.id,
                name: emp.name,
                teamName: emp.team?.name ?? null,
                // Needed by the frontend isLiveActive() to show "Active" instead of a checkout time
                isCurrentlyWorking: emp.isCurrentlyWorking,
                lastSeenAt: emp.lastSeenAt,
                isPresent: s?.isPresent ?? false,
                firstCheckin: s?.firstCheckin ?? null,
                lastCheckout: s?.lastCheckout ?? null,
                totalWorkSeconds: s?.totalWorkSeconds ?? 0,
                productiveSeconds: s?.productiveSeconds ?? 0,
                productivityScore: s?.productivityScore ?? null,
                isLate: s?.isLate ?? false,
                screenshotsCount: s?.screenshotsCount ?? 0,
            };
        });
    }

    async getEmployeeAttendance(orgId: string, employeeId: string, from: Date, to: Date) {
        const exists = await this.db.employee.findFirst({ where: { id: employeeId, orgId, deletedAt: null } });
        if (!exists) throw Object.assign(new Error(`Employee ${employeeId} not found.`), { statusCode: 404 });

        const summaries = await this.db.dailySummary.findMany({
            where: { orgId, employeeId, summaryDate: { gte: from, lte: to } },
            orderBy: { summaryDate: 'asc' },
        });

        return summaries.map(s => ({
            date: s.summaryDate,
            isPresent: s.isPresent,
            firstCheckin: s.firstCheckin,
            lastCheckout: s.lastCheckout,
            totalWorkSeconds: s.totalWorkSeconds,
            productiveSeconds: s.productiveSeconds,
            productivityScore: s.productivityScore,
            isLate: s.isLate,
            screenshotsCount: s.screenshotsCount,
        }));
    }

    async getAttendanceTimeline(orgId: string, date: Date, teamId?: string, employeeId?: string) {
        // IST-aligned day boundaries (UTC+5:30): events from IST midnight to IST midnight
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(date.getTime() + IST_OFFSET_MS);
        const dayStart = new Date(
            Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()) - IST_OFFSET_MS,
        );
        const dayEnd = new Date(dayStart.getTime() + 86400000);

        const empWhere = {
            orgId, deletedAt: null, status: 'active',
            ...(teamId ? { teamId } : {}),
            ...(employeeId ? { id: employeeId } : {}),
        };
        const employees = await this.db.employee.findMany({
            where: empWhere,
            select: { id: true, name: true, team: { select: { name: true } } },
            orderBy: { name: 'asc' },
        });

        const events = await this.db.activityEvent.findMany({
            where: {
                orgId,
                eventType: 'App',
                employeeId: { in: employees.map(e => e.id) },
                OR: [
                    { startTime: { gte: dayStart, lt: dayEnd } },
                    { startTime: null, receivedAt: { gte: dayStart, lt: dayEnd } },
                ],
            },
            select: { employeeId: true, appName: true, appDomain: true, appType: true, productivityStatus: true, startTime: true, endTime: true, durationSeconds: true, receivedAt: true },
            orderBy: { startTime: 'asc' },
        });

        const byEmployee = new Map<string, typeof events>();
        for (const ev of events) {
            const g = byEmployee.get(ev.employeeId) ?? [];
            g.push(ev);
            byEmployee.set(ev.employeeId, g);
        }

        return employees.map(e => ({
            employeeId: e.id,
            name: e.name,
            teamName: e.team?.name ?? null,
            segments: (byEmployee.get(e.id) ?? [])
                .filter(ev => !(ev.appName && SYSTEM_APP_BLOCKLIST.has(ev.appName)))
                .map(ev => {
                const startTime = ev.startTime ?? ev.receivedAt;
                // endTime is null for all Trackpilots events; derive from startTime + durationSeconds
                const endTime = ev.endTime
                    ?? (ev.durationSeconds ? new Date(startTime.getTime() + ev.durationSeconds * 1000) : null);
                return {
                    appName: ev.appName,
                    appDomain: ev.appDomain,
                    appType: ev.appType,
                    productivityStatus: ev.productivityStatus,
                    startTime,
                    endTime,
                    durationSeconds: ev.durationSeconds,
                };
            }),
        }));
    }

    async exportAttendanceCsv(orgId: string, date: Date, teamId?: string): Promise<string> {
        const rows = await this.getDailyAttendance(orgId, date, teamId);
        return toCsv(rows.map(r => ({
            'Employee ID': r.employeeId,
            'Name': r.name,
            'Team': r.teamName ?? '',
            'Present': r.isPresent ? 'Yes' : 'No',
            'First Check-in': r.firstCheckin ? r.firstCheckin.toISOString() : '',
            'Last Check-out': r.lastCheckout ? r.lastCheckout.toISOString() : '',
            'Total Work (hrs)': (r.totalWorkSeconds / 3600).toFixed(2),
            'Productive (hrs)': (r.productiveSeconds / 3600).toFixed(2),
            'Productivity Score': r.productivityScore != null ? String(r.productivityScore) : '',
            'Late': r.isLate ? 'Yes' : 'No',
            'Screenshots': String(r.screenshotsCount),
        })));
    }
}

