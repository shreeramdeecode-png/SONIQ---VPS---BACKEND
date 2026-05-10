import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { S3Client } from '@aws-sdk/client-s3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

import prismaPlugin from './plugins/prisma.plugin.js';
import pgbossPlugin from './plugins/pgboss.plugin.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { registerTenantMiddleware } from './middleware/tenant.js';

import { EncryptionService } from './infrastructure/encryption.service.js';
import { PasswordService } from './auth/password.service.js';
import { TokenService } from './auth/token.service.js';
import { AdminAuthService } from './auth/adminAuth.service.js';
import { ClientAuthService } from './auth/clientAuth.service.js';
import { S3Storage } from './infrastructure/storage/s3Storage.js';
import { LocalFileStorage } from './infrastructure/storage/localFileStorage.js';
import { TrackpilotsService } from './infrastructure/agents/trackpilots.service.js';

import { adminAuthRoutes } from './routes/admin/auth.routes.js';
import { clientAuthRoutes } from './routes/client/auth.routes.js';

import './types/fastify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

declare module 'fastify' {
    interface FastifyInstance {
        authenticate(scheme: 'admin' | 'client'): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
}

async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: true });

    await app.register(prismaPlugin);
    await app.register(pgbossPlugin);

    const adminSecret = getEnv('JWT_SECRET_SUPERADMIN');
    const clientSecret = getEnv('JWT_SECRET_CLIENT');

    app.decorate('authenticate', (scheme: 'admin' | 'client') =>
        async (req: FastifyRequest, reply: FastifyReply) => {
            const header = req.headers.authorization;
            if (!header?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Unauthorized' });
            const token = header.slice(7);
            const secret = scheme === 'admin' ? adminSecret : clientSecret;
            try {
                req.user = jwt.verify(token, secret) as Record<string, unknown>;
            } catch {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
        });

    const encryption = new EncryptionService(getEnv('ENCRYPTION_KEY'));
    const passwords = new PasswordService();
    const tokens = new TokenService(adminSecret, clientSecret);

    const adminAuth = new AdminAuthService(app.prisma, tokens, passwords);
    const clientAuth = new ClientAuthService(app.prisma, tokens, passwords);

    const r2Key = process.env['R2_ACCESS_KEY'];
    const r2Secret = process.env['R2_SECRET_KEY'];
    const r2Endpoint = process.env['R2_ENDPOINT'];
    const r2Bucket = process.env['R2_BUCKET_NAME'] ?? 'soniq-screenshots';

    const _storage = r2Key && r2Secret && r2Endpoint
        ? new S3Storage(
            new S3Client({
                endpoint: r2Endpoint, forcePathStyle: true, region: 'auto',
                credentials: { accessKeyId: r2Key, secretAccessKey: r2Secret },
            }),
            r2Bucket,
        )
        : new LocalFileStorage(join(__dirname, '..', 'screenshots'));

    const _trackpilots = new TrackpilotsService(
        process.env['TRACKPILOTS_BASE_URL'] ?? 'https://api.trackpilots.com',
        app.prisma,
        encryption,
    );

    registerErrorHandler(app);
    registerTenantMiddleware(app);

    await adminAuthRoutes(app, adminAuth);
    await clientAuthRoutes(app, clientAuth);

    return app;
}

const app = await buildApp();
await app.listen({ port: Number(process.env['PORT'] ?? 5000), host: '0.0.0.0' });
