import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TrackpilotsService } from '../infrastructure/agents/trackpilots.service.js';
import type { AuditService } from '../infrastructure/audit.service.js';

export interface SyncReport {
    teams: {
        synced: number;
        unmatched: { externalId: string; name: string }[];
    };
    employees: {
        synced: number;
        unmatched: { externalId: string; email: string; name: string }[];
    };
}

export class AgentSyncService {
    constructor(
        private readonly db: PrismaClient,
        private readonly trackpilots: TrackpilotsService,
        private readonly audit: AuditService,
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

        await this.audit.log({
            actorId, actorType: 'SuperAdmin', action: 'org.agent_synced',
            orgId, targetType: 'Organization', targetId: orgId,
            after: `teams:${teamReport.synced} employees:${employeeReport.synced}`,
        });

        return {
            teams: { synced: teamReport.synced, unmatched: teamReport.unmatched },
            employees: { synced: employeeReport.synced, unmatched: employeeReport.unmatched },
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

        for (const tpEmp of tpEmployees) {
            const internalId = internalByEmail.get(tpEmp.email.toLowerCase());
            if (!internalId) {
                unmatched.push({ externalId: tpEmp.id, email: tpEmp.email, name: tpEmp.name });
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

            // Also update the employee's teamId if we have a match
            if (internalTeamId) {
                await this.db.employee.updateMany({
                    where: { id: internalId, teamId: null },
                    data: { teamId: internalTeamId },
                });
            }

            synced++;
        }

        return { synced, unmatched };
    }
}
