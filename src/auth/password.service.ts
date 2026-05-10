import bcrypt from 'bcryptjs';

const WORK_FACTOR = 12;

export class PasswordService {
    async hash(plaintext: string): Promise<string> {
        return bcrypt.hash(plaintext, WORK_FACTOR);
    }

    async verify(plaintext: string, hash: string): Promise<boolean> {
        return bcrypt.compare(plaintext, hash);
    }
}
