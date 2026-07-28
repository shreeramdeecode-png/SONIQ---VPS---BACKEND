import type { FastifyInstance } from 'fastify';
import type { ClientAuthService } from '../../auth/clientAuth.service.js';
import { resolveScope } from '../../utils/roleScope.js';

export async function clientAuthRoutes(app: FastifyInstance, authService: ClientAuthService) {
    const auth = app.authenticate('client');

    app.post('/api/auth/login', async (req, reply) => {
        const { email, password } = req.body as { email: string; password: string };
        const result = await authService.login(email, password);
        return reply.send(result);
    });

    // Current user's live role/scope/permissions — the frontend calls this on load so
    // permission-grid changes take effect on reload without needing to log in again.
    app.get('/api/client/me', { preHandler: [auth] }, async (req, reply) => {
        const emp = await app.prisma.employee.findUnique({
            where: { id: req.actorId },
            select: { id: true, name: true, email: true, teamId: true, role: { select: { name: true, permissions: true, isSystemDefault: true } } },
        });
        if (!emp) return reply.status(404).send({ error: 'Not found' });
        return reply.send({
            employeeId: emp.id,
            orgId: req.orgId,
            name: emp.name,
            email: emp.email,
            role: emp.role.name,
            scope: resolveScope(emp.role.name),
            teamId: emp.teamId ?? null,
            permissions: emp.role.permissions,
            isAdmin: emp.role.isSystemDefault,
        });
    });

    app.post('/api/auth/refresh', async (req, reply) => {
        const { refreshToken } = req.body as { refreshToken: string };
        const result = await authService.refresh(refreshToken);
        return reply.send(result);
    });

    app.post('/api/auth/logout', async (req, reply) => {
        const { refreshToken } = req.body as { refreshToken: string };
        await authService.logout(refreshToken);
        return reply.status(204).send();
    });

    app.post('/api/auth/forgot-password', async (req, reply) => {
        const { email } = req.body as { email: string };
        await authService.sendForgotPasswordOtp(email);
        return reply.send({ message: 'If this email is registered, an OTP has been sent.' });
    });

    app.post('/api/auth/verify-otp', async (req, reply) => {
        const { email, otp } = req.body as { email: string; otp: string };
        const resetToken = await authService.verifyOtp(email, otp);
        return reply.send({ resetToken });
    });

    app.post('/api/auth/reset-password', async (req, reply) => {
        const { resetToken, newPassword } = req.body as { resetToken: string; newPassword: string };
        await authService.resetPassword(resetToken, newPassword);
        return reply.status(204).send();
    });
}
