import type { PrismaClient } from '@prisma/client';

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
                select: { id: true, name: true, team: { select: { name: true } } },
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
}
