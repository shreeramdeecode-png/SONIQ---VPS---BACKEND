import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupTestDb } from './setup.js';
import { buildApp } from '../../src/app.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let teardown: () => Promise<void>;

beforeAll(async () => {
    teardown = await setupTestDb();

    app = await buildApp();

    // Seed an admin directly into the test DB
    const db = new PrismaClient();
    const passwords = new PasswordService();
    await db.superAdmin.create({
        data: {
            id: randomUUID(),
            email: 'admin@test.io',
            name: 'Test Admin',
            passwordHash: await passwords.hash('TestPass@123!'),
            isActive: true,
            updatedAt: new Date(),
        },
    });
    await db.$disconnect();
}, 120000);

afterAll(async () => {
    await app.close();
    await teardown();
});

describe('Admin auth', () => {
    it('POST /api/admin/auth/login with valid credentials → 200 + tokens', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/auth/login',
            body: { email: 'admin@test.io', password: 'TestPass@123!' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.accessToken).toBeTruthy();
        expect(body.refreshToken).toBeTruthy();
        expect(body.admin.email).toBe('admin@test.io');
    });

    it('POST /api/admin/auth/login with wrong password → 401', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/auth/login',
            body: { email: 'admin@test.io', password: 'wrongpassword' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('POST /api/admin/auth/login with unknown email → 401', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/auth/login',
            body: { email: 'nobody@test.io', password: 'any' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/admin/dashboard/stats without token → 401', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/admin/dashboard/stats' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/admin/dashboard/stats with valid token → 200', async () => {
        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/admin/auth/login',
            body: { email: 'admin@test.io', password: 'TestPass@123!' },
        });
        const { accessToken } = loginRes.json();

        const res = await app.inject({
            method: 'GET',
            url: '/api/admin/dashboard/stats',
            headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toHaveProperty('totalOrgs');
    });

    it('POST /api/admin/auth/refresh → 200 + new tokens', async () => {
        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/admin/auth/login',
            body: { email: 'admin@test.io', password: 'TestPass@123!' },
        });
        const { refreshToken } = loginRes.json();

        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/auth/refresh',
            body: { refreshToken },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().accessToken).toBeTruthy();
    });

    it('Admin token rejected by client endpoint → 401', async () => {
        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/admin/auth/login',
            body: { email: 'admin@test.io', password: 'TestPass@123!' },
        });
        const { accessToken } = loginRes.json();

        const res = await app.inject({
            method: 'GET',
            url: '/api/client/dashboard/stats',
            headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(res.statusCode).toBe(401);
    });
});

describe('Client auth', () => {
    it('POST /api/auth/login with non-existent email → 401', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            body: { email: 'nobody@example.com', password: 'any' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/client/employees without token → 401', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/client/employees' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/client/teams without token → 401', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/client/teams' });
        expect(res.statusCode).toBe(401);
    });
});
