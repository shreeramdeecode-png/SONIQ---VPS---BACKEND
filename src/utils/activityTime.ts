// Trackpilots counts an app as "in use" through brief pauses — the foreground app
// stays active during short (< ~60s) gaps between its activity events. We match that:
// each event counts its own duration PLUS any sub-threshold gap to the next event
// (attributed to the current segment). This is why Teemly's raw sum-of-durations came
// out ~10% below Trackpilots (e.g. Antigravity 8m34s vs 12m1s) — the difference was
// exactly the sub-60s pauses. Idle time is a SEPARATE signal and is never gap-filled.

export const ACTIVE_GAP_SECONDS = 60;

export interface TimedSegment {
    start: number; // ms epoch
    end: number;   // ms epoch
    key: string;   // grouping key (productivity status, or app name)
}

/**
 * Sum seconds per key, filling gaps shorter than `thresholdSec` between consecutive
 * segments (attributed to the earlier segment's key). Matches Trackpilots' "continuous
 * foreground" counting. Returns a Map of key → seconds (rounded).
 */
export function gapFilledByKey(segments: TimedSegment[], thresholdSec = ACTIVE_GAP_SECONDS): Map<string, number> {
    const list = segments.filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
    const acc = new Map<string, number>();
    const add = (k: string, sec: number) => acc.set(k, (acc.get(k) ?? 0) + sec);

    for (let i = 0; i < list.length; i++) {
        const seg = list[i]!;
        add(seg.key, (seg.end - seg.start) / 1000); // the segment's own active time
        const next = list[i + 1];
        if (next) {
            const gap = (next.start - seg.end) / 1000;
            if (gap > 0 && gap < thresholdSec) add(seg.key, gap); // brief pause = still in use
        }
    }
    for (const [k, v] of acc) acc.set(k, Math.round(v));
    return acc;
}
