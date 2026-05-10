import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PasswordService } from '../auth/password.service.js';

const db = new PrismaClient();
const passwords = new PasswordService();

const email = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@soniq.io';
const password = process.env['SEED_ADMIN_PASSWORD'] ?? 'Admin@123!';
const name = process.env['SEED_ADMIN_NAME'] ?? 'Super Admin';

const existing = await db.superAdmin.findFirst({ where: { email } });
if (existing) {
    console.log(`Admin ${email} already exists.`);
} else {
    await db.superAdmin.create({
        data: {
            id: randomUUID(),
            email,
            name,
            passwordHash: await passwords.hash(password),
            isActive: true,
            updatedAt: new Date(),
        },
    });
    console.log(`✓ Admin created: ${email} / ${password}`);
}
await db.$disconnect();
