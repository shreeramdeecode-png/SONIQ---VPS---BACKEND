import type { FastifyInstance } from 'fastify';
import type { AttendanceService } from '../../clientPortal/attendance.service.js';

function parseDate(s: string | undefined): Date {
    if (!s) return new Date();
    const d = new Date(s);
    if (isNaN(d.getTime())) throw Object.assign(new Error(`Invalid date: ${s}`), { statusCode: 400 });
    return d;
}

export async function clientAttendanceRoutes(app: FastifyInstance, svc: AttendanceService) {
    const auth = app.authenticate('client');

    app.get('/api/client/attendance/daily', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const date = parseDate(q['date']);
        return svc.getDailyAttendance(req.orgId, date, q['teamId']);
    });

    app.get('/api/client/attendance/employees/:id', { preHandler: [auth] }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const q = req.query as Record<string, string>;
        const from = parseDate(q['from']);
        const to = parseDate(q['to']);
        if (from > to) return reply.status(400).send({ error: 'from must be before to' });
        return svc.getEmployeeAttendance(req.orgId, id, from, to);
    });

    app.get('/api/client/attendance/timeline', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const date = parseDate(q['date']);
        return svc.getAttendanceTimeline(req.orgId, date, q['teamId'], q['employeeId']);
    });

    app.get('/api/client/attendance/export', { preHandler: [auth] }, async (req, reply) => {
        const q = req.query as Record<string, string>;
        const date = parseDate(q['date']);
        const csv = await svc.exportAttendanceCsv(req.orgId, date, q['teamId']);
        const filename = `attendance-${date.toISOString().slice(0, 10)}.csv`;
        return reply
            .header('Content-Type', 'text/csv')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(csv);
    });
}
