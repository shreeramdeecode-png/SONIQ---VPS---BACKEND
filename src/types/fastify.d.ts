import 'fastify';

declare module 'fastify' {
    interface FastifyRequest {
        user: Record<string, unknown>;
    }
}
