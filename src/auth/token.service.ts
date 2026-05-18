import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';

const ADMIN_ACCESS_TOKEN_HOURS = 8;
const CLIENT_ACCESS_TOKEN_HOURS = 4;
const REFRESH_TOKEN_DAYS = 30;

export interface AdminTokenPayload {
    sub: string;
    email: string;
    name: string;
    role: 'super_admin';
    jti: string;
}

export interface ClientTokenPayload {
    sub: string;
    email: string;
    name: string;
    org_id: string;
    role: string;
    jti: string;
}

export class TokenService {
    constructor(
        private readonly adminSecret: string,
        private readonly clientSecret: string,
    ) {}

    generateAdminAccessToken(admin: { id: string; email: string; name: string }): string {
        const payload: Omit<AdminTokenPayload, 'jti'> & { jti: string } = {
            sub: admin.id,
            email: admin.email,
            name: admin.name,
            role: 'super_admin',
            jti: randomBytes(16).toString('hex'),
        };
        return jwt.sign(payload, this.adminSecret, { expiresIn: `${ADMIN_ACCESS_TOKEN_HOURS}h` });
    }

    generateClientAccessToken(args: {
        employeeId: string;
        orgId: string;
        email: string;
        name: string;
        roleName: string;
    }): string {
        const payload: ClientTokenPayload = {
            sub: args.employeeId,
            email: args.email,
            name: args.name,
            org_id: args.orgId,
            role: args.roleName,
            jti: randomBytes(16).toString('hex'),
        };
        return jwt.sign(payload, this.clientSecret, { expiresIn: `${CLIENT_ACCESS_TOKEN_HOURS}h` });
    }

    generateRefreshToken(): string {
        return randomBytes(64).toString('base64');
    }

    hashRefreshToken(token: string): string {
        return createHash('sha256').update(token, 'utf8').digest('base64');
    }

    verifyAdminToken(token: string): AdminTokenPayload {
        return jwt.verify(token, this.adminSecret) as AdminTokenPayload;
    }

    verifyClientToken(token: string): ClientTokenPayload {
        return jwt.verify(token, this.clientSecret) as ClientTokenPayload;
    }

    adminTokenExpiresAt(): Date {
        return new Date(Date.now() + ADMIN_ACCESS_TOKEN_HOURS * 60 * 60 * 1000);
    }

    clientTokenExpiresAt(): Date {
        return new Date(Date.now() + CLIENT_ACCESS_TOKEN_HOURS * 60 * 60 * 1000);
    }

    refreshTokenExpiresAt(): Date {
        // Called on every token issue (login + refresh) — this makes the window sliding
        const d = new Date();
        d.setDate(d.getDate() + REFRESH_TOKEN_DAYS);
        return d;
    }
}
