import { describe, it, expect } from 'vitest';
import { PasswordService } from '../../src/auth/password.service.js';

describe('PasswordService', () => {
    const svc = new PasswordService();

    it('hash differs from plaintext', async () => {
        const hash = await svc.hash('mypassword');
        expect(hash).not.toBe('mypassword');
    });

    it('hash starts with bcrypt prefix', async () => {
        const hash = await svc.hash('test');
        expect(hash).toMatch(/^\$2[aby]\$/);
    });

    it('verifies correct password', async () => {
        const hash = await svc.hash('correct-password');
        expect(await svc.verify('correct-password', hash)).toBe(true);
    });

    it('rejects wrong password', async () => {
        const hash = await svc.hash('correct-password');
        expect(await svc.verify('wrong-password', hash)).toBe(false);
    });

    it('hash is non-deterministic (different salt each call)', async () => {
        const h1 = await svc.hash('same');
        const h2 = await svc.hash('same');
        expect(h1).not.toBe(h2);
    });

    it('both hashes verify correctly despite being different', async () => {
        const pw = 'same-password';
        const h1 = await svc.hash(pw);
        const h2 = await svc.hash(pw);
        expect(await svc.verify(pw, h1)).toBe(true);
        expect(await svc.verify(pw, h2)).toBe(true);
    });
});
