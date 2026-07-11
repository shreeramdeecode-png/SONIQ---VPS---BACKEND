import type { FastifyInstance } from 'fastify';
import type { ClientDashboardService } from '../../clientPortal/clientDashboard.service.js';

function parseDate(s: string | undefined): Date {
    if (!s) return new Date();
    const d = new Date(s);
    if (isNaN(d.getTime())) throw Object.assign(new Error(`Invalid date: ${s}`), { statusCode: 400 });
    return d;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// For date-only strings (YYYY-MM-DD from frontend IST browsers), convert to UTC equivalent
// of IST midnight start / end so receivedAt queries cover the full local day.
function toIstDayStart(s: string | undefined): Date {
    const raw = parseDate(s);
    return s?.length === 10 ? new Date(raw.getTime() - IST_OFFSET_MS) : raw;
}

function toIstDayEnd(s: string | undefined): Date {
    const raw = parseDate(s);
    return s?.length === 10 ? new Date(raw.getTime() - IST_OFFSET_MS + 86400000) : raw;
}

export async function clientDashboardRoutes(app: FastifyInstance, svc: ClientDashboardService) {
    const auth = app.authenticate('client');

    app.get('/api/client/dashboard/stats', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        // from/to (YYYY-MM-DD) scope the productivity metrics; omitted → today only.
        // The service applies toDateOnly() to IST-align these to summaryDate keys.
        const from = q['from'] ? parseDate(q['from']) : undefined;
        const to = q['to'] ? parseDate(q['to']) : undefined;
        return svc.getTodayStats(req.orgId, q['teamId'], from, to);
    });

    app.get('/api/client/dashboard/top-productive', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getTopProductive(req.orgId, parseDate(q['date']), Number(q['limit'] ?? 5), q['teamId']);
    });

    app.get('/api/client/dashboard/top-unproductive', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getTopUnproductive(req.orgId, parseDate(q['date']), Number(q['limit'] ?? 5), q['teamId']);
    });

    app.get('/api/client/dashboard/top-apps', { preHandler: [auth] }, async (req, reply) => {
        const q = req.query as Record<string, string>;
        // Date-only strings (YYYY-MM-DD) are IST local dates; shift to IST day boundaries
        // so events throughout the IST day are included in receivedAt queries
        const from = toIstDayStart(q['from']);
        const to = toIstDayEnd(q['to']);
        if (from > to) return reply.status(400).send({ error: 'from must be before to' });
        return svc.getTopApps(req.orgId, from, to, Number(q['limit'] ?? 10), q['teamId']);
    });

    app.get('/api/client/dashboard/activity-table', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getTodayActivityTable(req.orgId, parseDate(q['date']), q['teamId']);
    });

    app.get('/api/client/dashboard/work-hour-chart', { preHandler: [auth] }, async (req, reply) => {
        const q = req.query as Record<string, string>;
        const from = parseDate(q['from']);
        const to = parseDate(q['to']);
        if (from > to) return reply.status(400).send({ error: 'from must be before to' });
        return svc.getWorkHourChart(req.orgId, from, to, q['teamId']);
    });

    app.get('/api/client/dashboard/work-mode-summary', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getWorkModeSummary(req.orgId, q['teamId']);
    });

    app.get('/api/client/dashboard/wellbeing', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getWellbeingSignals(req.orgId, Number(q['days'] ?? 7), q['teamId']);
    });

    app.get('/api/client/dashboard/recent-screenshots', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getRecentScreenshots(req.orgId, Number(q['limit'] ?? 20), q['teamId']);
    });

    app.get('/api/client/dashboard/team-comparison', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        return svc.getTeamComparison(req.orgId, parseDate(q['date']));
    });
}
