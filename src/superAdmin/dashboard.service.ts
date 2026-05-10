import type { PrismaClient } from '@prisma/client';

export class DashboardService {
    constructor(private readonly db: PrismaClient) {}

    async getStats() {
        const monthStart = new Date(Date.UTC(
            new Date().getUTCFullYear(), new Date().getUTCMonth(), 1,
        ));

        const [orgs, totalEmployees, newEmployeesThisMonth, totalMrr] = await Promise.all([
            this.db.organization.findMany({ where: { deletedAt: null } }),
            this.db.employee.count({ where: { deletedAt: null } }),
            this.db.employee.count({ where: { deletedAt: null, createdAt: { gte: monthStart } } }),
            this.db.subscription.aggregate({
                where: { status: 'active' },
                _sum: { monthlyAmount: true },
            }),
        ]);

        return {
            totalOrgs: orgs.length,
            activeOrgs: orgs.filter(o => o.status === 'Active').length,
            trialOrgs: orgs.filter(o => o.status === 'Trial').length,
            suspendedOrgs: orgs.filter(o => o.status === 'Suspended').length,
            newOrgsThisMonth: orgs.filter(o => o.createdAt >= monthStart).length,
            totalEmployees,
            newEmployeesThisMonth,
            totalMrr: totalMrr._sum.monthlyAmount ?? 0,
        };
    }
}
