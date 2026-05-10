import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import type { PrismaClient } from '@prisma/client';
import type { EncryptionService } from '../encryption.service.js';

export interface AgentTeam { id: string; name: string }
export interface AgentEmployee { id: string; email: string; name: string; teamId?: string | null }
export interface AgentPermission { module: string; level: string }
export interface AgentRole { id: string; name: string; permissions: AgentPermission[] }

export interface AgentWorkDaySettings {
    monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean;
    friday: boolean; saturday: boolean; sunday: boolean;
}
export interface AgentWorkHourSettings {
    expectedWorkHoursPerDay: number;
    expectedProductiveHoursPerDay: number;
    expectedInTime: string; // "HH:mm"
}
export interface AgentScreenshotSettings {
    screenCaptureEnabled: boolean;
    blurEnabled: boolean;
    captureIntervalMinutes: number;
}
export interface AgentIdleAlertSettings {
    idleAlertEnabled: boolean;
    minIdleTimeMinutes: number;
}
export interface AgentDefaultSettings {
    workDays: AgentWorkDaySettings;
    workHoursPerDay: number;
    productiveHoursPerDay: number;
    expectedInTime: string;
    screenshot: AgentScreenshotSettings;
    idleAlert: AgentIdleAlertSettings;
    stealthEnabled: boolean;
    timezone: string;
}

export class TrackpilotsService {
    private readonly http: AxiosInstance;

    constructor(
        baseUrl: string,
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionService,
    ) {
        this.http = axios.create({ baseURL: baseUrl });
        axiosRetry(this.http, {
            retries: 3,
            retryDelay: axiosRetry.exponentialDelay,
            retryCondition: (err) =>
                axiosRetry.isNetworkError(err) ||
                (err.response != null && err.response.status >= 500),
        });
    }

    // ── Teams ─────────────────────────────────────────────────────────────────

    async fetchAllTeams(orgId: string): Promise<AgentTeam[]> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.get(`organisations/${extOrgId}/teams`, { headers: this.auth(apiKey) });
        return data.teams.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }));
    }

    async createTeam(orgId: string, name: string): Promise<AgentTeam> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.post(`organisations/${extOrgId}/teams`, { name }, { headers: this.auth(apiKey) });
        return { id: data.team.id, name: data.team.name };
    }

    async updateTeam(orgId: string, externalTeamId: string, name: string): Promise<AgentTeam> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.put(`organisations/${extOrgId}/teams/${externalTeamId}`, { name }, { headers: this.auth(apiKey) });
        return { id: data.team.id, name: data.team.name };
    }

    async deleteTeam(orgId: string, externalTeamId: string): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.delete(`organisations/${extOrgId}/teams/${externalTeamId}`, { headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Employees ─────────────────────────────────────────────────────────────

    async fetchAllEmployees(orgId: string): Promise<AgentEmployee[]> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.get(`organisations/${extOrgId}/users`, { headers: this.auth(apiKey) });
        return data.users.map((u: { id: string; email: string; name: string; team_id?: string }) =>
            ({ id: u.id, email: u.email, name: u.name, teamId: u.team_id }));
    }

    async addEmployee(orgId: string, email: string, name: string, externalTeamId?: string): Promise<AgentEmployee> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.post(`organisations/${extOrgId}/users`,
            { email, name, team_id: externalTeamId }, { headers: this.auth(apiKey) });
        return { id: data.user.id, email: data.user.email, name: data.user.name, teamId: data.user.team_id };
    }

    async inviteEmployee(orgId: string, email: string, name: string): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.post(`organisations/${extOrgId}/users/invite`,
            { email, name }, { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateEmployee(orgId: string, externalUserId: string, data: { name?: string; externalTeamId?: string }): Promise<AgentEmployee> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data: res } = await this.http.put(`organisations/${extOrgId}/users/${externalUserId}`,
            { name: data.name, team_id: data.externalTeamId }, { headers: this.auth(apiKey) });
        return { id: res.user.id, email: res.user.email, name: res.user.name, teamId: res.user.team_id };
    }

    async deleteEmployee(orgId: string, externalUserId: string): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.delete(`organisations/${extOrgId}/users/${externalUserId}`, { headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    async updateWorkDaySettings(orgId: string, externalUserId: string, s: AgentWorkDaySettings): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.put(
            `organisations/${extOrgId}/users/${externalUserId}/settings/workdays`, s, { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateExpectedWorkHours(orgId: string, externalUserId: string, s: AgentWorkHourSettings): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.put(
            `organisations/${extOrgId}/users/${externalUserId}/settings/workhours`,
            { expected_work_hours_per_day: s.expectedWorkHoursPerDay, expected_productive_hours_per_day: s.expectedProductiveHoursPerDay, expected_in_time: s.expectedInTime },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateScreenshotSettings(orgId: string, externalUserId: string, s: AgentScreenshotSettings): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.put(
            `organisations/${extOrgId}/users/${externalUserId}/settings/screenshot`,
            { screen_capture_enabled: s.screenCaptureEnabled, blur_enabled: s.blurEnabled, capture_interval_minutes: s.captureIntervalMinutes },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateIdleAlertSettings(orgId: string, externalUserId: string, s: AgentIdleAlertSettings): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.put(
            `organisations/${extOrgId}/users/${externalUserId}/settings/idle-alert`,
            { idle_alert_enabled: s.idleAlertEnabled, min_idle_time_minutes: s.minIdleTimeMinutes },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateDefaultSettings(orgId: string, s: AgentDefaultSettings): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.put(`organisations/${extOrgId}/settings`, {
            work_days: s.workDays,
            work_hours_per_day: s.workHoursPerDay,
            productive_hours_per_day: s.productiveHoursPerDay,
            expected_in_time: s.expectedInTime,
            screenshot: { screen_capture_enabled: s.screenshot.screenCaptureEnabled, blur_enabled: s.screenshot.blurEnabled, capture_interval_minutes: s.screenshot.captureIntervalMinutes },
            idle_alert: { idle_alert_enabled: s.idleAlert.idleAlertEnabled, min_idle_time_minutes: s.idleAlert.minIdleTimeMinutes },
            stealth_enabled: s.stealthEnabled,
            timezone: s.timezone,
        }, { headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Roles ─────────────────────────────────────────────────────────────────

    async fetchAccessRoles(orgId: string): Promise<AgentRole[]> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.get(`organisations/${extOrgId}/roles`, { headers: this.auth(apiKey) });
        return data.roles.map(mapRole);
    }

    async createAccessRole(orgId: string, role: Omit<AgentRole, 'id'>): Promise<AgentRole> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.post(`organisations/${extOrgId}/roles`,
            { name: role.name, permissions: role.permissions }, { headers: this.auth(apiKey) });
        return mapRole(data.role);
    }

    async updateAccessRole(orgId: string, externalRoleId: string, role: Omit<AgentRole, 'id'>): Promise<AgentRole> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { data } = await this.http.put(`organisations/${extOrgId}/roles/${externalRoleId}`,
            { name: role.name, permissions: role.permissions }, { headers: this.auth(apiKey) });
        return mapRole(data.role);
    }

    async deleteAccessRole(orgId: string, externalRoleId: string): Promise<boolean> {
        const { extOrgId, apiKey } = await this.getMapping(orgId);
        const { status } = await this.http.delete(`organisations/${extOrgId}/roles/${externalRoleId}`, { headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async getMapping(orgId: string) {
        const mapping = await this.db.agentOrgMapping.findFirst({
            where: { orgId, isActive: true },
        });
        if (!mapping) throw Object.assign(new Error(`No active agent mapping for org ${orgId}`), { statusCode: 404 });
        return { extOrgId: mapping.externalOrgId, apiKey: this.encryption.decrypt(mapping.apiKeyEncrypted) };
    }

    private auth(apiKey: string) {
        return { Authorization: `Bearer ${apiKey}` };
    }
}

const mapRole = (r: { id: string; name: string; permissions: Array<{ module: string; level: string }> }): AgentRole => ({
    id: r.id, name: r.name, permissions: r.permissions.map(p => ({ module: p.module, level: p.level })),
});
