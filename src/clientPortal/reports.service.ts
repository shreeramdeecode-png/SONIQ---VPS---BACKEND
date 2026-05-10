import type { PrismaClient } from '@prisma/client';

export class ReportsService {
    constructor(private readonly db: PrismaClient) {}

    async getProductivityTrend(orgId: string, from: Date, to: Date, teamId?: string) {
        const where = {
            orgId,
            summaryDate: { gte: from, lte: to },
            ...(teamId ? { teamId } : {}),
        };

        const summaries = await this.db.dailySummary.findMany({ where });

        const byDate = new Map<string, typeof summaries>();
        for (const s of summaries) {
            const key = s.summaryDate.toISOString().slice(0, 10);
            const group = byDate.get(key) ?? [];
            group.push(s);
            byDate.set(key, group);
        }

        return Array.from(byDate.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([dateKey, group]) => {
                const scored = group.filter(s => s.productivityScore != null);
                const avgScore = scored.length > 0
                    ? Math.round((scored.reduce((sum, s) => sum + Number(s.productivityScore!), 0) / scored.length) * 100) / 100
                    : null;
                return {
                    date: dateKey,
                    avgProductivityScore: avgScore,
                    presentCount: group.filter(s => s.isPresent).length,
                    totalWorkSeconds: group.reduce((sum, s) => sum + (s.totalWorkSeconds ?? 0), 0),
                };
            });
    }

    async getAppUsage(orgId: string, from: Date, to: Date, employeeId?: string) {
        const where = {
            orgId,
            startTime: { gte: from, lte: to },
            appName: { not: null },
            durationSeconds: { not: null },
            ...(employeeId ? { employeeId } : {}),
        };

        const events = await this.db.activityEvent.findMany({
            where,
            select: { appName: true, appDomain: true, appCategory: true, productivityStatus: true, durationSeconds: true },
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
                appDomain: meta.appDomain,
                appCategory: meta.appCategory,
                productivityStatus: meta.productivityStatus ?? 'Neutral',
                totalDurationSeconds: totalDuration,
                eventCount: count,
            }))
            .sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds);
    }
}
