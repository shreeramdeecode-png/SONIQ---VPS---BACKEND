import fp from 'fastify-plugin';
import PgBoss from 'pg-boss';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
    interface FastifyInstance {
        boss: PgBoss;
    }
}

export default fp(async (app: FastifyInstance) => {
    const boss = new PgBoss(process.env['DATABASE_URL']!);
    await boss.start();
    app.decorate('boss', boss);
    app.addHook('onClose', async () => { await boss.stop(); });
});
