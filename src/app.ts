import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { S3Client } from '@aws-sdk/client-s3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLoggerOptions } from './utils/logger.js';
import jwt from 'jsonwebtoken';

import prismaPlugin from './plugins/prisma.plugin.js';
import pgbossPlugin from './plugins/pgboss.plugin.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { registerTenantMiddleware } from './middleware/tenant.js';
import { createPermissionGuard } from './middleware/permissions.js';

import { EncryptionService } from './infrastructure/encryption.service.js';
import { AuditService } from './infrastructure/audit.service.js';
import { PasswordService } from './auth/password.service.js';
import { TokenService } from './auth/token.service.js';
import { AdminAuthService } from './auth/adminAuth.service.js';
import { ClientAuthService } from './auth/clientAuth.service.js';
import { S3Storage } from './infrastructure/storage/s3Storage.js';
import { LocalFileStorage } from './infrastructure/storage/localFileStorage.js';
import { TrackpilotsService } from './infrastructure/agents/trackpilots.service.js';

import { ActivityEventJob } from './infrastructure/jobs/activityEvent.job.js';
import { AppEventJob } from './infrastructure/jobs/appEvent.job.js';
import { ScreenshotEventJob } from './infrastructure/jobs/screenshotEvent.job.js';
import { DailySummaryJob } from './infrastructure/jobs/dailySummary.job.js';

import { OrgManagementService } from './superAdmin/orgManagement.service.js';
import { AgentSyncService } from './superAdmin/agentSync.service.js';
import { DashboardService } from './superAdmin/dashboard.service.js';
import { PlatformSettingsService } from './superAdmin/platformSettings.service.js';

import { ClientDashboardService } from './clientPortal/clientDashboard.service.js';
import { TeamService } from './clientPortal/team.service.js';
import { EmployeeService } from './clientPortal/employee.service.js';
import { RoleService } from './clientPortal/role.service.js';
import { AttendanceService } from './clientPortal/attendance.service.js';
import { ScreenshotService } from './clientPortal/screenshot.service.js';
import { ReportsService } from './clientPortal/reports.service.js';
import { OrgSettingsService } from './clientPortal/orgSettings.service.js';

import { adminAuthRoutes } from './routes/admin/auth.routes.js';
import { adminOrgRoutes } from './routes/admin/orgs.routes.js';
import { adminDashboardRoutes } from './routes/admin/dashboard.routes.js';
import { clientAuthRoutes } from './routes/client/auth.routes.js';
import { clientDashboardRoutes } from './routes/client/dashboard.routes.js';
import { clientTeamRoutes } from './routes/client/teams.routes.js';
import { clientEmployeeRoutes } from './routes/client/employees.routes.js';
import { clientAttendanceRoutes } from './routes/client/attendance.routes.js';
import { clientScreenshotRoutes } from './routes/client/screenshots.routes.js';
import { clientReportRoutes } from './routes/client/reports.routes.js';
import { clientOrgSettingsRoutes } from './routes/client/orgSettings.routes.js';
import { clientIntegrationRoutes } from './routes/client/integration.routes.js';
import { webhookRoutes } from './routes/webhook.routes.js';
import { setupLiveStatusHub } from './hubs/liveStatus.hub.js';

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

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: getLoggerOptions() });

    await app.register(cors, {
       origin: ['https://soniq.deecodes.io'],
    credentials: true,
    });

    // ── Raw body capture (required for webhook HMAC validation) ──────────────
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
        (req as any).rawBody = body as Buffer;
        try {
            done(null, JSON.parse((body as Buffer).toString('utf8')));
        } catch (e) {
            done(e as Error, undefined);
        }
    });

    await app.register(prismaPlugin);
    await app.register(pgbossPlugin);

    const adminSecret = getEnv('JWT_SECRET_SUPERADMIN');
    const clientSecret = getEnv('JWT_SECRET_CLIENT');

    // ── JWT auth decorator ────────────────────────────────────────────────────
    app.decorate('authenticate', (scheme: 'admin' | 'client') =>
        async (req: FastifyRequest, reply: FastifyReply) => {
            const header = req.headers.authorization;
            if (!header?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Unauthorized' });
            const token = header.slice(7);
            const secret = scheme === 'admin' ? adminSecret : clientSecret;
            try {
                const decoded = jwt.verify(token, secret) as Record<string, any>;
                req.user = decoded;
                if (decoded['org_id']) {
                    req.orgId = decoded['org_id'] as string;
                    req.actorId = (decoded['sub'] as string) ?? '';
                }
            } catch {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
        });

    // ── Services ──────────────────────────────────────────────────────────────
    const encryption = new EncryptionService(getEnv('ENCRYPTION_KEY'));
    const audit = new AuditService(app.prisma);
    const passwords = new PasswordService();
    const tokens = new TokenService(adminSecret, clientSecret);

    const adminAuth = new AdminAuthService(app.prisma, tokens, passwords);
    const clientAuth = new ClientAuthService(app.prisma, tokens, passwords);

    const r2Key = process.env['R2_ACCESS_KEY'];
    const r2Secret = process.env['R2_SECRET_KEY'];
    const r2Endpoint = process.env['R2_ENDPOINT'];
    const r2Bucket = process.env['R2_BUCKET_NAME'] ?? 'soniq-screenshots';

    const storage = r2Key && r2Secret && r2Endpoint
        ? new S3Storage(
            new S3Client({
                endpoint: r2Endpoint, forcePathStyle: true, region: 'auto',
                credentials: { accessKeyId: r2Key, secretAccessKey: r2Secret },
            }),
            r2Bucket,
        )
        : new LocalFileStorage(join(__dirname, '..', 'screenshots'));

    const trackpilots = new TrackpilotsService(
        process.env['TRACKPILOTS_BASE_URL'] ?? 'https://api.trackpilots.com',
        app.prisma, encryption,
    );

    // SuperAdmin
    const orgMgmt = new OrgManagementService(app.prisma, audit, encryption);
    const agentSync = new AgentSyncService(app.prisma, trackpilots, audit, passwords);
    const dashboard = new DashboardService(app.prisma);
    const platformSettings = new PlatformSettingsService(app.prisma, audit);

    // Client Portal
    const clientDashboard = new ClientDashboardService(app.prisma);
    const teams = new TeamService(app.prisma, audit, trackpilots);
    const employees = new EmployeeService(app.prisma, audit, passwords, trackpilots);
    const roles = new RoleService(app.prisma, audit);
    const attendance = new AttendanceService(app.prisma);
    const screenshots = new ScreenshotService(app.prisma, storage);
    const reports = new ReportsService(app.prisma);
    const orgSettings = new OrgSettingsService(app.prisma, audit, trackpilots);

    // ── Middleware ────────────────────────────────────────────────────────────
    // Serve locally-stored screenshots
    app.get('/screenshots/*', async (req, reply) => {
        const { createReadStream } = await import('node:fs');
        const { join: pjoin } = await import('node:path');
        const key = (req.params as any)['*'];
        const filePath = pjoin(__dirname, '..', 'screenshots', ...key.split('/'));
        return reply.type('image/jpeg').send(createReadStream(filePath));
    });

    registerErrorHandler(app);
    registerTenantMiddleware(app);

    const perm = createPermissionGuard(app.prisma);

    // ── Health check ─────────────────────────────────────────────────────────
    app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

    // ── Routes ────────────────────────────────────────────────────────────────
    await adminAuthRoutes(app, adminAuth);
    await adminOrgRoutes(app, orgMgmt, agentSync);
    await adminDashboardRoutes(app, dashboard, platformSettings);

    await clientAuthRoutes(app, clientAuth);
    await clientDashboardRoutes(app, clientDashboard);
    await clientTeamRoutes(app, teams);
    await clientEmployeeRoutes(app, employees, perm);
    await clientAttendanceRoutes(app, attendance);
    await clientScreenshotRoutes(app, screenshots);
    await clientReportRoutes(app, reports);
    await clientOrgSettingsRoutes(app, orgSettings, roles);
    await clientIntegrationRoutes(app, app.prisma, agentSync, encryption);

    await webhookRoutes(app, app.prisma, app.boss, encryption);

    // ── Background jobs ───────────────────────────────────────────────────────
    // Jobs are registered after the server starts (needs io instance)
    // See registerJobs() called after app.listen() in main entry

    return app;
}

// ── Jobs registration (called after server starts so io is available) ────────
export async function registerJobs(
    app: FastifyInstance,
    storage: LocalFileStorage | S3Storage,
): Promise<void> {
    const clientSecret = getEnv('JWT_SECRET_CLIENT');
    const io = setupLiveStatusHub(app.server, clientSecret);

    const activityJob = new ActivityEventJob(app.prisma, io);
    const appJob = new AppEventJob(app.prisma, io);
    const screenshotJob = new ScreenshotEventJob(app.prisma, storage);
    const dailySummaryJob = new DailySummaryJob(app.prisma);

    // pg-boss v10 handlers — each worker processes one job at a time so failures are isolated
    app.boss.work('activity-tracking', { batchSize: 1 }, async (jobs) => {
        const job = jobs[0];
        try {
            await activityJob.execute(job.data as any);
        } catch (err) {
            app.log.error({ err, jobId: job.id }, 'activity-tracking job failed');
            throw err;
        }
    });

    app.boss.work('app-tracking', { batchSize: 1 }, async (jobs) => {
        const job = jobs[0];
        try {
            await appJob.execute(job.data as any);
        } catch (err) {
            app.log.error({ err, jobId: job.id }, 'app-tracking job failed');
            throw err;
        }
    });

    // Screenshot processing: teamSize:1 for isolation, retries configured at send time
    app.boss.work('screenshot-processing', { batchSize: 1 }, async (jobs) => {
        const job = jobs[0];
        try {
            await screenshotJob.execute(job.data as any);
        } catch (err) {
            app.log.error({ err, jobId: job.id }, 'screenshot-processing job failed');
            throw err;
        }
    });

    app.boss.work('daily-aggregation', { batchSize: 1 }, async (jobs) => {
        const job = jobs[0];
        try {
            const date = new Date((job.data as any).date ?? Date.now());
            await dailySummaryJob.execute(date);
        } catch (err) {
            app.log.error({ err, jobId: job.id }, 'daily-aggregation job failed');
            throw err;
        }
    });

    // Recurring daily summary — every 5 minutes, guard against duplicate schedule on restart
    try {
        await app.boss.createQueue('daily-summary-cron');
    } catch { /* queue already exists — fine */ }
    try {
        await app.boss.schedule('daily-summary-cron', '*/5 * * * *');
    } catch { /* schedule already exists — fine */ }
    app.boss.work('daily-summary-cron', async () => {
        try {
            await dailySummaryJob.execute(new Date());
        } catch (err) {
            app.log.error({ err }, 'daily-summary-cron failed');
            throw err;
        }
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Only start server when this file is run directly (not imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const r2Key = process.env['R2_ACCESS_KEY'];
    const r2Secret = process.env['R2_SECRET_KEY'];
    const r2Endpoint = process.env['R2_ENDPOINT'];
    const r2Bucket = process.env['R2_BUCKET_NAME'] ?? 'soniq-screenshots';

    const storage = r2Key && r2Secret && r2Endpoint
        ? new S3Storage(
            new S3Client({
                endpoint: r2Endpoint, forcePathStyle: true, region: 'auto',
                credentials: { accessKeyId: r2Key, secretAccessKey: r2Secret },
            }),
            r2Bucket,
        )
        : new LocalFileStorage(join(__dirname, '..', 'screenshots'));

    const app = await buildApp();
    await app.listen({ port: Number(process.env['PORT'] ?? 5000), host: '0.0.0.0' });
    await registerJobs(app, storage);
}
