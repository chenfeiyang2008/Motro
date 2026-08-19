// Ticket 20: account/membership domain — pure status & eligibility rules.
//
// These are pure, network-free, secret-free domain functions.
// No React, no DB, no Nest. Every status is computed from facts so it can be
// deterministically unit-tested.
//
// Product invariants (Ticket 20 spec):
//   - Effective membership status is computed SERVER-SIDE.
//   - No row / dirty data / expired / unknown → fail-closed to 'free'.
//   - 'member' plan is 'active' only while expires_at is null
//     (indefinite) or >= now; on expiry the next server judgment restores free.
//   - Membership is entirely separate from users.role, XP, and daily_budget_minutes.

const FREE_DAILY_MINUTES = 15;

export type MembershipPlan = "member" | "free";
export type MembershipStatus = "active" | "expired";

/** A row from the memberships table (only the fields the rules need). */
export interface MembershipFact {
  plan: MembershipPlan;
  status: MembershipStatus;
  startedAt: string; // ISO
  expiresAt: string | null; // null = indefinite
}

/** Effective entitlement computed from a membership fact (fail-closed to 'free'). */
export type EffectiveEntitlement =
  | { kind: "free"; dailyLimitMinutes: typeof FREE_DAILY_MINUTES }
  | { kind: "member"; dailyLimitMinutes: number }; // number.POSITIVE_INFINITY semantics

export type DailyLimitMinutes = number;

export const FREE_DAILY_LIMIT_MINUTES: DailyLimitMinutes = FREE_DAILY_MINUTES;

/**
 * Compute the effective entitlement for a user from a (possibly null/missing)
 * membership fact. Fail-closed: anything not strictly a live member → free.
 *
 * A 'free' plan is always free-limit. A 'member' plan is unlimited only when
 * status === 'active' and (expires_at IS NULL OR expires_at > now). Anything
 * else (no row, expired, unknown shape) is fail-closed to free.
 */
export function effectiveEntitlement(
  fact: MembershipFact | null | undefined,
  now: Date = new Date(),
): EffectiveEntitlement {
  // Fail-closed: missing / malformed → free.
  if (fact === null || fact === undefined) {
    return { kind: "free", dailyLimitMinutes: FREE_DAILY_LIMIT_MINUTES } as EffectiveEntitlement;
  }
  if (fact.plan !== "member") {
    return { kind: "free", dailyLimitMinutes: FREE_DAILY_LIMIT_MINUTES } as EffectiveEntitlement;
  }
  if (fact.status !== "active") {
    // 'expired' member plan → free limits.
    return { kind: "free", dailyLimitMinutes: FREE_DAILY_LIMIT_MINUTES } as EffectiveEntitlement;
  }
  if (fact.expiresAt !== null) {
    const expires = new Date(fact.expiresAt);
    if (Number.isNaN(expires.getTime())) {
      return { kind: "free", dailyLimitMinutes: FREE_DAILY_LIMIT_MINUTES } as EffectiveEntitlement;
    }
    if (expires.getTime() <= now.getTime()) {
      // Expired by the authoritative server instant → free.
      return { kind: "free", dailyLimitMinutes: FREE_DAILY_LIMIT_MINUTES } as EffectiveEntitlement;
    }
  }
  // Live, indefinite (expiresAt null) or future-dated expiring member.
  return { kind: "member", dailyLimitMinutes: Infinity };
}

/**
 * Compute the daily budget allowed for a user given a membership fact.
 * Member → Infinity; free/expired/unknown → FREE_DAILY_LIMIT_MINUTES.
 */
export function dailyLimitFor(
  fact: MembershipFact | null | undefined,
  now?: Date,
): DailyLimitMinutes {
  const e = effectiveEntitlement(fact, now);
  return e.dailyLimitMinutes;
}

/** True when accrued minutes already meet or exceed the entitlement limit. */
export function isDailyLimitReached(
  fact: MembershipFact | null | undefined,
  accruedMinutes: number,
  now?: Date,
): boolean {
  const limit = dailyLimitFor(fact, now);
  return accruedMinutes >= limit;
}

/**
 * Public membership projection for /auth/me. Never exposes internal audit ids,
 * actor ids, request_ids, or row timestamps beyond a human-safe summary.
 * status is the SERVER-COMPUTED effective entitlement status.
 */
export interface MembershipProjection {
  plan: MembershipPlan;
  status: "member" | "free"; // effective: 'member' only when active & unexpired, else 'free'
  expiresAt: string | null;
}
