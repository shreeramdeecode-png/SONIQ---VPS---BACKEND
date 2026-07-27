// Role-based data scope.
//
// Three tiers decide HOW MUCH data a logged-in user can see:
//   org   → the whole organization        (Admin)
//   team  → only the caller's own team     (Manager)
//   self  → only the caller's own records  (Employee)
//
// Scope is derived from the role NAME so it works with the existing
// Admin / Manager / Employee roles without any schema change.

import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';

export type Scope = 'org' | 'team' | 'self';

/**
 * Map a role name to a data scope.
 * Admin/Owner → org, Manager/Lead → team, everything else → self (fail-safe:
 * an unknown role sees only its own data, never the whole org).
 */
export function resolveScope(roleName: string | undefined | null): Scope {
    const n = (roleName ?? '').trim().toLowerCase();
    if (n === 'admin' || n === 'owner' || n === 'super admin' || n === 'administrator') return 'org';
    if (n === 'manager' || n === 'lead' || n === 'team lead') return 'team';
    return 'self';
}

export interface ScopeContext {
    orgId: string;
    scope: Scope;
    teamId?: string | null;
    employeeId: string; // the caller's own employee id (req.actorId)
}

/**
 * Build a Prisma `where` fragment restricting rows to what the caller may see,
 * for any table that has `orgId` + `employeeId` columns (dailySummary,
 * attendance, screenshots, activity, etc.).
 *
 *   org   → { orgId }
 *   team  → { orgId, employee: { teamId } }   (join through employee's team)
 *   self  → { orgId, employeeId }
 */
export function scopedEmployeeWhere(ctx: ScopeContext): Record<string, unknown> {
    if (ctx.scope === 'self') {
        return { orgId: ctx.orgId, employeeId: ctx.employeeId };
    }
    if (ctx.scope === 'team') {
        // No team assigned → a manager sees nothing outside themselves.
        if (!ctx.teamId) return { orgId: ctx.orgId, employeeId: ctx.employeeId };
        return { orgId: ctx.orgId, employee: { teamId: ctx.teamId } };
    }
    return { orgId: ctx.orgId };
}

/**
 * Build a Prisma `where` fragment for the Employee table itself (lists,
 * team pages). Same three tiers, but the id/team live on the row directly.
 *
 *   org   → { orgId }
 *   team  → { orgId, teamId }
 *   self  → { orgId, id: employeeId }
 */
export function scopedEmployeeSelfWhere(ctx: ScopeContext): Record<string, unknown> {
    if (ctx.scope === 'self') {
        return { orgId: ctx.orgId, id: ctx.employeeId };
    }
    if (ctx.scope === 'team') {
        if (!ctx.teamId) return { orgId: ctx.orgId, id: ctx.employeeId };
        return { orgId: ctx.orgId, teamId: ctx.teamId };
    }
    return { orgId: ctx.orgId };
}

/**
 * The list of employee ids the caller may see. Handy for services that first
 * resolve an employee set and then aggregate over it.
 * Returns `null` for org scope (meaning "no restriction — all employees").
 */
export async function resolveVisibleEmployeeIds(
    db: PrismaClient,
    ctx: ScopeContext,
): Promise<string[] | null> {
    if (ctx.scope === 'org') return null;
    if (ctx.scope === 'self') return [ctx.employeeId];
    // team
    if (!ctx.teamId) return [ctx.employeeId];
    const rows = await db.employee.findMany({
        where: { orgId: ctx.orgId, teamId: ctx.teamId },
        select: { id: true },
    });
    return rows.map(r => r.id);
}

/**
 * Per-request convenience for route handlers. Reads the scope the tenant
 * middleware put on `req` and returns:
 *   - `empIds`: the employee-id restriction to pass to services
 *               (null = org scope, no restriction)
 *   - `teamId`: the effective team filter — only the admin's UI dropdown
 *               (`queryTeamId`) is honored; scoped roles are already limited
 *               by `empIds`, so their team filter is ignored.
 */
export async function scopeForRequest(
    db: PrismaClient,
    req: FastifyRequest,
    queryTeamId?: string,
): Promise<{ empIds: string[] | null; teamId: string | undefined }> {
    const empIds = await resolveVisibleEmployeeIds(db, {
        orgId: req.orgId,
        scope: req.scope,
        teamId: req.teamId,
        employeeId: req.actorId,
    });
    const teamId = req.scope === 'org' ? queryTeamId : undefined;
    return { empIds, teamId };
}
