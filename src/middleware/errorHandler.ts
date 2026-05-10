import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerErrorHandler(app: FastifyInstance) {
    app.setErrorHandler((error, _req: FastifyRequest, reply: FastifyReply) => {
        const err = error as Error & { statusCode?: number };
        const status = err.statusCode ?? 500;
        const message = status >= 500 ? 'Internal server error' : err.message;

        if (status >= 500) {
            app.log.error(error);
        }

        reply.status(status).send({ error: message });
    });
}
