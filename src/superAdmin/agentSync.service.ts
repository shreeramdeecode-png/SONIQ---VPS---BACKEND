import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TrackpilotsService } from '../infrastructure/agents/trackpilots.service.js';
import type { AuditService } from '../infrastructure/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';

function parseTimeStr(s: string): Date {
    const [h = 0, m = 0] = s.split(':').map(Number);
    const d = new Date(0);
    d.setUTCHours(h, m, 0, 0);
    return d;
}

export interface SyncReport {
    teams: {
        synced: number;
        unmatched: { externalId: string; name: string }[];
    };
    employees: {
        synced: number;
        created: number;
        unmatched: { externalId: string; email: string; name: string }[];
    };
}

const DEFAULT_PASSWORD = 'Employee@123';

export class AgentSyncService {
    constructor(
        private readonly db: PrismaClient,
        private readonly trackpilots: TrackpilotsService,
        private readonly audit: AuditService,
        private readonly passwords: PasswordService,
    ) {}

    async syncOrg(actorId: string, orgId: string): Promise<SyncReport> {
        const orgMapping = await this.db.agentOrgMapping.findFirst({
            where: { orgId, isActive: true },
        });
        if (!orgMapping) {
            throw Object.assign(
                new Error(`No active agent mapping for org ${orgId}. Configure TrackPilots credentials first.`),
                { statusCode: 400 },
            );
        }

        const [tpTeams, tpEmployees, internalTeams, internalEmployees] = await Promise.all([
            this.trackpilots.fetchAllTeams(orgId),
            this.trackpilots.fetchAllEmployees(orgId),
            this.db.team.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true } }),
            this.db.employee.findMany({ where: { orgId, deletedAt: null }, select: { id: true, email: true } }),
        ]);

        const teamReport = await this.syncTeams(orgId, tpTeams, internalTeams);
        const employeeReport = await this.syncEmployees(orgId, tpEmployees, internalEmployees, teamReport.externalToInternal);

        // Best-effort: pull settings from Trackpilots into SONIQ (Trackpilots → SONIQ direction)
        await this.pullSettingsFromTrackpilots(orgId).catch(() => {});

        await this.audit.log({
            actorId, actorType: 'SuperAdmin', action: 'org.agent_synced',
            orgId, targetType: 'Organization', targetId: orgId,
            after: `teams:${teamReport.synced} employees:${employeeReport.synced} created:${employeeReport.created}`,
        });

        return {
            teams: { synced: teamReport.synced, unmatched: teamReport.unmatched },
            employees: { synced: employeeReport.synced, created: employeeReport.created, unmatched: employeeReport.unmatched },
        };
    }

    private async syncTeams(
        orgId: string,
        tpTeams: { id: string; name: string }[],
        internalTeams: { id: string; name: string }[],
    ) {
        const internalByName = new Map(internalTeams.map(t => [t.name.toLowerCase(), t.id]));
        const externalToInternal = new Map<string, string>();
        const unmatched: { externalId: string; name: string }[] = [];
        let synced = 0;

        for (const tpTeam of tpTeams) {
            const internalId = internalByName.get(tpTeam.name.toLowerCase());
            if (!internalId) {
                unmatched.push({ externalId: tpTeam.id, name: tpTeam.name });
                continue;
            }

            externalToInternal.set(tpTeam.id, internalId);

            const existing = await this.db.agentTeamMapping.findFirst({
                where: { orgId, externalTeamId: tpTeam.id, agentProvider: 'trackpilots' },
            });

            if (existing) {
                if (existing.teamId !== internalId) {
                    await this.db.agentTeamMapping.update({
                        where: { id: existing.id },
                        data: { teamId: internalId },
                    });
                }
            } else {
                await this.db.agentTeamMapping.create({
                    data: {
                        id: randomUUID(),
                        teamId: internalId,
                        orgId,
                        agentProvider: 'trackpilots',
                        externalTeamId: tpTeam.id,
                    },
                });
            }
            synced++;
        }

        return { synced, unmatched, externalToInternal };
    }

    private async syncEmployees(
        orgId: string,
        tpEmployees: { id: string; email: string; name: string; teamId?: string | null }[],
        internalEmployees: { id: string; email: string }[],
        teamExternalToInternal: Map<string, string>,
    ) {
        const internalByEmail = new Map(internalEmployees.map(e => [e.email.toLowerCase(), e.id]));
        const unmatched: { externalId: string; email: string; name: string }[] = [];
        let synced = 0;
        let created = 0;

        // Find default role once for auto-created employees
        const defaultRole = await this.db.role.findFirst({
            where: { orgId },
            orderBy: { name: 'asc' },
        });
        const defaultPasswordHash = defaultRole ? await this.passwords.hash(DEFAULT_PASSWORD) : null;

        for (const tpEmp of tpEmployees) {
            let internalId = internalByEmail.get(tpEmp.email.toLowerCase());

            if (!internalId) {
                // Auto-create employee with default password so they can log in immediately
                if (!defaultRole || !defaultPasswordHash) {
                    unmatched.push({ externalId: tpEmp.id, email: tpEmp.email, name: tpEmp.name });
                    continue;
                }

                const externalTeamId = tpEmp.teamId ?? null;
                const assignedTeamId = externalTeamId ? (teamExternalToInternal.get(externalTeamId) ?? null) : null;

                const newEmployee = await this.db.employee.create({
                    data: {
                        id: randomUUID(), orgId,
                        name: tpEmp.name,
                        email: tpEmp.email.toLowerCase(),
                        roleId: defaultRole.id,
                        teamId: assignedTeamId,
                        status: 'active',
                        updatedAt: new Date(),
                        clientAuth: {
                            create: {
                                id: randomUUID(), orgId,
                                email: tpEmp.email.toLowerCase(),
                                passwordHash: defaultPasswordHash,
                                passwordSet: false, // prompts password change on first login
                                updatedAt: new Date(),
                            },
                        },
                    },
                });

                // Wire the agent mapping immediately so webhooks route correctly
                await this.db.agentEmployeeMapping.create({
                    data: {
                        id: randomUUID(),
                        employeeId: newEmployee.id,
                        orgId,
                        agentProvider: 'trackpilots',
                        externalUserId: tpEmp.id,
                        externalTeamId,
                    },
                });

                created++;
                synced++;
                continue;
            }

            const externalTeamId = tpEmp.teamId ?? null;
            const internalTeamId = externalTeamId ? (teamExternalToInternal.get(externalTeamId) ?? null) : null;

            const existing = await this.db.agentEmployeeMapping.findFirst({
                where: { orgId, externalUserId: tpEmp.id, agentProvider: 'trackpilots' },
            });

            if (existing) {
                if (existing.employeeId !== internalId || existing.externalTeamId !== externalTeamId) {
                    await this.db.agentEmployeeMapping.update({
                        where: { id: existing.id },
                        data: { employeeId: internalId, externalTeamId },
                    });
                }
            } else {
                await this.db.agentEmployeeMapping.create({
                    data: {
                        id: randomUUID(),
                        employeeId: internalId,
                        orgId,
                        agentProvider: 'trackpilots',
                        externalUserId: tpEmp.id,
                        externalTeamId,
                    },
                });
            }

            if (internalTeamId) {
                await this.db.employee.updateMany({
                    where: { id: internalId, teamId: null },
                    data: { teamId: internalTeamId },
                });
            }

            synced++;
        }

        return { synced, created, unmatched };
    }

    private async pullSettingsFromTrackpilots(orgId: string): Promise<void> {
        // Pull org-level default settings
        try {
            const defaults = await this.trackpilots.fetchDefaultSettings(orgId);
            if (defaults) {
                const data: Record<string, unknown> = {};
                if (defaults.workHours) {
                    if (defaults.workHours.expectedWorkMinutesPerDay != null)
                        data['defaultWorkHoursPerDay'] = defaults.workHours.expectedWorkMinutesPerDay / 60;
                    if (defaults.workHours.expectedProductiveWorkMinutesPerDay != null)
                        data['defaultProductiveHoursPerDay'] = defaults.workHours.expectedProductiveWorkMinutesPerDay / 60;
                    if (defaults.workHours.expectedInTime)
                        data['defaultExpectedInTime'] = parseTimeStr(defaults.workHours.expectedInTime);
                }
                if (defaults.screenshot) {
                    if (defaults.screenshot.enableScreenCapture != null)
                        data['defaultScreenshotEnabled'] = defaults.screenshot.enableScreenCapture;
                    if (defaults.screenshot.enableBlurScreenCapture != null)
                        data['defaultBlurEnabled'] = defaults.screenshot.enableBlurScreenCapture;
                    if (defaults.screenshot.screenCaptureIntervalMinutes != null)
                        data['defaultCaptureIntervalMinutes'] = defaults.screenshot.screenCaptureIntervalMinutes;
                }
                if (defaults.idleAlert) {
                    if (defaults.idleAlert.enableIdleTimeAlert != null)
                        data['defaultIdleAlertEnabled'] = defaults.idleAlert.enableIdleTimeAlert;
                    if (defaults.idleAlert.minimumIdleTimeMinutes != null)
                        data['defaultMinIdleTimeMinutes'] = defaults.idleAlert.minimumIdleTimeMinutes;
                }
                if (defaults.stealth?.enableStealthMonitoring != null)
                    data['defaultStealthEnabled'] = defaults.stealth.enableStealthMonitoring;
                if (defaults.timezone)
                    data['timezone'] = defaults.timezone;

                if (Object.keys(data).length > 0) {
                    const existing = await this.db.orgDefaultSetting.findFirst({ where: { orgId } });
                    if (existing) {
                        await this.db.orgDefaultSetting.update({ where: { id: existing.id }, data: { ...data, updatedAt: new Date() } });
                    } else {
                        await this.db.orgDefaultSetting.create({
                            data: { id: randomUUID(), orgId, updatedAt: new Date(), ...data as any },
                        });
                    }
                }
            }
        } catch { /* fetchDefaultSettings not available — skip */ }

        // Pull per-employee settings for all mapped employees
        const mappings = await this.db.agentEmployeeMapping.findMany({
            where: { orgId, agentProvider: 'trackpilots' },
            select: { employeeId: true, externalUserId: true },
        });

        for (const m of mappings) {
            try {
                const s = await this.trackpilots.fetchEmployeeSettings(orgId, m.externalUserId);
                if (!s) continue;

                await Promise.all([
                    s.workHours && this.upsertSetting('expectedWorkHoursSetting', orgId, m.employeeId, {
                        ...(s.workHours.expectedWorkMinutesPerDay != null ? { expectedWorkHoursPerDay: s.workHours.expectedWorkMinutesPerDay / 60 } : {}),
                        ...(s.workHours.expectedProductiveWorkMinutesPerDay != null ? { expectedProductiveHoursPerDay: s.workHours.expectedProductiveWorkMinutesPerDay / 60 } : {}),
                        ...(s.workHours.expectedInTime ? { expectedInTime: parseTimeStr(s.workHours.expectedInTime) } : {}),
                    }),
                    s.workDays && this.upsertSetting('workDaySetting', orgId, m.employeeId, {
                        monday: s.workDays.includes('monday'),
                        tuesday: s.workDays.includes('tuesday'),
                        wednesday: s.workDays.includes('wednesday'),
                        thursday: s.workDays.includes('thursday'),
                        friday: s.workDays.includes('friday'),
                        saturday: s.workDays.includes('saturday'),
                        sunday: s.workDays.includes('sunday'),
                    }),
                    s.screenshot && this.upsertSetting('screenshotSetting', orgId, m.employeeId, {
                        ...(s.screenshot.enableScreenCapture != null ? { screenCaptureEnabled: s.screenshot.enableScreenCapture } : {}),
                        ...(s.screenshot.enableBlurScreenCapture != null ? { blurEnabled: s.screenshot.enableBlurScreenCapture } : {}),
                        ...(s.screenshot.screenCaptureIntervalMinutes != null ? { captureIntervalMinutes: s.screenshot.screenCaptureIntervalMinutes } : {}),
                    }),
                    s.idleAlert && this.upsertSetting('idleAlertSetting', orgId, m.employeeId, {
                        ...(s.idleAlert.enableIdleTimeAlert != null ? { idleAlertEnabled: s.idleAlert.enableIdleTimeAlert } : {}),
                        ...(s.idleAlert.minimumIdleTimeMinutes != null ? { minIdleTimeMinutes: s.idleAlert.minimumIdleTimeMinutes } : {}),
                    }),
                    s.stealth && this.upsertSetting('stealthMonitoringSetting', orgId, m.employeeId, {
                        ...(s.stealth.enableStealthMonitoring != null ? { stealthEnabled: s.stealth.enableStealthMonitoring } : {}),
                    }),
                ]);
            } catch { /* per-employee fetch failed — skip this employee */ }
        }
    }

    private async upsertSetting(table: string, orgId: string, employeeId: string, data: Record<string, unknown>): Promise<void> {
        if (Object.keys(data).length === 0) return;
        const client = this.db as unknown as Record<string, { findFirst: Function; create: Function; update: Function }>;
        const repo = client[table];
        const existing = await repo.findFirst({ where: { employeeId } });
        if (existing) {
            await repo.update({ where: { id: existing.id }, data: { ...data, updatedAt: new Date() } });
        } else {
            await repo.create({ data: { id: randomUUID(), orgId, employeeId, updatedAt: new Date(), ...data } });
        }
    }
}
