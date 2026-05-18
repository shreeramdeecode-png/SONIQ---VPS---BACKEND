import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding database...');

    // ── 1. SuperAdmin ─────────────────────────────────────────────────────────
    const adminPassword = await bcrypt.hash('Admin@123', 10);
    const admin = await prisma.superAdmin.upsert({
        where: { email: 'admin@soniq.com' },
        update: {},
        create: {
            id: randomUUID(),
            name: 'Super Admin',
            email: 'admin@soniq.com',
            passwordHash: adminPassword,
            isActive: true,
            updatedAt: new Date(),
        },
    });
    console.log(`✓ SuperAdmin: ${admin.email}`);

    // ── 2. Organization ───────────────────────────────────────────────────────
    const orgId = randomUUID();
    const org = await prisma.organization.upsert({
        where: { id: orgId },
        update: {},
        create: {
            id: orgId,
            name: 'Acme Corp',
            contactEmail: 'owner@acme.com',
            industry: 'Technology',
            timezone: 'Asia/Kolkata',
            status: 'Active',
            updatedAt: new Date(),
        },
    });
    console.log(`✓ Organization: ${org.name} (${org.id})`);

    // ── 3. Subscription ───────────────────────────────────────────────────────
    await prisma.subscription.upsert({
        where: { orgId: org.id },
        update: {},
        create: {
            id: randomUUID(),
            orgId: org.id,
            planName: 'pro',
            monthlyAmount: 99.00,
            billingCycle: 'monthly',
            maxEmployees: 50,
            maxStorageGb: 100,
            dataRetentionDays: 90,
            featuresEnabled: {},
            startedAt: new Date(),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            status: 'active',
            updatedAt: new Date(),
        },
    });
    console.log(`✓ Subscription: pro plan`);

    // ── 4. Org Default Settings ───────────────────────────────────────────────
    await prisma.orgDefaultSetting.upsert({
        where: { orgId: org.id },
        update: {},
        create: {
            id: randomUUID(),
            orgId: org.id,
            defaultWorkDays: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
            defaultWorkHoursPerDay: 8.0,
            defaultProductiveHoursPerDay: 6.0,
            defaultScreenshotEnabled: true,
            defaultBlurEnabled: false,
            defaultCaptureIntervalMinutes: 10,
            defaultIdleAlertEnabled: true,
            defaultMinIdleTimeMinutes: 5,
            defaultStealthEnabled: false,
            timezone: 'Asia/Kolkata',
            updatedAt: new Date(),
        },
    });
    console.log(`✓ Org default settings`);

    // ── 5. Role ───────────────────────────────────────────────────────────────
    const role = await prisma.role.upsert({
        where: { orgId_name: { orgId: org.id, name: 'Admin' } },
        update: {},
        create: {
            id: randomUUID(),
            orgId: org.id,
            name: 'Admin',
            permissions: ['manage_employees', 'manage_teams', 'view_reports', 'manage_settings'],
            isSystemDefault: true,
            updatedAt: new Date(),
        },
    });
    console.log(`✓ Role: ${role.name}`);

    // ── 6. Team ───────────────────────────────────────────────────────────────
    const teamId = randomUUID();
    const team = await prisma.team.upsert({
        where: { id: teamId },
        update: {},
        create: {
            id: teamId,
            orgId: org.id,
            name: 'Engineering',
            updatedAt: new Date(),
        },
    });
    console.log(`✓ Team: ${team.name}`);

    // ── 7. Employee + ClientAuth ──────────────────────────────────────────────
    const employeeId = randomUUID();
    const employeePassword = await bcrypt.hash('Employee@123', 10);

    const employee = await prisma.employee.upsert({
        where: { id: employeeId },
        update: {},
        create: {
            id: employeeId,
            orgId: org.id,
            teamId: team.id,
            roleId: role.id,
            name: 'John Doe',
            email: 'john@acme.com',
            designation: 'Software Engineer',
            status: 'active',
            updatedAt: new Date(),
        },
    });

    await prisma.clientAuth.upsert({
        where: { employeeId: employee.id },
        update: {},
        create: {
            id: randomUUID(),
            employeeId: employee.id,
            orgId: org.id,
            email: 'john@acme.com',
            passwordHash: employeePassword,
            passwordSet: true,
            updatedAt: new Date(),
        },
    });
    console.log(`✓ Employee: ${employee.name} / john@acme.com`);

    console.log('\nSeed complete! Login credentials:');
    console.log('  Admin  → admin@soniq.com  / Admin@123');
    console.log('  Client → john@acme.com    / Employee@123');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
