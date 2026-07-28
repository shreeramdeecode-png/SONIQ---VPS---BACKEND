import type { FastifyInstance } from 'fastify';
import type { ReportsService } from '../../clientPortal/reports.service.js';
import { scopeForRequest } from '../../utils/roleScope.js';
import { createModuleGuard } from '../../middleware/permissions.js';
import { MODULE_INDEX, LEVEL } from '../../utils/modulePerms.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// Date-only strings (YYYY-MM-DD) from frontend IST browsers → align to IST day UTC boundaries
function istDayStart(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS); }
function istDayEnd(s: string): Date { return new Date(new Date(s).getTime() - IST_OFFSET_MS + 86400000); }

export async function clientReportRoutes(app: FastifyInstance, svc: ReportsService) {
    const auth = app.authenticate('client');
    const guard = createModuleGuard(app.prisma);
    const view = guard(MODULE_INDEX.reports, LEVEL.VIEW);
    // The hourly heatmap also powers the Dashboard's Peak Hours card.
    const dashOrReports = guard([MODULE_INDEX.dashboard, MODULE_INDEX.reports], LEVEL.VIEW);

    app.get('/api/client/reports/productivity-trend', { preHandler: [auth, view] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        const { empIds, teamId } = await scopeForRequest(app.prisma, req, q['teamId']);
        return svc.getProductivityTrend(req.orgId, from, to, teamId, empIds);
    });

    // App usage also powers the employee's own Profile page (App Usage tab) — allow
    // Dashboard access too; data is scope-filtered so a self user only sees their own.
    app.get('/api/client/reports/app-usage', { preHandler: [auth, dashOrReports] }, async (req) => {
        const q = req.query as Record<string, string>;
        const fromStr = q['from'] ?? new Date().toISOString().slice(0, 10);
        const toStr = q['to'] ?? new Date().toISOString().slice(0, 10);
        const from = istDayStart(fromStr);
        const to = istDayEnd(toStr);
        const { empIds } = await scopeForRequest(app.prisma, req);
        return svc.getAppUsage(req.orgId, from, to, q['employeeId'], empIds);
    });

    app.get('/api/client/reports/hourly-heatmap', { preHandler: [auth, dashOrReports] }, async (req) => {
        const q = req.query as Record<string, string>;
        const fromStr = q['from'] ?? new Date().toISOString().slice(0, 10);
        const toStr = q['to'] ?? new Date().toISOString().slice(0, 10);
        const { empIds, teamId } = await scopeForRequest(app.prisma, req, q['teamId']);
        return svc.getHourlyHeatmap(req.orgId, istDayStart(fromStr), istDayEnd(toStr), q['employeeId'], teamId, empIds);
    });

    app.get('/api/client/reports/focus-sessions', { preHandler: [auth, view] }, async (req) => {
        const q = req.query as Record<string, string>;
        const fromStr = q['from'] ?? new Date().toISOString().slice(0, 10);
        const toStr = q['to'] ?? new Date().toISOString().slice(0, 10);
        const { empIds, teamId } = await scopeForRequest(app.prisma, req, q['teamId']);
        return svc.getFocusMetrics(req.orgId, istDayStart(fromStr), istDayEnd(toStr), teamId, empIds);
    });

    app.get('/api/client/reports/effort', { preHandler: [auth, view] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        const { empIds, teamId } = await scopeForRequest(app.prisma, req, q['teamId']);
        return svc.getEffortUtilization(req.orgId, from, to, teamId, empIds);
    });

    app.get('/api/client/reports/attendance', { preHandler: [auth, view] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        const { empIds, teamId } = await scopeForRequest(app.prisma, req, q['teamId']);
        return svc.getAttendanceReport(req.orgId, from, to, teamId, empIds);
    });

    app.get('/api/client/reports/timesheet', { preHandler: [auth, view] }, async (req) => {
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        const { empIds } = await scopeForRequest(app.prisma, req);
        return svc.getTimesheetReport(req.orgId, from, to, q['employeeId'], empIds);
    });

    app.get('/api/client/reports/export', { preHandler: [auth, view] }, async (req, reply) => {
        const q = req.query as Record<string, string>;
        const type = (q['type'] ?? 'productivity') as 'productivity' | 'app-usage' | 'effort' | 'attendance' | 'timesheet';
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        const { empIds, teamId } = await scopeForRequest(app.prisma, req, q['teamId']);
        const csv = await svc.exportReportCsv(req.orgId, type, from, to, {
            teamId, employeeId: q['employeeId'], empIds,
        });
        const filename = `${type}-report-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`;
        return reply
            .header('Content-Type', 'text/csv')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(csv);
    });
}
