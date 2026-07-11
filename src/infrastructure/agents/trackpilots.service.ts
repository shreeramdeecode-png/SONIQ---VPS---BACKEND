import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import type { PrismaClient } from '@prisma/client';
import type { EncryptionService } from '../encryption.service.js';

export interface AgentTeam { id: string; name: string }
export interface AgentEmployee { id: string; email: string; name: string; teamId?: string | null }
export interface AgentRole {
    id: string;
    name: string;
    permissions: Array<{ path: string; access: string }>;
}

export interface AgentWorkDaySettings {
    workDays: string[]; // e.g. ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
}
export interface AgentWorkHourSettings {
    expectedWorkMinutesPerDay: number;
    expectedProductiveWorkMinutesPerDay: number;
    expectedInTime: string; // "HH:mm"
}
export interface AgentScreenshotSettings {
    enableScreenCapture: boolean;
    enableBlurScreenCapture: boolean;
    screenCaptureIntervalMinutes: number;
}
export interface AgentIdleAlertSettings {
    enableIdleTimeAlert: boolean;
    minimumIdleTimeMinutes: number;
}
export interface AgentStealthSettings {
    enableStealthMonitoring: boolean;
}
export interface AgentDefaultSettings {
    workDays?: string[];
    workHours?: AgentWorkHourSettings;
    screenshot?: AgentScreenshotSettings;
    idleAlert?: AgentIdleAlertSettings;
    stealth?: AgentStealthSettings;
    timezone?: string;
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
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.get('v1/teams', { headers: this.auth(apiKey) });
        return data.data.map((t: { teamId: string; teamName: string }) => ({ id: t.teamId, name: t.teamName }));
    }

    async createTeam(orgId: string, name: string): Promise<AgentTeam> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.post('v1/teams', { teamName: name }, { headers: this.auth(apiKey) });
        return { id: data.data.teamId, name: data.data.teamName };
    }

    async updateTeam(orgId: string, externalTeamId: string, name: string): Promise<AgentTeam> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.patch('v1/teams', { teamId: externalTeamId, teamName: name }, { headers: this.auth(apiKey) });
        return { id: data.data.teamId, name: data.data.teamName };
    }

    async deleteTeam(orgId: string, externalTeamId: string): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.delete('v1/teams', { data: { teamId: externalTeamId }, headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Employees ─────────────────────────────────────────────────────────────

    async fetchAllEmployees(orgId: string): Promise<AgentEmployee[]> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.get('v1/employees', { headers: this.auth(apiKey) });
        return data.data.map((u: { userId: string; emailId: string; userName: string; teamId?: Array<{ teamId: string }> }) => ({
            id: u.userId,
            email: u.emailId,
            name: u.userName,
            teamId: u.teamId?.[0]?.teamId ?? null,
        }));
    }

    async addEmployee(orgId: string, email: string, name: string, roleId: string, teamIds: string[], workMode: 'office' | 'remote' | 'hybrid' = 'office'): Promise<AgentEmployee> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.post('v1/employees',
            { emailId: email, userName: name, roleId, teamId: teamIds, workMode },
            { headers: this.auth(apiKey) });
        return { id: data.response.userId, email: data.response.emailId, name: data.response.userName };
    }

    async inviteEmployee(orgId: string, email: string, name: string, roleId: string, teamIds: string[]): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.post('v1/employees/send-invite-link',
            { emailId: email, userName: name, roleId, teamId: teamIds },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateEmployee(orgId: string, externalUserId: string, data: { name?: string; teamIds?: string[]; roleId?: string; workMode?: string }): Promise<AgentEmployee> {
        const apiKey = await this.getApiKey(orgId);
        const { data: res } = await this.http.patch('v1/employees',
            { userId: externalUserId, userName: data.name, teamId: data.teamIds, roleId: data.roleId, workMode: data.workMode },
            { headers: this.auth(apiKey) });
        return { id: res.response.userId, email: '', name: res.response.userName };
    }

    async deleteEmployee(orgId: string, externalUserId: string): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.delete('v1/employees', { data: { userId: externalUserId }, headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    // NOTE: Trackpilots' per-user settings endpoints expect the settings wrapped in a named object
    // (workDaySettings / workHourSettings / screenshotSettings / idleAlertSettings /
    // stealthMonitoringSettings) alongside a top-level userId — same wrapper keys as default-setting.
    // Sending flat fields returns 400 REQUEST_VALIDATION_FAILED ("expected object, received undefined").

    async updateWorkDaySettings(orgId: string, externalUserId: string, s: AgentWorkDaySettings): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.patch('v1/settings/work-day',
            { userId: externalUserId, workDaySettings: { workDays: s.workDays } },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateExpectedWorkHours(orgId: string, externalUserId: string, s: AgentWorkHourSettings): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.patch('v1/settings/expected-work-hours',
            {
                userId: externalUserId,
                workHourSettings: {
                    expectedWorkMinutesPerDay: s.expectedWorkMinutesPerDay,
                    expectedProductiveWorkMinutesPerDay: s.expectedProductiveWorkMinutesPerDay,
                    expectedInTime: s.expectedInTime,
                },
            },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateScreenshotSettings(orgId: string, externalUserId: string, s: AgentScreenshotSettings): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.patch('v1/settings/screenshot',
            {
                userId: externalUserId,
                screenshotSettings: {
                    enableScreenCapture: s.enableScreenCapture,
                    enableBlurScreenCapture: s.enableBlurScreenCapture,
                    screenCaptureIntervalMinutes: s.screenCaptureIntervalMinutes,
                },
            },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateIdleAlertSettings(orgId: string, externalUserId: string, s: AgentIdleAlertSettings): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.patch('v1/settings/idle-alert',
            {
                userId: externalUserId,
                idleAlertSettings: {
                    minimumIdleTimeMinutes: s.minimumIdleTimeMinutes,
                    enableIdleTimeAlert: s.enableIdleTimeAlert,
                },
            },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateStealthSettings(orgId: string, externalUserId: string, s: AgentStealthSettings): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.patch('v1/settings/stealth-monitoring',
            { userId: externalUserId, stealthMonitoringSettings: { enableStealthMonitoring: s.enableStealthMonitoring } },
            { headers: this.auth(apiKey) });
        return status < 300;
    }

    async updateDefaultSettings(orgId: string, s: AgentDefaultSettings): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const body: Record<string, unknown> = {};
        if (s.workDays) body['workDaySettings'] = { workDays: s.workDays };
        if (s.workHours) body['workHourSettings'] = s.workHours;
        if (s.screenshot) body['screenshotSettings'] = s.screenshot;
        if (s.idleAlert) body['idleAlertSettings'] = s.idleAlert;
        if (s.stealth) body['stealthMonitoringSettings'] = s.stealth;
        if (s.timezone) body['timezoneSettings'] = { timezone: s.timezone };
        const { status } = await this.http.patch('v1/settings/default-setting', body, { headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Settings (GET) ────────────────────────────────────────────────────────

    async fetchEmployeeSettings(orgId: string, externalUserId: string): Promise<{
        workDays?: string[];
        workHours?: AgentWorkHourSettings;
        screenshot?: AgentScreenshotSettings;
        idleAlert?: AgentIdleAlertSettings;
        stealth?: AgentStealthSettings;
    } | null> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.get('v1/settings/employee', {
            params: { userId: externalUserId },
            headers: this.auth(apiKey),
        });
        const d = data?.data ?? data;
        if (!d) return null;
        return {
            workDays: d.workDaySettings?.workDays,
            workHours: d.workHourSettings,
            screenshot: d.screenshotSettings,
            idleAlert: d.idleAlertSettings,
            stealth: d.stealthMonitoringSettings,
        };
    }

    async fetchDefaultSettings(orgId: string): Promise<AgentDefaultSettings | null> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.get('v1/settings/default-setting', {
            headers: this.auth(apiKey),
        });
        const d = data?.data ?? data;
        if (!d) return null;
        return {
            workDays: d.workDaySettings?.workDays,
            workHours: d.workHourSettings,
            screenshot: d.screenshotSettings,
            idleAlert: d.idleAlertSettings,
            stealth: d.stealthMonitoringSettings,
            timezone: d.timezoneSettings?.timezone,
        };
    }

    // ── Roles ─────────────────────────────────────────────────────────────────

    async fetchAccessRoles(orgId: string): Promise<AgentRole[]> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.get('v1/access-management', { headers: this.auth(apiKey) });
        return data.data.map(mapRole);
    }

    async createAccessRole(orgId: string, role: Omit<AgentRole, 'id'>): Promise<AgentRole> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.post('v1/access-management',
            { roleName: role.name, roleData: role.permissions },
            { headers: this.auth(apiKey) });
        return mapRole(data.data);
    }

    async updateAccessRole(orgId: string, externalRoleId: string, role: Omit<AgentRole, 'id'>): Promise<AgentRole> {
        const apiKey = await this.getApiKey(orgId);
        const { data } = await this.http.patch('v1/access-management',
            { roleId: externalRoleId, roleName: role.name, roleData: role.permissions },
            { headers: this.auth(apiKey) });
        return mapRole(data.data);
    }

    async deleteAccessRole(orgId: string, externalRoleId: string): Promise<boolean> {
        const apiKey = await this.getApiKey(orgId);
        const { status } = await this.http.delete('v1/access-management', { data: { roleId: externalRoleId }, headers: this.auth(apiKey) });
        return status < 300;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async getApiKey(orgId: string): Promise<string> {
        const mapping = await this.db.agentOrgMapping.findFirst({
            where: { orgId, isActive: true },
        });
        if (!mapping) throw Object.assign(new Error(`No active agent mapping for org ${orgId}`), { statusCode: 404 });
        return this.encryption.decrypt(mapping.apiKeyEncrypted);
    }

    private auth(apiKey: string) {
        return { Authorization: `Bearer ${apiKey}` };
    }
}

const mapRole = (r: { roleId: string; roleName: string; roleData: Array<{ path: string; access: string }> }): AgentRole => ({
    id: r.roleId,
    name: r.roleName,
    permissions: r.roleData,
});
