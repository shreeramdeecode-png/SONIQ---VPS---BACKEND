import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_SIZE = 12;
const TAG_SIZE = 16;

export class EncryptionService {
    private readonly key: Buffer;

    constructor(keyBase64: string) {
        this.key = Buffer.from(keyBase64, 'base64');
        if (this.key.length !== 32) {
            throw new Error('Encryption key must be a base64-encoded 32-byte (256-bit) value');
        }
    }

    encrypt(plaintext: string): string {
        const nonce = randomBytes(NONCE_SIZE);
        const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag(); // 16 bytes
        return Buffer.concat([nonce, ct, tag]).toString('base64');
    }

    decrypt(ciphertext: string): string {
        const buf = Buffer.from(ciphertext, 'base64');
        const nonce = buf.subarray(0, NONCE_SIZE);
        const tag = buf.subarray(buf.length - TAG_SIZE);
        const ct = buf.subarray(NONCE_SIZE, buf.length - TAG_SIZE);
        const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    }
}
