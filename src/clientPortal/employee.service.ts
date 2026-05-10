import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { paged, type PagedResult } from '../types/common.js';
import { randomUUID } from 'node:crypto';

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
                orgId, name: req.name,
                email: req.email.toLowerCase(),
                roleId: req.roleId,
                teamId: req.teamId,
                designation: req.designation,
                department: req.department,
                workModeType: req.workMode ?? 'Office',
                status: 'active',
                clientAuth: {
                    create: {
                        orgId,
                        email: req.email.toLowerCase(),
                        passwordHash: tempPassword,
                        passwordSet: false,
                    },
                },
            },
            include: { team: true, role: true },
        });

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.invited',
            orgId, targetType: 'Employee', targetId: employee.id, after: employee.email });

        // TODO: send invite email
        console.log(`[Invite] ${employee.email} invited to /set-password`);

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

        const settings = await this.buildSettings(orgId, employeeId);
        return { ...updated, teamName: updated.team?.name, roleName: updated.role.name, settings };
    }

    async deactivateEmployee(orgId: string, actorId: string, employeeId: string) {
        const e = await this.db.employee.findFirst({ where: { id: employeeId, orgId } });
        if (!e) throw notFound('Employee', employeeId);

        await this.db.employee.update({
            where: { id: employeeId },
            data: { status: 'inactive', isCurrentlyWorking: false },
        });
        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.deactivated',
            orgId, targetType: 'Employee', targetId: employeeId });
    }

    async getSettings(orgId: string, employeeId: string) {
        const exists = await this.db.employee.findFirst({ where: { id: employeeId, orgId, deletedAt: null } });
        if (!exists) throw notFound('Employee', employeeId);
        return this.buildSettings(orgId, employeeId);
    }

    async updateSettings(orgId: string, actorId: string, employeeId: string, req: Record<string, unknown>) {
        const exists = await this.db.employee.findFirst({ where: { id: employeeId, orgId, deletedAt: null } });
        if (!exists) throw notFound('Employee', employeeId);

        const { workHours, workDays, screenshot, idleAlert, stealth } = splitSettingsReq(req);

        await Promise.all([
            workHours && this.upsert('expectedWorkHoursSettings', orgId, employeeId, workHours),
            workDays && this.upsert('workDaySettings', orgId, employeeId, workDays),
            screenshot && this.upsert('screenshotSettings', orgId, employeeId, screenshot),
            idleAlert && this.upsert('idleAlertSettings', orgId, employeeId, idleAlert),
            stealth && this.upsert('stealthMonitoringSettings', orgId, employeeId, stealth),
        ]);

        await this.audit.log({ actorId, actorType: 'ClientAdmin', action: 'employee.settings_updated',
            orgId, targetType: 'Employee', targetId: employeeId });
        return this.buildSettings(orgId, employeeId);
    }

    private async buildSettings(orgId: string, employeeId: string) {
        const [wh, wd, ss, ia, st, od] = await Promise.all([
            this.db.expectedWorkHoursSettings.findFirst({ where: { employeeId } }),
            this.db.workDaySettings.findFirst({ where: { employeeId } }),
            this.db.screenshotSettings.findFirst({ where: { employeeId } }),
            this.db.idleAlertSettings.findFirst({ where: { employeeId } }),
            this.db.stealthMonitoringSettings.findFirst({ where: { employeeId } }),
            this.db.orgDefaultSettings.findFirst({ where: { orgId } }),
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
            await repo.create({ data: { orgId, employeeId, ...data } });
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
