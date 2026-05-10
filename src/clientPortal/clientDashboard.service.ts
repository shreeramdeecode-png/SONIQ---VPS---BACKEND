import type { PrismaClient } from '@prisma/client';

export class ClientDashboardService {
    constructor(private readonly db: PrismaClient) {}

    async getTodayStats(orgId: string) {
        const today = toDateOnly(new Date());

        const [totalEmployees, activeNow, summaries] = await Promise.all([
            this.db.employee.count({ where: { orgId, deletedAt: null, status: 'active' } }),
            this.db.employee.count({ where: { orgId, deletedAt: null, isCurrentlyWorking: true } }),
            this.db.dailySummary.findMany({ where: { orgId, summaryDate: today } }),
        ]);

        const presentToday = summaries.filter(s => s.isPresent).length;
        const scored = summaries.filter(s => s.productivityScore != null);
        const avgScore = scored.length > 0
            ? Math.round((scored.reduce((sum, s) => sum + Number(s.productivityScore!), 0) / scored.length) * 100) / 100
            : 0;
        const totalWorkSeconds = summaries.reduce((sum, s) => sum + (s.totalWorkSeconds ?? 0), 0);

        return { date: today, totalEmployees, activeNow, avgProductivityScore: avgScore, totalWorkSeconds, presentToday };
    }
}

function toDateOnly(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
