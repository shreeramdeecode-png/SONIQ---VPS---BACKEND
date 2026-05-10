import type { FastifyInstance } from 'fastify';
import type { AdminAuthService } from '../../auth/adminAuth.service.js';

export async function adminAuthRoutes(app: FastifyInstance, authService: AdminAuthService) {
    app.post('/api/admin/auth/login', async (req, reply) => {
        const { email, password } = req.body as { email: string; password: string };
        const result = await authService.login(email, password);
        return reply.send(result);
    });

    app.post('/api/admin/auth/refresh', async (req, reply) => {
        const { refreshToken } = req.body as { refreshToken: string };
        const result = await authService.refresh(refreshToken);
        return reply.send(result);
    });

    app.post('/api/admin/auth/logout', async (req, reply) => {
        const { refreshToken } = req.body as { refreshToken: string };
        await authService.logout(refreshToken);
        return reply.status(204).send();
    });

    app.get('/api/admin/auth/validate', {
        preHandler: [app.authenticate('admin')],
    }, async (req, reply) => {
        return reply.send({ valid: true, user: req.user });
    });
}
