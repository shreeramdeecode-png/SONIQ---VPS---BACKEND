import type { PrismaClient } from '@prisma/client';

export class DailySummaryJob {
    constructor(private readonly db: PrismaClient) {}

    async execute(date: Date): Promise<void> {
        const orgs = await this.db.organization.findMany({
            where: { status: 'Active', deletedAt: null },
            select: { id: true },
        });

        for (const org of orgs) {
            const employees = await this.db.employee.findMany({
                where: { orgId: org.id, status: 'active', deletedAt: null },
                select: { id: true },
            });

            for (const emp of employees) {
                await this.aggregateForEmployee(org.id, emp.id, date);
            }
        }
    }

    private async aggregateForEmployee(orgId: string, employeeId: string, date: Date): Promise<void> {
        const rangeStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        const rangeEnd = new Date(rangeStart);
        rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);

        const events = await this.db.activityEvent.findMany({
            where: {
                orgId, employeeId,
                eventType: 'App',
                receivedAt: { gte: rangeStart, lt: rangeEnd },
            },
        });

        if (events.length === 0) return;

        const productive = events
            .filter(e => e.productivityStatus === 'Productive')
            .reduce((s, e) => s + (e.durationSeconds ?? 0), 0);
        const unproductive = events
            .filter(e => e.productivityStatus === 'Unproductive')
            .reduce((s, e) => s + (e.durationSeconds ?? 0), 0);
        const neutral = events
            .filter(e => e.productivityStatus === 'Neutral')
            .reduce((s, e) => s + (e.durationSeconds ?? 0), 0);

        const eventTimes = events.map(e => (e.startTime ?? e.receivedAt).getTime());
        const eventEndTimes = events.map(e => {
            const start = (e.startTime ?? e.receivedAt).getTime();
            return (e.endTime ? e.endTime.getTime() : start + (e.durationSeconds ?? 60) * 1000);
        });
        const firstCheckin = eventTimes.length > 0 ? new Date(Math.min(...eventTimes)) : null;
        const lastCheckout = eventEndTimes.length > 0 ? new Date(Math.max(...eventEndTimes)) : null;
        const totalWork = events.reduce((s, e) => s + (e.durationSeconds ?? 0), 0);

        const denominator = productive + unproductive + neutral;
        const score = denominator > 0
            ? Math.round((productive / denominator) * 100 * 100) / 100 : null;

        const screenshotsCount = await this.db.screenshot.count({
            where: { orgId, employeeId, capturedAt: { gte: rangeStart, lt: rangeEnd } },
        });

        const summaryData = {
            firstCheckin, lastCheckout,
            totalWorkSeconds: totalWork,
            productiveSeconds: productive,
            unproductiveSeconds: unproductive,
            neutralSeconds: neutral,
            idleSeconds: Math.max(0, totalWork - productive - unproductive - neutral),
            productivityScore: score,
            isPresent: true,
            screenshotsCount,
            updatedAt: new Date(),
        };

        const existing = await this.db.dailySummary.findFirst({
            where: { orgId, employeeId, summaryDate: rangeStart },
        });

        if (existing) {
            await this.db.dailySummary.update({ where: { id: existing.id }, data: summaryData });
        } else {
            await this.db.dailySummary.create({
                data: { id: crypto.randomUUID(), orgId, employeeId, summaryDate: rangeStart, ...summaryData },
            });
        }
    }
}
