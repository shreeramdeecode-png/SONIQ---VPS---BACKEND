import type { PrismaClient } from '@prisma/client';
import { toCsv } from '../utils/csvExport.js';

export class AttendanceService {
    constructor(private readonly db: PrismaClient) {}

    async getDailyAttendance(orgId: string, date: Date, teamId?: string) {
        const employeesWhere = {
            orgId, deletedAt: null, status: 'active',
            ...(teamId ? { teamId } : {}),
        };

        const [employees, summaryMap] = await Promise.all([
            this.db.employee.findMany({
                where: employeesWhere,
                select: { id: true, name: true, isCurrentlyWorking: true, lastSeenAt: true, team: { select: { name: true } } },
            }),
            this.db.dailySummary.findMany({
                where: { orgId, summaryDate: date },
            }).then(rows => new Map(rows.map(r => [r.employeeId, r]))),
        ]);

        return employees.map(emp => {
            const s = summaryMap.get(emp.id);
            return {
                employeeId: emp.id,
                name: emp.name,
                teamName: emp.team?.name ?? null,
                isPresent: s?.isPresent ?? false,
                isCurrentlyActive: emp.isCurrentlyWorking && emp.lastSeenAt && (Date.now() - new Date(emp.lastSeenAt).getTime()) < 10 * 60 * 1000,
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

    async getAttendanceTimeline(orgId: string, date: Date, teamId?: string) {
        const dayStart = toUtcDay(date);
        const dayEnd = new Date(dayStart.getTime() + 86400000);

        const empWhere = { orgId, deletedAt: null, status: 'active', ...(teamId ? { teamId } : {}) };
        const employees = await this.db.employee.findMany({
            where: empWhere,
            select: { id: true, name: true, team: { select: { name: true } } },
            orderBy: { name: 'asc' },
        });

        const events = await this.db.activityEvent.findMany({
            where: {
                orgId,
                eventType: 'App',
                receivedAt: { gte: dayStart, lt: dayEnd },
                employeeId: { in: employees.map(e => e.id) },
            },
            select: { employeeId: true, appName: true, productivityStatus: true, startTime: true, endTime: true, durationSeconds: true, receivedAt: true },
            orderBy: { receivedAt: 'asc' },
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
            segments: (byEmployee.get(e.id) ?? []).map(ev => ({
                appName: ev.appName,
                productivityStatus: ev.productivityStatus,
                startTime: ev.startTime ?? ev.receivedAt,
                endTime: ev.endTime ?? new Date(((ev.startTime ?? ev.receivedAt)).getTime() + ((ev.durationSeconds ?? 60) * 1000)),
                durationSeconds: ev.durationSeconds,
            })),
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

function toUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
