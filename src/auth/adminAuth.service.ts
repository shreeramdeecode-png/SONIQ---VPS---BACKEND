import type { PrismaClient } from '@prisma/client';
import type { TokenService } from './token.service.js';
import type { PasswordService } from './password.service.js';

export interface AdminLoginResponse {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    admin: { id: string; name: string; email: string };
}

export interface AdminRefreshResponse {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
}

export class AdminAuthService {
    constructor(
        private readonly db: PrismaClient,
        private readonly tokens: TokenService,
        private readonly passwords: PasswordService,
    ) {}

    async login(email: string, password: string): Promise<AdminLoginResponse> {
        const admin = await this.db.superAdmin.findFirst({
            where: { email: email.toLowerCase() },
        });

        if (!admin || !admin.isActive || !(await this.passwords.verify(password, admin.passwordHash))) {
            throw Object.assign(new Error('Invalid email or password.'), { statusCode: 401 });
        }

        const { accessToken, refreshToken, expiresAt } = await this.issueTokens(admin);
        return { accessToken, refreshToken, expiresAt, admin: { id: admin.id, name: admin.name, email: admin.email } };
    }

    async refresh(refreshToken: string): Promise<AdminRefreshResponse> {
        const hash = this.tokens.hashRefreshToken(refreshToken);
        const admin = await this.db.superAdmin.findFirst({ where: { refreshTokenHash: hash } });

        if (!admin || !admin.refreshTokenExpiresAt || admin.refreshTokenExpiresAt < new Date()) {
            throw Object.assign(new Error('Invalid or expired refresh token.'), { statusCode: 401 });
        }

        const { accessToken, refreshToken: newRefresh, expiresAt } = await this.issueTokens(admin);
        return { accessToken, refreshToken: newRefresh, expiresAt };
    }

    async logout(refreshToken: string): Promise<void> {
        const hash = this.tokens.hashRefreshToken(refreshToken);
        const admin = await this.db.superAdmin.findFirst({ where: { refreshTokenHash: hash } });
        if (!admin) return;

        await this.db.superAdmin.update({
            where: { id: admin.id },
            data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
        });
    }

    private async issueTokens(admin: { id: string; email: string; name: string }) {
        const accessToken = this.tokens.generateAdminAccessToken(admin);
        const refreshToken = this.tokens.generateRefreshToken();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        await this.db.superAdmin.update({
            where: { id: admin.id },
            data: {
                refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
                refreshTokenExpiresAt: this.tokens.refreshTokenExpiresAt(),
                lastLoginAt: new Date(),
            },
        });

        return { accessToken, refreshToken, expiresAt };
    }
}
