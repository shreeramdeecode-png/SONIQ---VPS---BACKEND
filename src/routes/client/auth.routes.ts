import type { FastifyInstance } from 'fastify';
import type { ClientAuthService } from '../../auth/clientAuth.service.js';

export async function clientAuthRoutes(app: FastifyInstance, authService: ClientAuthService) {
    app.post('/api/auth/login', async (req, reply) => {
        const { email, password } = req.body as { email: string; password: string };
        const result = await authService.login(email, password);
        return reply.send(result);
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
