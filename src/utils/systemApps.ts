/**
 * App names Trackpilots reports that are NOT real work: screen-lock states, idle
 * time, and the monitoring agent's own runtime.
 *
 * Matching is deliberately CASE-INSENSITIVE. The agent reports the app as
 * "Trackpilots" (lower-case p) while this list said "TrackPilots", and Postgres
 * string matching is case-sensitive — so an exact match silently let ~18h of agent
 * runtime through as employee work time. Normalising avoids that class of bug
 * recurring if the agent's casing shifts again.
 *
 * This is the single source of truth; do not re-declare the list elsewhere.
 */
export const SYSTEM_APP_BLOCKLIST = ['Locked', 'Idle', 'Screen Lock', 'TrackPilots', 'Activity ITR'];

const NORMALISED = new Set(SYSTEM_APP_BLOCKLIST.map(n => n.toLowerCase()));

/** True when an app name is a system state rather than real work. */
export function isSystemApp(appName: string | null | undefined): boolean {
    if (!appName) return false;
    return NORMALISED.has(appName.trim().toLowerCase());
}

/**
 * Prisma `where` fragment that excludes system apps case-insensitively.
 * Prisma's `in` has no case-insensitive mode, so this expands to NOT/OR equals.
 * Spread it into a where clause that has no other top-level `NOT`.
 */
export const excludeSystemAppsFilter = {
    NOT: {
        OR: SYSTEM_APP_BLOCKLIST.map(name => ({
            appName: { equals: name, mode: 'insensitive' as const },
        })),
    },
};
