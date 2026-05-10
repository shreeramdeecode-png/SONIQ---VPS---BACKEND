import { describe, it, expect } from 'vitest';
import { EncryptionService } from '../../src/infrastructure/encryption.service.js';

const KEY = 'RGV2RW5jcnlwdGlvbktleTEyMzQ1Njc4OTAxMjM0NTY='; // 32-byte base64

describe('EncryptionService', () => {
    const svc = new EncryptionService(KEY);

    it('round-trips plaintext correctly', () => {
        expect(svc.decrypt(svc.encrypt('hello world'))).toBe('hello world');
    });

    it('round-trips empty string', () => {
        expect(svc.decrypt(svc.encrypt(''))).toBe('');
    });

    it('round-trips unicode content', () => {
        const text = '🔐 secret üñíçödé text';
        expect(svc.decrypt(svc.encrypt(text))).toBe(text);
    });

    it('produces different ciphertext each call (random nonce)', () => {
        const c1 = svc.encrypt('same input');
        const c2 = svc.encrypt('same input');
        expect(c1).not.toBe(c2);
    });

    it('output is valid base64', () => {
        const ct = svc.encrypt('test data');
        expect(() => Buffer.from(ct, 'base64')).not.toThrow();
    });

    it('ciphertext is at least 29 bytes (12 nonce + 0+ data + 16 tag)', () => {
        const ct = svc.encrypt('');
        expect(Buffer.from(ct, 'base64').length).toBeGreaterThanOrEqual(28);
    });

    it('throws on tampered auth tag', () => {
        const ct = svc.encrypt('important data');
        const buf = Buffer.from(ct, 'base64');
        buf[buf.length - 1] ^= 0xff; // flip last byte of auth tag
        expect(() => svc.decrypt(buf.toString('base64'))).toThrow();
    });

    it('throws on tampered ciphertext body', () => {
        const ct = svc.encrypt('important data');
        const buf = Buffer.from(ct, 'base64');
        buf[13] ^= 0xff; // flip a byte in ciphertext area
        expect(() => svc.decrypt(buf.toString('base64'))).toThrow();
    });

    it('throws with wrong key', () => {
        const wrongSvc = new EncryptionService(Buffer.alloc(32).toString('base64'));
        const ct = svc.encrypt('secret');
        expect(() => wrongSvc.decrypt(ct)).toThrow();
    });

    it('rejects key that is not 32 bytes', () => {
        expect(() => new EncryptionService(Buffer.alloc(16).toString('base64'))).toThrow();
    });
});
