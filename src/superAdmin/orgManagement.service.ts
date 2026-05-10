import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../infrastructure/audit.service.js';
import { paged, type PagedResult } from '../types/common.js';

export class OrgManagementService {
    constructor(
        private readonly db: PrismaClient,
        private readonly audit: AuditService,
    ) {}

    async listOrgs(page = 1, pageSize = 20, search?: string): Promise<PagedResult<unknown>> {
        const where = {
            deletedAt: null,
            ...(search ? {
                OR: [
                    { name: { contains: search } },
                    { contactEmail: { contains: search } },
                ],
            } : {}),
        };

        const [total, items] = await Promise.all([
            this.db.organization.count({ where }),
            this.db.organization.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
                include: { _count: { select: { employees: { where: { deletedAt: null } } } } },
            }),
        ]);

        return paged(items.map(o => ({
            id: o.id, name: o.name, status: o.status, contactEmail: o.contactEmail,
            industry: o.industry, timezone: o.timezone,
            employeeCount: o._count.employees, createdAt: o.createdAt,
        })), total, page, pageSize);
    }

    async getOrg(orgId: string) {
        const org = await this.db.organization.findFirst({
            where: { id: orgId, deletedAt: null },
            include: { subscription: true },
        });
        if (!org) throw notFound('Organization', orgId);

        const [empCount, teamCount] = await Promise.all([
            this.db.employee.count({ where: { orgId, deletedAt: null } }),
            this.db.team.count({ where: { orgId, deletedAt: null } }),
        ]);
        return mapOrgDetail(org, empCount, teamCount);
    }

    async createOrg(actorId: string, req: {
        name: string; contactEmail: string; industry?: string; website?: string;
        country?: string; phone?: string; timezone: string;
        planName: string; monthlyAmount: number; maxEmployees: number;
        maxStorageGb: number; dataRetentionDays: number; trialDays: number;
    }) {
        const now = new Date();
        const org = await this.db.organization.create({
            data: {
                name: req.name,
                contactEmail: req.contactEmail.toLowerCase(),
                industry: req.industry,
                website: req.website,
                country: req.country,
                phone: req.phone,
                timezone: req.timezone,
                status: 'Trial',
                orgDefaultSettings: {
                    create: { timezone: req.timezone },
                },
                subscription: {
                    create: {
                        planName: req.planName,
                        monthlyAmount: req.monthlyAmount,
                        billingCycle: 'monthly',
                        maxEmployees: req.maxEmployees,
                        maxStorageGb: req.maxStorageGb,
                        dataRetentionDays: req.dataRetentionDays,
                        startedAt: now,
                        expiresAt: new Date(now.getTime() + req.trialDays * 86400000),
                        status: 'active',
                    },
                },
            },
            include: { subscription: true },
        });

        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'org.created',
            orgId: org.id, targetType: 'Organization', targetId: org.id, after: org.name });
        return mapOrgDetail(org, 0, 0);
    }

    async updateOrg(actorId: string, orgId: string, req: {
        name?: string; industry?: string; website?: string; country?: string;
        phone?: string; timezone?: string; contactEmail?: string; logoUrl?: string;
    }) {
        const org = await this.db.organization.findFirst({ where: { id: orgId, deletedAt: null }, include: { subscription: true } });
        if (!org) throw notFound('Organization', orgId);

        const before = org.name;
        const updated = await this.db.organization.update({
            where: { id: orgId },
            data: {
                ...(req.name && { name: req.name }),
                ...(req.industry && { industry: req.industry }),
                ...(req.website && { website: req.website }),
                ...(req.country && { country: req.country }),
                ...(req.phone && { phone: req.phone }),
                ...(req.timezone && { timezone: req.timezone }),
                ...(req.contactEmail && { contactEmail: req.contactEmail.toLowerCase() }),
                ...(req.logoUrl && { logoUrl: req.logoUrl }),
            },
            include: { subscription: true },
        });

        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'org.updated',
            orgId, targetType: 'Organization', targetId: orgId, before, after: updated.name });

        const [empCount, teamCount] = await Promise.all([
            this.db.employee.count({ where: { orgId, deletedAt: null } }),
            this.db.team.count({ where: { orgId, deletedAt: null } }),
        ]);
        return mapOrgDetail(updated, empCount, teamCount);
    }

    async suspendOrg(actorId: string, orgId: string) {
        const org = await this.db.organization.findUnique({ where: { id: orgId } });
        if (!org) throw notFound('Organization', orgId);
        await this.db.organization.update({ where: { id: orgId }, data: { status: 'Suspended' } });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'org.suspended',
            orgId, targetType: 'Organization', targetId: orgId, before: org.status, after: 'Suspended' });
    }

    async reactivateOrg(actorId: string, orgId: string) {
        const org = await this.db.organization.findUnique({ where: { id: orgId } });
        if (!org) throw notFound('Organization', orgId);
        await this.db.organization.update({ where: { id: orgId }, data: { status: 'Active' } });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'org.reactivated',
            orgId, targetType: 'Organization', targetId: orgId, before: org.status, after: 'Active' });
    }

    async deleteOrg(actorId: string, orgId: string) {
        const org = await this.db.organization.findUnique({ where: { id: orgId } });
        if (!org) throw notFound('Organization', orgId);
        await this.db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'org.deleted',
            orgId, targetType: 'Organization', targetId: orgId, before: org.name });
    }

    async getOrgEmployees(orgId: string, page = 1, pageSize = 20): Promise<PagedResult<unknown>> {
        const where = { orgId, deletedAt: null };
        const [total, items] = await Promise.all([
            this.db.employee.count({ where }),
            this.db.employee.findMany({
                where, orderBy: { name: 'asc' },
                skip: (page - 1) * pageSize, take: pageSize,
            }),
        ]);
        return paged(items.map(e => ({
            id: e.id, name: e.name, email: e.email, designation: e.designation,
            department: e.department, status: e.status, createdAt: e.createdAt,
        })), total, page, pageSize);
    }

    async getOrgTeams(orgId: string) {
        return this.db.team.findMany({
            where: { orgId, deletedAt: null },
            orderBy: { name: 'asc' },
            include: { _count: { select: { employees: { where: { deletedAt: null } } } } },
        }).then(teams => teams.map(t => ({
            id: t.id, name: t.name, employeeCount: t._count.employees, createdAt: t.createdAt,
        })));
    }

    async getOrgSettings(orgId: string) {
        const s = await this.db.orgDefaultSettings.findFirst({ where: { orgId } });
        if (!s) throw notFound('OrgSettings', orgId);
        return mapSettings(s);
    }

    async updateOrgSettings(actorId: string, orgId: string, req: Record<string, unknown>) {
        const s = await this.db.orgDefaultSettings.findFirst({ where: { orgId } });
        if (!s) throw notFound('OrgSettings', orgId);

        const updated = await this.db.orgDefaultSettings.update({ where: { id: s.id }, data: req });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'org.settings_updated',
            orgId, targetType: 'OrgDefaultSettings', targetId: s.id });
        return mapSettings(updated);
    }

    async getBilling(orgId: string) {
        const sub = await this.db.subscription.findFirst({ where: { orgId } });
        if (!sub) throw notFound('Subscription', orgId);
        return mapSub(sub);
    }

    async updateBilling(actorId: string, orgId: string, req: Record<string, unknown>) {
        const sub = await this.db.subscription.findFirst({ where: { orgId } });
        if (!sub) throw notFound('Subscription', orgId);

        const before = sub.planName;
        const updated = await this.db.subscription.update({ where: { id: sub.id }, data: req });
        await this.audit.log({ actorId, actorType: 'SuperAdmin', action: 'org.billing_updated',
            orgId, targetType: 'Subscription', targetId: sub.id, before, after: updated.planName });
        return mapSub(updated);
    }

    async getAuditLogs(orgId: string, page = 1, pageSize = 50): Promise<PagedResult<unknown>> {
        const where = { orgId };
        const [total, items] = await Promise.all([
            this.db.auditLog.count({ where }),
            this.db.auditLog.findMany({
                where, orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize, take: pageSize,
            }),
        ]);
        return paged(items, total, page, pageSize);
    }
}

function notFound(type: string, id: string) {
    return Object.assign(new Error(`${type} ${id} not found.`), { statusCode: 404 });
}

function mapOrgDetail(org: Record<string, unknown>, empCount: number, teamCount: number) {
    return { ...org, employeeCount: empCount, teamCount };
}

function mapSettings(s: Record<string, unknown>) {
    return s;
}

function mapSub(s: Record<string, unknown>) {
    return s;
}
