// Ticket 09: motivation core — XP / Challenge Points / weekly leaderboard pure rules.
//
// These are pure, network-free, secret-free domain functions.  No React, no DB,
// no Graphile.  Every projection can be rebuilt deterministically from facts.
//
// Product invariants (ADR-0007, CONTEXT.md, PRODUCT.md):
//   - Personal XP belongs only to the individual; never enters a rank.
//   - Challenge Points come ONLY from server-confirmed challenge activities and
//     can enter the weekly leaderboard.
//   - A review event wins XP at most once per rule_version; replay cannot
//     double-award.  Failed requests win nothing.
//   - Raw XP/points are sums over immutable ledgers; leaderboard rank is a
//     rebuildable projection, never authoritative.

/** v1 rule values (Ticket 09 recommended defaults). */
export const XP_PER_ELIGIBLE_REVIEW_EVENT = 5;
export const XP_REVEAL_EARNED = 0;
export const STABLE_RANK_TIEBREAK_BY = "first_reached_at_then_user_id";

/** XP entry reason vocabulary. */
export type XpReason = "initial_review" | "due_review" | "correction" | "void";

/** Challenge Points entry reason vocabulary. */
export type ChallengePointReason = "first_correct_answer" | "adjustment" | "void";

/** A review event fact as observed by the XP rule. */
export interface ReviewEventFacts {
  id: string;
  userId: string;
  cardId: string;
  rating: "again" | "hard" | "good" | "easy";
  /** Whether this is the first valid review for that card+direction. */
  isInitialReview: boolean;
  /** FSRS state of the card BEFORE the review (from state_before). */
  stateBefore:
    { state: "new" | "learning" | "review"; dueAt?: string | null } | Record<string, unknown>;
  /** Server-authoritative event time. */
  reviewedAt: string;
  /** Client idempotency key (identity, not a secret). */
  clientEventId: string;
  /** Server time at which eligibility is evaluated. */
  now: string;
}

export interface XpEntry {
  userId: string;
  reviewEventId: string;
  ruleVersion: number;
  amount: number;
  reason: XpReason;
  sourceEventId: string;
  earnedAt: string;
  /** canonical identity — must be deterministic. */
  identity: string;
}

/**
 * XP eligibility for a single accepted review event.
 *
 * Per Ticket 09 §4.3, 5 XP is earned when the event is a first review of that
 * card+direction (is_initial_review) OR a due review (state_before.state==='review'
 * AND due_at <= now).  Reveal-only actions never produce a review event, so they
 * can never reach here (and earn 0 by rule).
 */
export function isEligibleForXp(ev: ReviewEventFacts): boolean {
  if (ev.isInitialReview) return true;
  if (ev.stateBefore && typeof ev.stateBefore === "object") {
    const s = ev.stateBefore as { state?: string; dueAt?: string | null };
    if (s.state === "review") {
      const dueAt = s.dueAt ? new Date(s.dueAt).getTime() : Number.NaN;
      const now = Number.isNaN(new Date(ev.now).getTime())
        ? Number.NaN
        : new Date(ev.now).getTime();
      if (!Number.isNaN(dueAt) && !Number.isNaN(now)) return dueAt <= now;
    }
  }
  return false;
}

/** Returns the XP amount for an eligible event (rating-independent, fixed 5). */
export function xpAmountForEligible(event: ReviewEventFacts): number {
  return isEligibleForXp(event) ? XP_PER_ELIGIBLE_REVIEW_EVENT : 0;
}

const XP_IDENTITY_VERSION = "v1";

/**
 * Deterministic canonical identity for an XP entry.
 * Same (review_event_id, rule_version) → same identity; used as a de-dupe key,
 * so replay can never double-award.  Uses stable field ordering.
 */
export function buildXpEntryIdentity(input: {
  userId: string;
  reviewEventId: string;
  ruleVersion: number;
  reason: XpReason;
  sourceEventId: string;
  earnedAt: string;
}): string {
  return [
    XP_IDENTITY_VERSION,
    input.userId,
    input.reviewEventId,
    String(input.ruleVersion),
    input.reason,
    input.sourceEventId,
    input.earnedAt,
  ].join("|");
}

/** Construct an XP entry (no persistence; caller commits atomically with the event). */
export function buildXpEntry(event: ReviewEventFacts, ruleVersion: number): XpEntry | null {
  if (!isEligibleForXp(event)) return null;
  return {
    userId: event.userId,
    reviewEventId: event.id,
    ruleVersion,
    amount: XP_PER_ELIGIBLE_REVIEW_EVENT,
    reason: event.isInitialReview ? "initial_review" : "due_review",
    sourceEventId: event.clientEventId,
    earnedAt: event.now,
    identity: buildXpEntryIdentity({
      userId: event.userId,
      reviewEventId: event.id,
      ruleVersion,
      reason: event.isInitialReview ? "initial_review" : "due_review",
      sourceEventId: event.clientEventId,
      earnedAt: event.now,
    }),
  };
}

/** Sum of a list of XP entries (correction/void entries reduce by their amount). */
export function sumXp(entries: Array<{ amount: number }>): number {
  return entries.reduce((acc, e) => acc + e.amount, 0);
}

// ---- Challenge Points ----

const CHALLENGE_IDENTITY_VERSION = "v1";

export interface ChallengePointEntry {
  userId: string;
  challengeWeek: string;
  sourceAttemptId: string;
  ruleVersion: number;
  amount: number;
  reason: ChallengePointReason;
  awardedAt: string;
  identity: string;
}

export interface ChallengePointFacts {
  userId: string;
  challengeWeek: string;
  sourceAttemptId: string;
  amount: number;
  awardedAt: string;
}

/**
 * Deterministic canonical identity for a Challenge Point entry.  Seam-ready:
 * a future Challenge ticket supplies server-confirmed facts; this builds the
 * de-dupe identity now.
 */
export function buildChallengePointEntryIdentity(input: {
  userId: string;
  challengeWeek: string;
  sourceAttemptId: string;
  ruleVersion: number;
}): string {
  return [
    CHALLENGE_IDENTITY_VERSION,
    input.userId,
    input.challengeWeek,
    input.sourceAttemptId,
    String(input.ruleVersion),
  ].join("|");
}

/** Build a Challenge Point entry (no persistence). */
export function buildChallengePointEntry(
  facts: ChallengePointFacts,
  ruleVersion: number,
): ChallengePointEntry {
  return {
    userId: facts.userId,
    challengeWeek: facts.challengeWeek,
    sourceAttemptId: facts.sourceAttemptId,
    ruleVersion,
    amount: facts.amount,
    reason: "first_correct_answer",
    awardedAt: facts.awardedAt,
    identity: buildChallengePointEntryIdentity({
      userId: facts.userId,
      challengeWeek: facts.challengeWeek,
      sourceAttemptId: facts.sourceAttemptId,
      ruleVersion,
    }),
  };
}

// ---- Weekly window (fixed Asia/Shanghai, Monday 00:00 → next Monday 00:00) ----

/** The challenge week boundary is fixed to Asia/Shanghai, never user timezone. */
export const CHALLENGE_WEEK_TIMEZONE = "Asia/Shanghai";
/** Week key format: cw-YYYY-MM-DD (the local Monday). */
export const CHALLENGE_WEEK_KEY_LENGTH = 14;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface WeeklyWindow {
  weekKey: string;
  startIso: string;
  endIso: string;
  timezone: typeof CHALLENGE_WEEK_TIMEZONE;
}

/**
 * Compute the fixed-challenge-week window that contains an instant.
 * Monday 00:00 Asia/Shanghai is the start; the window is exclusive at endIso.
 * Uses Intl to find the Shanghai-local Monday; deterministic.
 */
export function getWeeklyChallengeWindow(instant: Date | string | number): WeeklyWindow {
  const d = new Date(instant);
  // Shanghai is UTC+8, no DST — the local Monday can be derived deterministically.
  const shanghaiMs = d.getTime() + 8 * 3_600_000;
  const day = new Date(shanghaiMs).getUTCDay(); // 0=Sun..6=Sat
  const offsetToMonday = (day + 6) % 7; // days since Monday
  const mondayUtcMs = Math.floor(shanghaiMs / DAY_MS) * DAY_MS - offsetToMonday * DAY_MS;
  const startMs = mondayUtcMs - 8 * 3_600_000; // back to real UTC
  const start = new Date(startMs);
  const end = new Date(startMs + WEEK_MS);
  // weekKey uses the Shanghai-local Monday date, not the UTC date.
  // mondayUtcMs represents Monday 00:00 Shanghai local time as UTC milliseconds.
  const mondayLocal = new Date(mondayUtcMs);
  const month = String(mondayLocal.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(mondayLocal.getUTCDate()).padStart(2, "0");
  return {
    weekKey: `cw-${mondayLocal.getUTCFullYear()}-${month}-${dayOfMonth}`,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    timezone: CHALLENGE_WEEK_TIMEZONE,
  };
}

/** Validate a weekKey of the form cw-YYYY-MM-DD and a real calendar date. */
export function isChallengeWeekKey(value: string): boolean {
  const m = /^cw-(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Calendar validity: month 1-12, day valid for month/year.
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

// ---- Leaderboard ----

export interface LeaderboardRowScore {
  userId: string;
  displayName: string;
  totalPoints: number;
  /** Earliest instant this user reached their current total (tie-break). */
  firstReachedAt: string;
}

/**
 * Deterministic leaderboard comparison: total points DESC, then earlier
 * firstReachedAt first, then stable user_id ASC.  This is the ONLY ordering;
 * it must be identical on every query so rank is stable/recomputable.
 */
export function compareLeaderboardRows(a: LeaderboardRowScore, b: LeaderboardRowScore): number {
  if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
  const aTime = new Date(a.firstReachedAt).getTime();
  const bTime = new Date(b.firstReachedAt).getTime();
  if (aTime !== bTime) return aTime - bTime;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/** Assign dense ranks after sorting with compareLeaderboardRows. */
export function rankLeaderboard(
  rows: LeaderboardRowScore[],
): Array<LeaderboardRowScore & { rank: number }> {
  const sorted = [...rows].sort(compareLeaderboardRows);
  const out: Array<LeaderboardRowScore & { rank: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!;
    const prev = i > 0 ? out[i - 1]! : undefined;
    const sameAsPrev =
      prev !== undefined &&
      prev.totalPoints === row.totalPoints &&
      new Date(prev.firstReachedAt).getTime() === new Date(row.firstReachedAt).getTime();
    // Dense rank: equal totals+tie-break share a rank; next is +1.
    const rank = prev === undefined ? 1 : sameAsPrev ? prev.rank : prev.rank + 1;
    out.push({ ...row, rank });
  }
  return out;
}

/** Rebuild a weekly leaderboard projection from per-user weekly score facts. */
export function rebuildLeaderboardProjection(input: {
  challengeWeek: string;
  scores: LeaderboardRowScore[];
  /** Users who opted out of public ranking (excluded from rows, rank kept). */
  optedOutUserIds: ReadonlySet<string>;
  /** Users not allowed on the board (e.g. disabled) — excluded entirely. */
  excludedUserIds: ReadonlySet<string>;
}): Array<LeaderboardRowScore & { rank: number; isPublic: boolean }> {
  const visible = input.scores.filter(
    (s) => !input.excludedUserIds.has(s.userId) && !input.optedOutUserIds.has(s.userId),
  );
  return rankLeaderboard(visible).map((row) => ({
    ...row,
    isPublic: true,
  }));
}
