import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import type { TrackpilotsService } from '../infrastructure/agents/trackpilots.service.js';
import { paged, type PagedResult } from '../types/common.js';
import { randomUUID } from 'node:crypto';

// Helpers for Postgres TIME fields (stored as wall-clock hours/minutes, read back as Date with UTC h/m)
function parseTimeString(s: string): Date {
    const [h = 0, m = 0] = s.split(':').map(Number);
    const d = new Date(0);
    d.setUTCHours(h, m, 0, 0);
    return d;
}

function formatTime(d: Date): string {
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export class EmployeeService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
        private readonly passwords: PasswordService,
        private readonly trackpilots: TrackpilotsService,
    ) {}

    async listEmployees(orgId: string, opts: {
        teamId?: string; search?: string; page?: number; pageSize?: number;
    } = {}): Promise<PagedResult<unknown>> {
        const { teamId, search, page = 1, pageSize = 20 } = opts;
        const where = {
            orgId, deletedAt: null,
            ...(teamId ? { teamId } : {}),
            ...(search ? { OR: [{ name: { contains: search } }, { email: { contains: search } }] } : {}),
        };

        const [total, items] = await Promise.all([
            this.db.employee.count({ where }),
            this.db.employee.findMany({
                where, orderBy: { name: 'asc' },
                skip: (page - 1) * pageSize, take: pageSize,
                include: { team: true, role: true },
            }),
        ]);

        return paged(items.map(e => ({
            id: e.id, name: e.name, email: e.email, designation: e.designation,
            department: e.department, status: e.status, teamId: e.teamId,
            teamName: e.team?.name, roleName: e.role.name,
            isCurrentlyWorking: e.isCurrentlyWorking, lastSeenAt: e.lastSeenAt, createdAt: e.createdAt,
        })), total, page, pageSize);
    }

    async getEmployee(orgId: string, employeeId: string) {
        const e = await this.db.employee.findFirst({
            where: { id: employeeId, orgId, deletedAt: null },
            include: { team: true, role: true },
        });
        if (!e) throw notFound('Employee', employeeId);

        const settings = await this.buildSettings(orgId, employeeId);
        return { ...e, teamName: e.team?.name, roleName: e.role.name, settings };
    }

    async inviteEmployee(orgId: string, actorId: string, req: {
        name: string; email: string; roleId: string; teamId?: string;
        designation?: string; department?: string; workMode?: string;
    }) {
        const exists = await this.db.clientAuth.findFirst({
            where: { email: req.email.toLowerCase(), orgId },
        });
        if (exists) throw Object.assign(
            new Error(`An employee with email ${req.email} already exists.`), { statusCode: 409 });

        const role = await this.db.role.findUnique({ where: { id: req.roleId } });
        if (!role) throw notFound('Role', req.roleId);

        const tempPassword = await this.passwords.hash(randomUUID());
        const employee = await this.db.employee.create({
            data: {
                id: randomUUID(), orgId, name: req.name,
                email: req.email.toLowerCase(),
                roleId: req.roleId,
                teamId: req.teamId,
                designation: req.designation,
                department: req.department,
                workModeType: req.workMode ?? 'Office',
                status: 'active',
                updatedAt: new Date(),
                clientAuth: {
                    create: {
                        id: randomUUID(), orgId,
                        email: req.email.toLowerCase(),
                        passwordHash: tempPassword,
                        passwordSet: false,
                        updatedAt: new Date(),
                    },
                },
            },
            include: { team: true, role: true },
        });

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.invited',
            orgId, targetType: 'Employee', targetId: employee.id, after: employee.email });

        // Best-effort: send invite via Trackpilots
        try {
            const roles = await this.trackpilots.fetchAccessRoles(orgId);
            const tpRoleId = roles.find(r => r.name.toLowerCase() === 'employee')?.id ?? roles[0]?.id ?? '';
            const teamIds: string[] = [];
            if (req.teamId) {
                const tm = await this.db.agentTeamMapping.findFirst({
                    where: { teamId: req.teamId, orgId, agentProvider: 'trackpilots' },
                });
                if (tm) teamIds.push(tm.externalTeamId);
            }
            await this.trackpilots.inviteEmployee(orgId, req.email.toLowerCase(), req.name, tpRoleId, teamIds);
        } catch { /* Trackpilots invite is non-fatal */ }

        const settings = await this.buildSettings(orgId, employee.id);
        return { ...employee, teamName: employee.team?.name, roleName: employee.role.name, settings };
    }

    async updateEmployee(orgId: string, actorId: string, employeeId: string, req: {
        name?: string; designation?: string; department?: string;
        teamId?: string; roleId?: string; workMode?: string;
    }) {
        const e = await this.db.employee.findFirst({
            where: { id: employeeId, orgId, deletedAt: null },
        });
        if (!e) throw notFound('Employee', employeeId);

        const updated = await this.db.employee.update({
            where: { id: employeeId },
            data: {
                ...(req.name && { name: req.name }),
                ...(req.designation && { designation: req.designation }),
                ...(req.department && { department: req.department }),
                ...(req.teamId !== undefined && { teamId: req.teamId }),
                ...(req.roleId && { roleId: req.roleId }),
                ...(req.workMode && { workModeType: req.workMode }),
            },
            include: { team: true, role: true },
        });

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.updated',
            orgId, targetType: 'Employee', targetId: employeeId, after: updated.name });

        // Best-effort: sync profile changes to Trackpilots
        await this.syncToTrackpilots(orgId, employeeId, async (extId) => {
            const teamIds: string[] = [];
            if (updated.teamId) {
                const tm = await this.db.agentTeamMapping.findFirst({
                    where: { teamId: updated.teamId, orgId, agentProvider: 'trackpilots' },
                });
                if (tm) teamIds.push(tm.externalTeamId);
            }
            await this.trackpilots.updateEmployee(orgId, extId, {
                ...(req.name ? { name: req.name } : {}),
                ...(req.workMode ? { workMode: req.workMode } : {}),
                ...(req.teamId !== undefined ? { teamIds } : {}),
            });
        });

        const settings = await this.buildSettings(orgId, employeeId);
        return { ...updated, teamName: updated.team?.name, roleName: updated.role.name, settings };
    }

    async deactivateEmployee(orgId: string, actorId: string, employeeId: string) {
        const e = await this.db.employee.findFirst({ where: { id: employeeId, orgId } });
        if (!e) throw notFound('Employee', employeeId);

        // Best-effort: remove from Trackpilots
        const agentMapping = await this.db.agentEmployeeMapping.findFirst({
            where: { employeeId, orgId, agentProvider: 'trackpilots' },
        });
        if (agentMapping) {
            await this.trackpilots.deleteEmployee(orgId, agentMapping.externalUserId).catch(() => {});
        }

        // Soft-delete: remove login access + agent routing, keep historical data
        await this.db.$transaction([
            this.db.clientAuth.deleteMany({ where: { employeeId } }),
            this.db.agentEmployeeMapping.deleteMany({ where: { employeeId } }),
            this.db.employee.update({
                where: { id: employeeId },
                data: { status: 'inactive', isDeleted: true, deletedAt: new Date(), updatedAt: new Date() },
            }),
        ]);

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.deactivated',
            orgId, targetType: 'Employee', targetId: employeeId });
    }

    async getSettings(orgId: string, employeeId: string) {
        const exists = await this.db.employee.findFirst({ where: { id: employeeId, orgId, deletedAt: null } });
        if (!exists) throw notFound('Employee', employeeId);
        return this.buildSettings(orgId, employeeId);
    }

    async getWorkDaySettings(orgId: string, employeeId: string) {
        await this.assertEmployee(orgId, employeeId);
        const [wd, od] = await Promise.all([
            this.db.workDaySetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        return {
            monday: wd?.monday ?? true,
            tuesday: wd?.tuesday ?? true,
            wednesday: wd?.wednesday ?? true,
            thursday: wd?.thursday ?? true,
            friday: wd?.friday ?? true,
            saturday: wd?.saturday ?? false,
            sunday: wd?.sunday ?? false,
        };
    }

    async updateWorkDaySettings(orgId: string, actorId: string, employeeId: string, req: {
        monday?: boolean; tuesday?: boolean; wednesday?: boolean; thursday?: boolean;
        friday?: boolean; saturday?: boolean; sunday?: boolean;
    }) {
        await this.assertEmployee(orgId, employeeId);
        await this.upsert('workDaySetting', orgId, employeeId, req);
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.work_days_updated',
            orgId, targetType: 'Employee', targetId: employeeId });

        const saved = await this.getWorkDaySettings(orgId, employeeId);
        await this.syncToTrackpilots(orgId, employeeId, extId =>
            this.trackpilots.updateWorkDaySettings(orgId, extId, {
                workDays: (Object.entries(saved) as [string, boolean][])
                    .filter(([, v]) => v)
                    .map(([k]) => k),
            }),
        );
        return saved;
    }

    async getWorkHourSettings(orgId: string, employeeId: string) {
        await this.assertEmployee(orgId, employeeId);
        const [wh, od] = await Promise.all([
            this.db.expectedWorkHoursSetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        const rawInTime = wh?.expectedInTime ?? od?.defaultExpectedInTime;
        return {
            expectedWorkHoursPerDay: Number(wh?.expectedWorkHoursPerDay ?? od?.defaultWorkHoursPerDay ?? 8),
            expectedProductiveHoursPerDay: Number(wh?.expectedProductiveHoursPerDay ?? od?.defaultProductiveHoursPerDay ?? 6),
            expectedInTime: rawInTime ? formatTime(rawInTime) : '08:00',
        };
    }

    async updateWorkHourSettings(orgId: string, actorId: string, employeeId: string, req: {
        expectedWorkHoursPerDay?: number; expectedProductiveHoursPerDay?: number; expectedInTime?: string;
    }) {
        await this.assertEmployee(orgId, employeeId);
        // Parse expectedInTime string -> Date for the @db.Time Prisma field
        const data: Record<string, unknown> = {};
        if (req.expectedWorkHoursPerDay != null) data['expectedWorkHoursPerDay'] = req.expectedWorkHoursPerDay;
        if (req.expectedProductiveHoursPerDay != null) data['expectedProductiveHoursPerDay'] = req.expectedProductiveHoursPerDay;
        if (req.expectedInTime) data['expectedInTime'] = parseTimeString(req.expectedInTime);
        await this.upsert('expectedWorkHoursSetting', orgId, employeeId, data);
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.work_hours_updated',
            orgId, targetType: 'Employee', targetId: employeeId });

        const saved = await this.getWorkHourSettings(orgId, employeeId);
        await this.syncToTrackpilots(orgId, employeeId, extId =>
            this.trackpilots.updateExpectedWorkHours(orgId, extId, {
                expectedWorkMinutesPerDay: Math.round(saved.expectedWorkHoursPerDay * 60),
                expectedProductiveWorkMinutesPerDay: Math.round(saved.expectedProductiveHoursPerDay * 60),
                expectedInTime: saved.expectedInTime,
            }),
        );
        return saved;
    }

    async getScreenshotSettings(orgId: string, employeeId: string) {
        await this.assertEmployee(orgId, employeeId);
        const [ss, od] = await Promise.all([
            this.db.screenshotSetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        return {
            screenCaptureEnabled: ss?.screenCaptureEnabled ?? od?.defaultScreenshotEnabled ?? true,
            blurEnabled: ss?.blurEnabled ?? od?.defaultBlurEnabled ?? false,
            captureIntervalMinutes: ss?.captureIntervalMinutes ?? od?.defaultCaptureIntervalMinutes ?? 1,
        };
    }

    async updateScreenshotSettings(orgId: string, actorId: string, employeeId: string, req: {
        screenCaptureEnabled?: boolean; blurEnabled?: boolean; captureIntervalMinutes?: number;
    }) {
        await this.assertEmployee(orgId, employeeId);
        await this.upsert('screenshotSetting', orgId, employeeId, req);
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.screenshot_settings_updated',
            orgId, targetType: 'Employee', targetId: employeeId });

        const saved = await this.getScreenshotSettings(orgId, employeeId);
        await this.syncToTrackpilots(orgId, employeeId, extId =>
            this.trackpilots.updateScreenshotSettings(orgId, extId, {
                enableScreenCapture: saved.screenCaptureEnabled,
                enableBlurScreenCapture: saved.blurEnabled,
                screenCaptureIntervalMinutes: saved.captureIntervalMinutes,
            }),
        );
        return saved;
    }

    async getIdleAlertSettings(orgId: string, employeeId: string) {
        await this.assertEmployee(orgId, employeeId);
        const [ia, od] = await Promise.all([
            this.db.idleAlertSetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        return {
            idleAlertEnabled: ia?.idleAlertEnabled ?? od?.defaultIdleAlertEnabled ?? true,
            minIdleTimeMinutes: ia?.minIdleTimeMinutes ?? od?.defaultMinIdleTimeMinutes ?? 5,
        };
    }

    async updateIdleAlertSettings(orgId: string, actorId: string, employeeId: string, req: {
        idleAlertEnabled?: boolean; minIdleTimeMinutes?: number;
    }) {
        await this.assertEmployee(orgId, employeeId);
        await this.upsert('idleAlertSetting', orgId, employeeId, req);
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.idle_alert_updated',
            orgId, targetType: 'Employee', targetId: employeeId });

        const saved = await this.getIdleAlertSettings(orgId, employeeId);
        await this.syncToTrackpilots(orgId, employeeId, extId =>
            this.trackpilots.updateIdleAlertSettings(orgId, extId, {
                enableIdleTimeAlert: saved.idleAlertEnabled,
                minimumIdleTimeMinutes: saved.minIdleTimeMinutes,
            }),
        );
        return saved;
    }

    async getStealthSettings(orgId: string, employeeId: string) {
        await this.assertEmployee(orgId, employeeId);
        const [st, od] = await Promise.all([
            this.db.stealthMonitoringSetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        return {
            stealthEnabled: st?.stealthEnabled ?? od?.defaultStealthEnabled ?? false,
            consentAcknowledged: st?.consentAcknowledged ?? false,
            consentAcknowledgedAt: st?.consentAcknowledgedAt ?? null,
        };
    }

    async updateStealthSettings(orgId: string, actorId: string, employeeId: string, req: {
        stealthEnabled: boolean; consentAcknowledged?: boolean;
    }) {
        await this.assertEmployee(orgId, employeeId);
        if (req.stealthEnabled && !req.consentAcknowledged) {
            throw Object.assign(
                new Error('Stealth monitoring requires explicit consent acknowledgement.'),
                { statusCode: 400 },
            );
        }
        const data: Record<string, unknown> = { stealthEnabled: req.stealthEnabled, updatedAt: new Date() };
        if (req.stealthEnabled && req.consentAcknowledged) {
            data['consentAcknowledged'] = true;
            data['consentAcknowledgedAt'] = new Date();
            data['consentAcknowledgedBy'] = actorId;
        }
        await this.upsert('stealthMonitoringSetting', orgId, employeeId, data);
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.stealth_updated',
            orgId, targetType: 'Employee', targetId: employeeId });

        const saved = await this.getStealthSettings(orgId, employeeId);
        await this.syncToTrackpilots(orgId, employeeId, extId =>
            this.trackpilots.updateStealthSettings(orgId, extId, {
                enableStealthMonitoring: saved.stealthEnabled,
            }),
        );
        return saved;
    }

    private async assertEmployee(orgId: string, employeeId: string) {
        const e = await this.db.employee.findFirst({ where: { id: employeeId, orgId, deletedAt: null } });
        if (!e) throw notFound('Employee', employeeId);
    }

    async updateSettings(orgId: string, actorId: string, employeeId: string, req: Record<string, unknown>) {
        const exists = await this.db.employee.findFirst({ where: { id: employeeId, orgId, deletedAt: null } });
        if (!exists) throw notFound('Employee', employeeId);

        const { workHours, workDays, screenshot, idleAlert, stealth } = splitSettingsReq(req);

        await Promise.all([
            workHours && this.upsert('expectedWorkHoursSetting', orgId, employeeId, {
                ...workHours,
                ...(workHours['expectedInTime'] ? { expectedInTime: parseTimeString(workHours['expectedInTime'] as string) } : {}),
            }),
            workDays && this.upsert('workDaySetting', orgId, employeeId, workDays),
            screenshot && this.upsert('screenshotSetting', orgId, employeeId, screenshot),
            idleAlert && this.upsert('idleAlertSetting', orgId, employeeId, idleAlert),
            stealth && this.upsert('stealthMonitoringSetting', orgId, employeeId, stealth),
        ]);

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.settings_updated',
            orgId, targetType: 'Employee', targetId: employeeId });
        return this.buildSettings(orgId, employeeId);
    }

    // Looks up the agent mapping and runs fn against the external user ID.
    // Best-effort (never throws, so the SONIQ save still succeeds) but logs the outcome so the
    // Trackpilots push can be verified — grep pm2 logs for "[TP-SYNC]".
    private async syncToTrackpilots(
        orgId: string, employeeId: string,
        fn: (externalUserId: string) => Promise<unknown>,
    ): Promise<void> {
        const mapping = await this.db.agentEmployeeMapping.findFirst({
            where: { employeeId, orgId, agentProvider: 'trackpilots' },
            select: { externalUserId: true },
        });
        if (!mapping) {
            console.warn(`[TP-SYNC] no Trackpilots mapping for employee ${employeeId} — settings NOT pushed`);
            return;
        }
        try {
            await fn(mapping.externalUserId);
            console.log(`[TP-SYNC] OK — pushed to Trackpilots for externalUserId=${mapping.externalUserId}`);
        } catch (err: any) {
            const status = err?.response?.status ?? '';
            const body = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : '';
            console.error(`[TP-SYNC] FAILED for externalUserId=${mapping.externalUserId}: ${status} ${err?.message ?? err} ${body}`);
        }
    }

    private async buildSettings(orgId: string, employeeId: string) {
        const [wh, wd, ss, ia, st, od] = await Promise.all([
            this.db.expectedWorkHoursSetting.findFirst({ where: { employeeId } }),
            this.db.workDaySetting.findFirst({ where: { employeeId } }),
            this.db.screenshotSetting.findFirst({ where: { employeeId } }),
            this.db.idleAlertSetting.findFirst({ where: { employeeId } }),
            this.db.stealthMonitoringSetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        const rawInTime = wh?.expectedInTime ?? od?.defaultExpectedInTime;
        return {
            expectedWorkHoursPerDay: Number(wh?.expectedWorkHoursPerDay ?? od?.defaultWorkHoursPerDay ?? 8),
            expectedProductiveHoursPerDay: Number(wh?.expectedProductiveHoursPerDay ?? od?.defaultProductiveHoursPerDay ?? 6),
            expectedInTime: rawInTime ? formatTime(rawInTime) : '08:00',
            monday: wd?.monday ?? true, tuesday: wd?.tuesday ?? true, wednesday: wd?.wednesday ?? true,
            thursday: wd?.thursday ?? true, friday: wd?.friday ?? true,
            saturday: wd?.saturday ?? false, sunday: wd?.sunday ?? false,
            screenCaptureEnabled: ss?.screenCaptureEnabled ?? od?.defaultScreenshotEnabled ?? true,
            blurEnabled: ss?.blurEnabled ?? od?.defaultBlurEnabled ?? false,
            captureIntervalMinutes: ss?.captureIntervalMinutes ?? od?.defaultCaptureIntervalMinutes ?? 1,
            idleAlertEnabled: ia?.idleAlertEnabled ?? od?.defaultIdleAlertEnabled ?? true,
            minIdleTimeMinutes: ia?.minIdleTimeMinutes ?? od?.defaultMinIdleTimeMinutes ?? 5,
            stealthEnabled: st?.stealthEnabled ?? od?.defaultStealthEnabled ?? false,
        };
    }

    private async upsert(table: string, orgId: string, employeeId: string, data: Record<string, unknown>) {
        const client = this.db as unknown as Record<string, { findFirst: Function; create: Function; update: Function }>;
        const repo = client[table];
        const existing = await repo.findFirst({ where: { employeeId } });
        if (existing) {
            await repo.update({ where: { id: existing.id }, data });
        } else {
            await repo.create({ data: { id: randomUUID(), orgId, employeeId, updatedAt: new Date(), ...data } });
        }
    }
}

function notFound(type: string, id: string) {
    return Object.assign(new Error(`${type} ${id} not found.`), { statusCode: 404 });
}

function splitSettingsReq(req: Record<string, unknown>) {
    const workHoursKeys = ['expectedWorkHoursPerDay', 'expectedProductiveHoursPerDay', 'expectedInTime'];
    const workDayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const screenshotKeys = ['screenCaptureEnabled', 'blurEnabled', 'captureIntervalMinutes'];
    const idleKeys = ['idleAlertEnabled', 'minIdleTimeMinutes'];
    const stealthKeys = ['stealthEnabled'];

    const pick = (keys: string[]) => {
        const obj = Object.fromEntries(keys.filter(k => k in req).map(k => [k, req[k]]));
        return Object.keys(obj).length > 0 ? obj : null;
    };

    return {
        workHours: pick(workHoursKeys),
        workDays: pick(workDayKeys),
        screenshot: pick(screenshotKeys),
        idleAlert: pick(idleKeys),
        stealth: pick(stealthKeys),
    };
}
