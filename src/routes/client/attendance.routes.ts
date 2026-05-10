import type { FastifyInstance } from 'fastify';
import type { AttendanceService } from '../../clientPortal/attendance.service.js';

export async function clientAttendanceRoutes(app: FastifyInstance, svc: AttendanceService) {
    const auth = app.authenticate('client');

    app.get('/api/client/attendance/daily', { preHandler: [auth] }, async (req) => {
        const q = req.query as Record<string, string>;
        const date = q['date'] ? new Date(q['date']) : new Date();
        return svc.getDailyAttendance(req.orgId, date, q['teamId']);
    });

    app.get('/api/client/attendance/employees/:id', { preHandler: [auth] }, async (req) => {
        const { id } = req.params as { id: string };
        const q = req.query as Record<string, string>;
        const from = new Date(q['from'] ?? new Date().toISOString().slice(0, 10));
        const to = new Date(q['to'] ?? new Date().toISOString().slice(0, 10));
        return svc.getEmployeeAttendance(req.orgId, id, from, to);
    });
}
