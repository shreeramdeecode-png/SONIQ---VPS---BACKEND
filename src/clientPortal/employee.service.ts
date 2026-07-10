import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { paged, type PagedResult } from '../types/common.js';
import { randomUUID, createDecipheriv } from 'node:crypto';

function decryptApiKey(ciphertext: string, keyBase64: string): string {
    const key = Buffer.from(keyBase64, 'base64');
    const buf = Buffer.from(ciphertext, 'base64');
    const nonce = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export class EmployeeService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
        private readonly passwords: PasswordService,
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
                status: 'invited',
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

        // Send Trackpilots invite
        try {
            const orgMapping = await this.db.agentOrgMapping.findFirst({
                where: { orgId, agentProvider: 'trackpilots' }, select: { apiKeyEncrypted: true },
            });
            if (orgMapping) {
                const apiKey = decryptApiKey(orgMapping.apiKeyEncrypted, process.env.ENCRYPTION_KEY!);
                const rolesRes = await fetch('https://api.trackpilots.com/v1/access-management', {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                });
                const rolesData = await rolesRes.json() as any;
                const tpRoleId = rolesData.data?.find((r: any) => r.roleName === 'Employee')?.roleId ?? rolesData.data?.[0]?.roleId ?? '';
                let teamIds: string[] = [];
                if (req.teamId) {
                    const teamMapping = await this.db.agentTeamMapping.findFirst({
                        where: { teamId: req.teamId, orgId, agentProvider: 'trackpilots' },
                    });
                    if (teamMapping) teamIds = [teamMapping.externalTeamId];
                }
                const workMode = (req.workMode?.toLowerCase() ?? 'office');
                await fetch('https://api.trackpilots.com/v1/employees/send-invite-link', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emailId: req.email, userName: req.name, roleId: tpRoleId, teams: teamIds, workMode }),
                });
                console.log(`[Trackpilots] invite sent to ${req.email}`);
            }
        } catch (err) { console.error('[Trackpilots] inviteEmployee failed:', err); }

        const settings = await this.buildSettings(orgId, employee.id);
        return { ...employee, teamName: employee.team?.name, roleName: employee.role.name, settings };
    }

    async resendInvite(orgId: string, employeeId: string) {
        const e = await this.db.employee.findFirst({
            where: { id: employeeId, orgId, status: 'invited', deletedAt: null },
        });
        if (!e) throw Object.assign(new Error('Employee not found or not in invited state'), { statusCode: 404 });

        if (e.teamId) {
            try {
                const [orgMapping, empMapping, teamMapping] = await Promise.all([
                    this.db.agentOrgMapping.findFirst({ where: { orgId, agentProvider: 'trackpilots' }, select: { apiKeyEncrypted: true } }),
                    this.db.agentEmployeeMapping.findFirst({ where: { employeeId, orgId, agentProvider: 'trackpilots' } }),
                    this.db.agentTeamMapping.findFirst({ where: { teamId: e.teamId, orgId, agentProvider: 'trackpilots' } }),
                ]);
                if (orgMapping && teamMapping) {
                    const apiKey = decryptApiKey(orgMapping.apiKeyEncrypted, process.env.ENCRYPTION_KEY!);
                    await fetch('https://api.trackpilots.com/v1/employees/send-invite-link', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ emailId: e.email, userName: e.name, teams: [teamMapping.externalTeamId], workMode: (e.workModeType ?? 'Office').toLowerCase() }),
                    });
                }
            } catch (err) { console.error('[Trackpilots] resendInvite failed:', err); }
        }
        return { success: true };
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

        // Sync name change to Trackpilots
        if (req.name) {
            try {
                const [mapping, orgMapping] = await Promise.all([
                    this.db.agentEmployeeMapping.findFirst({
                        where: { employeeId, orgId, agentProvider: 'trackpilots' },
                    }),
                    this.db.agentOrgMapping.findFirst({
                        where: { orgId, agentProvider: 'trackpilots' },
                        select: { apiKeyEncrypted: true },
                    }),
                ]);
                if (mapping && orgMapping) {
                    const apiKey = decryptApiKey(orgMapping.apiKeyEncrypted, process.env.ENCRYPTION_KEY!);
                    const getRes = await fetch('https://api.trackpilots.com/v1/employees', {
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                    });
                    const getData = await getRes.json() as any;
                    const empList = Array.isArray(getData.data) ? getData.data : [];
                    const tpEmp = empList.find((u: any) => u.userId === mapping.externalUserId);
                    if (tpEmp) {
                        const roleId = tpEmp.roleId ?? tpEmp.role?.roleId ?? '';
                        const teams = (tpEmp.teams ?? []).map((t: any) => t.teamId);
                        const workMode = tpEmp.workMode ?? updated.workModeType?.toLowerCase() ?? 'office';
                        const tpRes = await fetch('https://api.trackpilots.com/v1/employees', {
                            method: 'PATCH',
                            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: mapping.externalUserId, userName: req.name, roleId, teams, workMode }),
                        });
                        const tpBody = await tpRes.text();
                        console.log('[Trackpilots] updateEmployee status:', tpRes.status, tpBody);
                    }
                }
            } catch (err) {
                console.error('[Trackpilots] updateEmployee failed:', err);
            }
        }

        const settings = await this.buildSettings(orgId, employeeId);
        return { ...updated, teamName: updated.team?.name, roleName: updated.role.name, settings };
    }

    async deactivateEmployee(orgId: string, actorId: string, employeeId: string) {
        const e = await this.db.employee.findFirst({ where: { id: employeeId, orgId } });
        if (!e) throw notFound('Employee', employeeId);

        // Remove from Trackpilots
        try {
            const [mapping, orgMapping] = await Promise.all([
                this.db.agentEmployeeMapping.findFirst({
                    where: { employeeId, orgId, agentProvider: 'trackpilots' },
                }),
                this.db.agentOrgMapping.findFirst({
                    where: { orgId, agentProvider: 'trackpilots' },
                    select: { apiKeyEncrypted: true },
                }),
            ]);
            if (mapping && orgMapping) {
                const apiKey = decryptApiKey(orgMapping.apiKeyEncrypted, process.env.ENCRYPTION_KEY!);
                await fetch('https://api.trackpilots.com/v1/employees', {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: mapping.externalUserId }),
                });
            }
        } catch (err) {
            console.error('[Trackpilots] deleteEmployee failed:', err);
        }

        await this.db.$transaction([
            this.db.clientAuth.deleteMany({ where: { employeeId } }),
            this.db.agentEmployeeMapping.deleteMany({ where: { employeeId } }),
            this.db.screenshotSetting.deleteMany({ where: { employeeId } }),
            this.db.workDaySetting.deleteMany({ where: { employeeId } }),
            this.db.idleAlertSetting.deleteMany({ where: { employeeId } }),
            this.db.stealthMonitoringSetting.deleteMany({ where: { employeeId } }),
            this.db.expectedWorkHoursSetting.deleteMany({ where: { employeeId } }),
            this.db.screenshot.deleteMany({ where: { employeeId } }),
            this.db.activityEvent.deleteMany({ where: { employeeId } }),
            this.db.dailySummary.deleteMany({ where: { employeeId } }),
            this.db.employee.delete({ where: { id: employeeId } }),
        ]);
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.deleted',
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
            monday: wd?.monday ?? true, tuesday: wd?.tuesday ?? true,
            wednesday: wd?.wednesday ?? true, thursday: wd?.thursday ?? true,
            friday: wd?.friday ?? true, saturday: wd?.saturday ?? false,
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
        return this.getWorkDaySettings(orgId, employeeId);
    }

    async getWorkHourSettings(orgId: string, employeeId: string) {
        await this.assertEmployee(orgId, employeeId);
        const [wh, od] = await Promise.all([
            this.db.expectedWorkHoursSetting.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSetting.findFirst({ where: { orgId } }),
        ]);
        return {
            expectedWorkHoursPerDay: Number(wh?.expectedWorkHoursPerDay ?? od?.defaultWorkHoursPerDay ?? 8),
            expectedProductiveHoursPerDay: Number(wh?.expectedProductiveHoursPerDay ?? od?.defaultProductiveHoursPerDay ?? 6),
            expectedInTime: wh?.expectedInTime ?? od?.defaultExpectedInTime ?? '08:00',
        };
    }

    async updateWorkHourSettings(orgId: string, actorId: string, employeeId: string, req: {
        expectedWorkHoursPerDay?: number; expectedProductiveHoursPerDay?: number; expectedInTime?: string;
    }) {
        await this.assertEmployee(orgId, employeeId);
        await this.upsert('expectedWorkHoursSetting', orgId, employeeId, req);
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.work_hours_updated',
            orgId, targetType: 'Employee', targetId: employeeId });
        return this.getWorkHourSettings(orgId, employeeId);
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
        return this.getScreenshotSettings(orgId, employeeId);
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
        return this.getIdleAlertSettings(orgId, employeeId);
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
        return this.getStealthSettings(orgId, employeeId);
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
            workHours && this.upsert('expectedWorkHoursSetting', orgId, employeeId, workHours),
            workDays && this.upsert('workDaySetting', orgId, employeeId, workDays),
            screenshot && this.upsert('screenshotSetting', orgId, employeeId, screenshot),
            idleAlert && this.upsert('idleAlertSetting', orgId, employeeId, idleAlert),
            stealth && this.upsert('stealthMonitoringSetting', orgId, employeeId, stealth),
        ]);

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.settings_updated',
            orgId, targetType: 'Employee', targetId: employeeId });
        return this.buildSettings(orgId, employeeId);
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
        return {
            expectedWorkHoursPerDay: Number(wh?.expectedWorkHoursPerDay ?? od?.defaultWorkHoursPerDay ?? 8),
            expectedProductiveHoursPerDay: Number(wh?.expectedProductiveHoursPerDay ?? od?.defaultProductiveHoursPerDay ?? 6),
            expectedInTime: wh?.expectedInTime ?? od?.defaultExpectedInTime ?? '08:00',
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
