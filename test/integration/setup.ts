import { execSync } from 'node:child_process';
import { Client } from 'pg';

export async function setupTestDb(): Promise<() => Promise<void>> {
    const testDbName = `soniq_test_${Date.now()}`;

    // Connect as the app user itself (requires CREATEDB privilege — run once:
    // ALTER USER <your_db_user> CREATEDB;)
    const baseUrl  = process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
    const adminUrl = baseUrl.replace(/\/[^/\?]+(\?.*)?$/, '/postgres$1');
    const testUrl  = baseUrl.replace(/\/[^/\?]+(\?.*)?$/, `/${testDbName}$1`);

    // Create isolated test DB — app user becomes owner automatically
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${testDbName}"`);
    await admin.end();

    // Point all env vars at the test DB
    process.env['DATABASE_URL']           = testUrl;
    process.env['JWT_SECRET_CLIENT']      = 'test-client-secret-minimum-32-chars!!';
    process.env['JWT_SECRET_SUPERADMIN']  = 'test-admin-secret-minimum-32-chars!!';
    process.env['ENCRYPTION_KEY']         = Buffer.alloc(32).toString('base64');
    process.env['TRACKPILOTS_BASE_URL']   = 'https://api.trackpilots.com';

    // Apply schema via Prisma (cross-platform, no dotnet ef needed)
    execSync('npx prisma db push --skip-generate', {
        env: { ...process.env, DATABASE_URL: testUrl },
        stdio: 'pipe',
    });

    return async () => {
        const cleanup = new Client({ connectionString: adminUrl });
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
        await cleanup.end();
    };
}
