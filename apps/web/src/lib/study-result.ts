/**
 * Study-result display logic — pure functions, no React, no DOM, no Next.
 *
 * Extracted from study/[sessionId]/page.tsx and result/page.tsx so that
 * snapshot projection and storage are unit-testable without any UI infra.
 *
 * Snapshot semantics (per study.md / result.md):
 *   - The snapshot is a *display cache* of accepted server events for this session;
 *     it is NOT the source of learning truth.
 *   - `readResultSnapshot` returns null for missing/malformed/cross-session data.
 *   - `clearResultSnapshot` is only called after getStudyToday succeeds (avoid data
 *     loss on network failure).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ByKind {
  newLearning: number;
  initial: number;
  review: number;
}

export interface SessionResultSnapshot {
  sessionId: string;
  startedAt: string;
  totalItems: number;
  completedCount: number;
  /** Per-kind counts from the frozen plan snapshot. */
  byKind: ByKind;
  /** Server-authoritative XP earned by accepted events in this session. */
  xpAwarded: number;
}

/**
 * Derived presentation state for the result page.
 * All fields are projections of the snapshot — no fabricated fields.
 */
export interface ResultPresentation {
  completedCount: number;
  byKind: ByKind;
  /** True when getStudyToday reports eligible remaining work. */
  hasRemainingWork: boolean;
  /** XP presentation mode derived from xpAwarded. */
  xpState: ResultXpState;
}

export type ResultXpState =
  { variant: "earned"; amount: number } | { variant: "zero" } | { variant: "unavailable" };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const RESULT_SNAPSHOT_KEY = "motro.result-snapshot";

/** Minimal shape guard for parsed snapshot. */
function isValidSnapshot(obj: unknown): obj is SessionResultSnapshot {
  if (typeof obj !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(obj);
    if (parsed === null || typeof parsed !== "object") return false;
    const s = parsed as Record<string, unknown>;
    return typeof s.sessionId === "string" && typeof s.totalItems === "number";
  } catch {
    return false;
  }
}

/**
 * Read snapshot from sessionStorage.
 * Returns null when: not present, malformed, missing required fields, or
 * belongs to a different session than `expectedSessionId`.
 */
export function readResultSnapshot(expectedSessionId?: string): SessionResultSnapshot | null {
  try {
    const raw = sessionStorage.getItem(RESULT_SNAPSHOT_KEY);
    if (raw === null || !isValidSnapshot(raw)) return null;
    const parsed = JSON.parse(raw) as SessionResultSnapshot;
    if (expectedSessionId !== undefined && parsed.sessionId !== expectedSessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write snapshot to sessionStorage (best-effort). */
export function saveResultSnapshot(snapshot: SessionResultSnapshot): void {
  try {
    sessionStorage.setItem(RESULT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Private/incognito mode — result page falls back to honest "completed" state.
  }
}

/**
 * Remove snapshot from sessionStorage.
 * Only call after getStudyToday succeeds — never on network failure,
 * to avoid permanently losing display data.
 */
export function clearResultSnapshot(): void {
  try {
    sessionStorage.removeItem(RESULT_SNAPSHOT_KEY);
  } catch {
    // Ignore — result page has already read the snapshot.
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project a snapshot + hasRemainingWork flag into the full presentation state.
 * Pure function — all fields are derived from inputs, nothing fabricated.
 */
export function projectResult(
  snapshot: SessionResultSnapshot | null,
  hasRemainingWork: boolean,
): ResultPresentation {
  const zeroKind: ByKind = { newLearning: 0, initial: 0, review: 0 };
  const xpAmount = snapshot?.xpAwarded ?? 0;
  return {
    completedCount: snapshot?.completedCount ?? 0,
    byKind: snapshot?.byKind ?? zeroKind,
    hasRemainingWork,
    xpState:
      snapshot === null
        ? { variant: "unavailable" }
        : xpAmount > 0
          ? { variant: "earned", amount: xpAmount }
          : { variant: "zero" },
  };
}

/**
 * Compute session completion summary for the result page conclusion line.
 * Returns null when snapshot is unavailable.
 */
export function completionSummary(snapshot: SessionResultSnapshot | null): string | null {
  if (snapshot === null) return null;
  return `你完成了本次安排的 ${snapshot.completedCount} 项学习。`;
}
