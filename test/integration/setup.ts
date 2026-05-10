import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function setupTestDb(): Promise<() => Promise<void>> {
    // Use dedicated test database on the same PG18 instance
    const testDbName = `soniq_test_${Date.now()}`;
    const adminConnStr = `postgresql://postgres:Admin@123@localhost:5433/postgres`;
    const testConnStr = `postgresql://postgres:Admin@123@localhost:5433/${testDbName}`;

    // Create isolated test DB
    execSync(
        `"C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -h 127.0.0.1 -p 5433 -U postgres ` +
        `-c "CREATE DATABASE ${testDbName};"`,
        { env: { ...process.env, PGPASSWORD: 'Admin@123' } },
    );

    // Apply schema via EF migrations
    execSync(
        `dotnet ef database update ` +
        `--project src/Soniq.Infrastructure/Soniq.Infrastructure.csproj ` +
        `--startup-project src/Soniq.API/Soniq.API.csproj`,
        {
            cwd: 'C:\\Users\\PS\\Gokul\\SoniQ',
            env: {
                ...process.env,
                ConnectionStrings__Default:
                    `Host=localhost;Port=5433;Database=${testDbName};Username=postgres;Password=Admin@123`,
            },
        },
    );

    // Point Prisma at the test DB
    process.env['DATABASE_URL'] = testConnStr;
    process.env['JWT_SECRET_CLIENT'] = 'test-client-secret-minimum-32-chars!!';
    process.env['JWT_SECRET_SUPERADMIN'] = 'test-admin-secret-minimum-32-chars!!';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32).toString('base64');
    process.env['TRACKPILOTS_BASE_URL'] = 'https://api.trackpilots.com';

    return async () => {
        execSync(
            `"C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -h 127.0.0.1 -p 5433 -U postgres ` +
            `-c "DROP DATABASE IF EXISTS ${testDbName};"`,
            { env: { ...process.env, PGPASSWORD: 'Admin@123' } },
        );
    };
}
