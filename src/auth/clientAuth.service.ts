import NodeCache from 'node-cache';
import type { PrismaClient } from '@prisma/client';
import type { TokenService } from './token.service.js';
import type { PasswordService } from './password.service.js';

const OTP_TTL_SECONDS = 600;   // 10 min
const RESET_TTL_SECONDS = 900; // 15 min

const cache = new NodeCache({ useClones: false });

export interface ClientLoginResponse {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    passwordSet: boolean;
    profile: { employeeId: string; orgId: string; name: string; email: string; role: string };
}

export interface ClientRefreshResponse {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
}

export class ClientAuthService {
    constructor(
        private readonly db: PrismaClient,
        private readonly tokens: TokenService,
        private readonly passwords: PasswordService,
    ) {}

    async login(email: string, password: string): Promise<ClientLoginResponse> {
        const auth = await this.db.clientAuth.findFirst({
            where: { email: email.toLowerCase() },
            include: { employee: { include: { role: true } } },
        });

        if (!auth || !(await this.passwords.verify(password, auth.passwordHash))) {
            throw Object.assign(new Error('Invalid email or password.'), { statusCode: 401 });
        }

        if (auth.employee.deletedAt || auth.employee.status === 'inactive') {
            throw Object.assign(new Error('Account is inactive.'), { statusCode: 401 });
        }

        const { accessToken, refreshToken, expiresAt } = await this.issueTokens(auth);
        return {
            accessToken,
            refreshToken,
            expiresAt,
            passwordSet: auth.passwordSet,
            profile: {
                employeeId: auth.employeeId,
                orgId: auth.orgId,
                name: auth.employee.name,
                email: auth.email,
                role: auth.employee.role.name,
            },
        };
    }

    async refresh(refreshToken: string): Promise<ClientRefreshResponse> {
        const hash = this.tokens.hashRefreshToken(refreshToken);
        const auth = await this.db.clientAuth.findFirst({
            where: { refreshTokenHash: hash },
            include: { employee: { include: { role: true } } },
        });

        if (!auth || !auth.refreshTokenExpiresAt || auth.refreshTokenExpiresAt < new Date()) {
            throw Object.assign(new Error('Invalid or expired refresh token.'), { statusCode: 401 });
        }

        const { accessToken, refreshToken: newRefresh, expiresAt } = await this.issueTokens(auth);
        return { accessToken, refreshToken: newRefresh, expiresAt };
    }

    async logout(refreshToken: string): Promise<void> {
        const hash = this.tokens.hashRefreshToken(refreshToken);
        const auth = await this.db.clientAuth.findFirst({ where: { refreshTokenHash: hash } });
        if (!auth) return;

        await this.db.clientAuth.update({
            where: { id: auth.id },
            data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
        });
    }

    async sendForgotPasswordOtp(email: string): Promise<void> {
        const auth = await this.db.clientAuth.findFirst({ where: { email: email.toLowerCase() } });
        if (!auth) return; // avoid email enumeration

        const otp = String(Math.floor(100000 + Math.random() * 900000));
        cache.set(otpKey(email), otp, OTP_TTL_SECONDS);

        // TODO: replace with real email service (Resend, etc.)
        console.log(`[OTP] ${email} → ${otp}`);
    }

    async verifyOtp(email: string, otp: string): Promise<string> {
        const key = otpKey(email.toLowerCase());
        const cached = cache.get<string>(key);
        if (!cached || cached !== otp) {
            throw Object.assign(new Error('Invalid or expired OTP.'), { statusCode: 401 });
        }
        cache.del(key);

        const resetToken = this.tokens.generateRefreshToken();
        cache.set(resetKey(resetToken), email.toLowerCase(), RESET_TTL_SECONDS);
        return resetToken;
    }

    async resetPassword(resetToken: string, newPassword: string): Promise<void> {
        const rKey = resetKey(resetToken);
        const email = cache.get<string>(rKey);
        if (!email) {
            throw Object.assign(new Error('Invalid or expired reset token.'), { statusCode: 401 });
        }

        const auth = await this.db.clientAuth.findFirst({ where: { email } });
        if (!auth) throw Object.assign(new Error('Account not found.'), { statusCode: 401 });

        await this.db.clientAuth.update({
            where: { id: auth.id },
            data: {
                passwordHash: await this.passwords.hash(newPassword),
                passwordSet: true,
                refreshTokenHash: null,
                refreshTokenExpiresAt: null,
            },
        });
        cache.del(rKey);
    }

    private async issueTokens(auth: {
        id: string;
        employeeId: string;
        orgId: string;
        email: string;
        employee: { name: string; role: { name: string } };
    }) {
        const accessToken = this.tokens.generateClientAccessToken({
            employeeId: auth.employeeId,
            orgId: auth.orgId,
            email: auth.email,
            name: auth.employee.name,
            roleName: auth.employee.role.name,
        });
        const refreshToken = this.tokens.generateRefreshToken();
        const expiresAt = this.tokens.clientTokenExpiresAt();

        await this.db.clientAuth.update({
            where: { id: auth.id },
            data: {
                refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
                refreshTokenExpiresAt: this.tokens.refreshTokenExpiresAt(),
                lastLoginAt: new Date(),
            },
        });

        return { accessToken, refreshToken, expiresAt };
    }
}

const otpKey = (email: string) => `otp:${email}`;
const resetKey = (token: string) => `reset:${token}`;
