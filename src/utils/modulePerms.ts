// Per-module access levels, enforced from each role's `permissions` array.
// The array is ordered to match the frontend Permissions & Access grid:
//   [Dashboard, Teams, Screenshots, Attendance, Reports, Settings, Access Control]
// Each entry is a level: 0 = No Access, 1 = Read Only (view), 2 = Full Access (view + write).

export const MODULES = [
    'dashboard',
    'teams',
    'screenshots',
    'attendance',
    'reports',
    'settings',
    'access_control',
] as const;

export type ModuleKey = typeof MODULES[number];

export const MODULE_INDEX = {
    dashboard: 0,
    teams: 1,
    screenshots: 2,
    attendance: 3,
    reports: 4,
    settings: 5,
    access_control: 6,
} as const;

export const LEVEL = { NONE: 0, VIEW: 1, FULL: 2 } as const;

/**
 * Read the access level for one module out of a role's stored permissions.
 * Tolerates missing / malformed data (old roles, empty arrays) → 0 (No Access).
 */
export function moduleLevel(permissions: unknown, moduleIndex: number): number {
    if (Array.isArray(permissions)) {
        const v = permissions[moduleIndex];
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 2 ? Math.floor(n) : 0;
    }
    return 0;
}
