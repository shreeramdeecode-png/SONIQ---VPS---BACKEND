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
                select: { id: true, teamId: true },
            });

            for (const emp of employees) {
                await this.aggregateForEmployee(org.id, emp.id, emp.teamId, date);
            }
        }

        // Reset isCurrentlyWorking for any employee not seen in the last 10 minutes.
        // activityEvent.job.ts sets it to true on every heartbeat but never sets it back;
        // this cron (runs every 5 min) is the cleanup pass.
        const tenMinutesAgo = new Date(date.getTime() - 10 * 60 * 1000);
        await this.db.employee.updateMany({
            where: { isCurrentlyWorking: true, lastSeenAt: { lt: tenMinutesAgo } },
            data: { isCurrentlyWorking: false, updatedAt: new Date() },
        });
    }

    private async aggregateForEmployee(orgId: string, employeeId: string, teamId: string | null, date: Date): Promise<void> {
        // IST-aligned day boundary to match appEvent.job.ts
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(date.getTime() + IST_OFFSET_MS);
        const rangeStart = new Date(Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()));
        const utcWindowStart = new Date(rangeStart.getTime() - IST_OFFSET_MS);
        const utcWindowEnd = new Date(utcWindowStart.getTime() + 24 * 60 * 60 * 1000);

        const candidates = await this.db.activityEvent.findMany({
            where: {
                orgId, employeeId,
                receivedAt: { gte: utcWindowStart, lt: utcWindowEnd },
            },
        });

        const events = candidates.filter(e => {
            const effectiveTime = e.startTime ?? e.receivedAt;
            const effectiveIst = new Date(effectiveTime.getTime() + IST_OFFSET_MS);
            const effectiveDayStart = new Date(Date.UTC(effectiveIst.getUTCFullYear(), effectiveIst.getUTCMonth(), effectiveIst.getUTCDate()));
            return effectiveDayStart.getTime() === rangeStart.getTime();
        });

        if (events.length === 0) return;

        const appEvents = events.filter(e => e.eventType === 'App');
        let productive = appEvents
            .filter(e => e.productivityStatus === 'Productive')
            .reduce((s, e) => s + (e.durationSeconds ?? 0), 0);
        let unproductive = appEvents
            .filter(e => e.productivityStatus === 'Unproductive')
            .reduce((s, e) => s + (e.durationSeconds ?? 0), 0);
        let neutral = appEvents
            .filter(e => e.productivityStatus === 'Neutral')
            .reduce((s, e) => s + (e.durationSeconds ?? 0), 0);

        // Build activity segments: use actual endTime or startTime+duration, never receivedAt as end.
        // receivedAt is webhook delivery time, not activity end — using it inflates totalWork when
        // Trackpilots is restarted hours after the last real event.
        const GAP_THRESHOLD_MS = 15 * 60 * 1000; // gaps < 15 min are continuous work

        const rawSegments: { start: number; end: number }[] = [];
        for (const e of events) {
            const start = (e.startTime ?? e.receivedAt).getTime();
            let end: number;
            if (e.endTime) {
                end = e.endTime.getTime();
            } else if (e.startTime && e.durationSeconds) {
                end = e.startTime.getTime() + e.durationSeconds * 1000;
            } else {
                continue; // no reliable end time — skip from segment calculation
            }
            if (end > start) rawSegments.push({ start, end });
        }

        rawSegments.sort((a, b) => a.start - b.start);

        // Merge segments where the gap between consecutive ones is under the threshold
        const merged: { start: number; end: number }[] = [];
        for (const seg of rawSegments) {
            const last = merged[merged.length - 1];
            if (last && seg.start - last.end <= GAP_THRESHOLD_MS) {
                last.end = Math.max(last.end, seg.end);
            } else {
                merged.push({ ...seg });
            }
        }

        const totalWork = merged.reduce((sum, s) => sum + Math.floor((s.end - s.start) / 1000), 0);

        const clockInTimes = events
            .filter(e => {
                if (e.eventType !== 'Activity') return false;
                const wm = (e.rawPayload as any)?.data?.activity?.workMode;
                return wm === true || (typeof wm === 'string' && wm.length > 0);
            })
            .map(e => (e.startTime ?? e.receivedAt).getTime());

        // firstCheckin: earliest clock-in (workMode event) or earliest segment start
        const firstCheckinMs = clockInTimes.length > 0
            ? Math.min(...clockInTimes)
            : (merged.length > 0 ? merged[0].start : Date.now());
        const firstCheckin = new Date(firstCheckinMs);

        // lastCheckout: end of the last active segment (not receivedAt)
        const lastCheckout = merged.length > 0
            ? new Date(merged[merged.length - 1].end)
            : new Date(firstCheckinMs);

        const explicitTotal = productive + unproductive + neutral;
        if (explicitTotal === 0 && totalWork > 0 && appEvents.length > 0) {
            const prodCount = appEvents.filter(e => e.productivityStatus === 'Productive').length;
            const unprodCount = appEvents.filter(e => e.productivityStatus === 'Unproductive').length;
            const total = appEvents.length;
            productive = Math.round((prodCount / total) * totalWork);
            unproductive = Math.round((unprodCount / total) * totalWork);
            neutral = totalWork - productive - unproductive;
        }

        const denominator = productive + unproductive + neutral;
        const score = denominator > 0
            ? Math.round((productive / denominator) * 100 * 100) / 100 : null;

        const screenshotsCount = await this.db.screenshot.count({
            where: { orgId, employeeId, capturedAt: { gte: utcWindowStart, lt: utcWindowEnd } },
        });

        // isLate: compare firstCheckin in IST against expectedInTime (stored as Postgres TIME = UTC h/m)
        const [workHourSetting, orgDefault] = await Promise.all([
            this.db.expectedWorkHoursSetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        const expectedInTimeDate = workHourSetting?.expectedInTime ?? orgDefault?.defaultExpectedInTime;
        let isLate = false;
        if (expectedInTimeDate) {
            const expMins = expectedInTimeDate.getUTCHours() * 60 + expectedInTimeDate.getUTCMinutes();
            const checkinIst = new Date(firstCheckin.getTime() + IST_OFFSET_MS);
            const checkinMins = checkinIst.getUTCHours() * 60 + checkinIst.getUTCMinutes();
            isLate = checkinMins > expMins + 5; // 5-minute grace period
        }

        const summaryData = {
            teamId,
            firstCheckin, lastCheckout,
            totalWorkSeconds: totalWork,
            productiveSeconds: productive,
            unproductiveSeconds: unproductive,
            neutralSeconds: neutral,
            idleSeconds: Math.max(0, totalWork - productive - unproductive - neutral),
            productivityScore: score,
            isPresent: true,
            isLate,
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
