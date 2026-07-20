import type { FastifyInstance } from 'fastify';
import type { ReportsService } from '../../clientPortal/reports.service.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// Date-only strings (YYYY-MM-DD) from frontend IST browsers → align to IST day UTC boundaries
function istDayStart(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS); }
function istDayEnd(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS + 86400000); }

export async function clientReportRoutes(app: FastifyInstance, svc: ReportsService) {
    const auth = app.authenticate('client');

    app.get('/api/client/reports/productivity-trend', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        return svc.getProductivityTrend(req.orgId, from, to, q['teamId']);
    });

    app.get('/api/client/reports/app-usage', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const fromStr = q['from'] ?? new Date().toISOString().slice(0, 10);
        const toStr = q['to'] ?? new Date().toISOString().slice(0, 10);
        const from = istDayStart(fromStr);
        const to = istDayEnd(toStr);
        return svc.getAppUsage(req.orgId, from, to, q['employeeId']);
    });

    app.get('/api/client/reports/hourly-heatmap', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const fromStr = q['from'] ?? new Date().toISOString().slice(0, 10);
        const toStr = q['to'] ?? new Date().toISOString().slice(0, 10);
        return svc.getHourlyHeatmap(req.orgId, istDayStart(fromStr), istDayEnd(toStr), q['employeeId'], q['teamId']);
    });

    app.get('/api/client/reports/focus-sessions', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const fromStr = q['from'] ?? new Date().toISOString().slice(0, 10);
        const toStr = q['to'] ?? new Date().toISOString().slice(0, 10);
        return svc.getFocusMetrics(req.orgId, istDayStart(fromStr), istDayEnd(toStr), q['teamId']);
    });

    app.get('/api/client/reports/effort', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        return svc.getEffortUtilization(req.orgId, from, to, q['teamId']);
    });

    app.get('/api/client/reports/attendance', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        return svc.getAttendanceReport(req.orgId, from, to, q['teamId']);
    });

    app.get('/api/client/reports/timesheet', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        return svc.getTimesheetReport(req.orgId, from, to, q['employeeId']);
    });

    app.get('/api/client/reports/export', { preHandler: [auth] }, async (req, reply) => {
        const q = req.query as Record<string, string>;
        const type = (q['type'] ?? 'productivity') as 'productivity' | 'app-usage' | 'effort' | 'attendance' | 'timesheet';
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        const csv = await svc.exportReportCsv(req.orgId, type, from, to, {
            teamId: q['teamId'], employeeId: q['employeeId'],
        });
        const filename = `${type}-report-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`;
        return reply
            .header('Content-Type', 'text/csv')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(csv);
    });
}
