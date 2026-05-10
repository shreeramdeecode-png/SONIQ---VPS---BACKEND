import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenService } from '../../src/auth/token.service.js';

const ADMIN_SECRET = 'admin-secret-min-32-chars-padding!!';
const CLIENT_SECRET = 'client-secret-min-32-chars-paddin!!';
const svc = new TokenService(ADMIN_SECRET, CLIENT_SECRET);

describe('TokenService — refresh token', () => {
    it('generates unique tokens each call', () => {
        expect(svc.generateRefreshToken()).not.toBe(svc.generateRefreshToken());
    });

    it('token is base64 string', () => {
        const t = svc.generateRefreshToken();
        expect(() => Buffer.from(t, 'base64')).not.toThrow();
    });

    it('token is at least 64 bytes of entropy', () => {
        const t = svc.generateRefreshToken();
        expect(Buffer.from(t, 'base64').length).toBeGreaterThanOrEqual(64);
    });

    it('hash is deterministic', () => {
        const t = svc.generateRefreshToken();
        expect(svc.hashRefreshToken(t)).toBe(svc.hashRefreshToken(t));
    });

    it('different tokens produce different hashes', () => {
        expect(svc.hashRefreshToken('a')).not.toBe(svc.hashRefreshToken('b'));
    });
});

describe('TokenService — admin token', () => {
    const admin = { id: 'admin-uuid-1', email: 'admin@soniq.io', name: 'Super Admin' };

    it('generates a valid JWT', () => {
        const tok = svc.generateAdminAccessToken(admin);
        expect(() => jwt.verify(tok, ADMIN_SECRET)).not.toThrow();
    });

    it('payload contains expected claims', () => {
        const tok = svc.generateAdminAccessToken(admin);
        const payload = svc.verifyAdminToken(tok);
        expect(payload.sub).toBe(admin.id);
        expect(payload.email).toBe(admin.email);
        expect(payload.role).toBe('super_admin');
        expect(payload.jti).toBeTruthy();
    });

    it('different calls produce different jti', () => {
        const t1 = svc.verifyAdminToken(svc.generateAdminAccessToken(admin));
        const t2 = svc.verifyAdminToken(svc.generateAdminAccessToken(admin));
        expect(t1.jti).not.toBe(t2.jti);
    });

    it('rejects token signed with wrong secret', () => {
        const tok = jwt.sign({ sub: 'x' }, 'wrong-secret');
        expect(() => svc.verifyAdminToken(tok)).toThrow();
    });
});

describe('TokenService — client token', () => {
    const args = {
        employeeId: 'emp-uuid-1',
        orgId: 'org-uuid-1',
        email: 'emp@company.com',
        name: 'John Employee',
        roleName: 'Admin',
    };

    it('generates a valid JWT', () => {
        const tok = svc.generateClientAccessToken(args);
        expect(() => jwt.verify(tok, CLIENT_SECRET)).not.toThrow();
    });

    it('payload contains expected claims', () => {
        const tok = svc.generateClientAccessToken(args);
        const payload = svc.verifyClientToken(tok);
        expect(payload.sub).toBe(args.employeeId);
        expect(payload.org_id).toBe(args.orgId);
        expect(payload.email).toBe(args.email);
        expect(payload.role).toBe(args.roleName);
    });

    it('admin token rejected by client verifier', () => {
        const adminTok = svc.generateAdminAccessToken({ id: 'x', email: 'a@b.com', name: 'A' });
        expect(() => svc.verifyClientToken(adminTok)).toThrow();
    });
});
