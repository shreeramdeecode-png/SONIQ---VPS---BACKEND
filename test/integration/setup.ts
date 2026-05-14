import { execSync } from 'node:child_process';
import { Client } from 'pg';

export async function setupTestDb(): Promise<() => Promise<void>> {
    const testDbName = `soniq_test_${Date.now()}`;

    // Use TEST_DB_ADMIN_URL if set (needed when the app DB user lacks CREATEDB).
    // Falls back to DATABASE_URL with the db replaced by 'postgres'.
    const baseUrl  = process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
    const adminUrl = process.env['TEST_DB_ADMIN_URL']
        ?? baseUrl.replace(/\/[^/\?]+(\?.*)?$/, '/postgres$1');
    const testUrl  = baseUrl.replace(/\/[^/\?]+(\?.*)?$/, `/${testDbName}$1`);

    // Extract the app username from DATABASE_URL so the test DB is owned by it
    const appUser = new URL(baseUrl).username;

    // Create isolated test DB using pg client (no psql binary needed)
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${testDbName}" OWNER "${appUser}"`);
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
        await cleanup.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
        await cleanup.end();
    };
}
