// Ticket 09 motivation domain unit tests.
// Pure-function coverage: XP identity/eligibility/dedup, Challenge Points identity,
// weekly window, tie-break/sorting, empty board, opt-out, disabled, projection rebuild.
import { describe, expect, it } from "vitest";
import {
  buildChallengePointEntry,
  buildChallengePointEntryIdentity,
  buildXpEntry,
  buildXpEntryIdentity,
  compareLeaderboardRows,
  getWeeklyChallengeWindow,
  isChallengeWeekKey,
  isEligibleForXp,
  rankLeaderboard,
  rebuildLeaderboardProjection,
  sumXp,
  XP_PER_ELIGIBLE_REVIEW_EVENT,
  type ReviewEventFacts,
  type LeaderboardRowScore,
} from "./rules.js";

function reviewFacts(over: Partial<ReviewEventFacts> = {}): ReviewEventFacts {
  return {
    id: "evt-1",
    userId: "user-1",
    cardId: "card-1",
    rating: "good",
    isInitialReview: true,
    stateBefore: { state: "new" },
    reviewedAt: "2026-08-10T00:00:00Z",
    clientEventId: "client-event-1",
    now: "2026-08-10T00:00:00Z",
    ...over,
  };
}

describe("isEligibleForXp", () => {
  it("initial review earns XP", () => {
    expect(isEligibleForXp(reviewFacts({ isInitialReview: true }))).toBe(true);
  });

  it("due review (state=review, due<=now) earns XP", () => {
    expect(
      isEligibleForXp(
        reviewFacts({
          isInitialReview: false,
          stateBefore: { state: "review", dueAt: "2026-08-09T00:00:00Z" },
        }),
      ),
    ).toBe(true);
  });

  it("non-due (state=review, due>now) earns no XP", () => {
    expect(
      isEligibleForXp(
        reviewFacts({
          isInitialReview: false,
          stateBefore: { state: "review", dueAt: "2099-01-01T00:00:00Z" },
        }),
      ),
    ).toBe(false);
  });

  it("new/learning card (not initial, not due) earns no XP", () => {
    expect(
      isEligibleForXp(reviewFacts({ isInitialReview: false, stateBefore: { state: "learning" } })),
    ).toBe(false);
  });

  it("rating does not change XP", () => {
    const again = isEligibleForXp(reviewFacts({ rating: "again" }));
    const easy = isEligibleForXp(reviewFacts({ rating: "easy" }));
    expect(again).toBe(easy);
  });
});

describe("buildXpEntry + identity determinism", () => {
  it("same inputs → same identity (deterministic)", () => {
    const a = buildXpEntryIdentity({
      userId: "u1",
      reviewEventId: "rev-1",
      ruleVersion: 1,
      reason: "initial_review",
      sourceEventId: "ce-1",
      earnedAt: "2026-08-10T00:00:00Z",
    });
    const b = buildXpEntryIdentity({
      userId: "u1",
      reviewEventId: "rev-1",
      ruleVersion: 1,
      reason: "initial_review",
      sourceEventId: "ce-1",
      earnedAt: "2026-08-10T00:00:00Z",
    });
    expect(a).toBe(b);
  });

  it("identity differs when rule_version differs", () => {
    const a = buildXpEntryIdentity({
      userId: "u1",
      reviewEventId: "rev-1",
      ruleVersion: 1,
      reason: "due_review",
      sourceEventId: "ce-1",
      earnedAt: "2026-08-10T00:00:00Z",
    });
    const b = buildXpEntryIdentity({
      userId: "u1",
      reviewEventId: "rev-1",
      ruleVersion: 2,
      reason: "due_review",
      sourceEventId: "ce-1",
      earnedAt: "2026-08-10T00:00:00Z",
    });
    expect(a).not.toBe(b);
  });

  it("eligible event → XP entry amount = 5", () => {
    const entry = buildXpEntry(reviewFacts({ isInitialReview: true }), 1);
    expect(entry).not.toBeNull();
    expect(entry!.amount).toBe(XP_PER_ELIGIBLE_REVIEW_EVENT);
    expect(entry!.reason).toBe("initial_review");
  });

  it("ineligible event → null (never awarded)", () => {
    const entry = buildXpEntry(
      reviewFacts({ isInitialReview: false, stateBefore: { state: "learning" } }),
      1,
    );
    expect(entry).toBeNull();
  });

  it("sumXp sums amounts (compensation entries can reduce)", () => {
    expect(sumXp([{ amount: 5 }, { amount: 5 }, { amount: 5 }])).toBe(15);
    expect(sumXp([{ amount: 5 }, { amount: -5 }])).toBe(0);
  });
});

describe("challenge point identity (seam)", () => {
  it("deterministic identity", () => {
    const a = buildChallengePointEntryIdentity({
      userId: "u1",
      challengeWeek: "cw-2026-08-10",
      sourceAttemptId: "att-1",
      ruleVersion: 1,
    });
    const b = buildChallengePointEntryIdentity({
      userId: "u1",
      challengeWeek: "cw-2026-08-10",
      sourceAttemptId: "att-1",
      ruleVersion: 1,
    });
    expect(a).toBe(b);
  });

  it("different attempt → different identity", () => {
    const a = buildChallengePointEntryIdentity({
      userId: "u1",
      challengeWeek: "cw-2026-08-10",
      sourceAttemptId: "att-1",
      ruleVersion: 1,
    });
    const b = buildChallengePointEntryIdentity({
      userId: "u1",
      challengeWeek: "cw-2026-08-10",
      sourceAttemptId: "att-2",
      ruleVersion: 1,
    });
    expect(a).not.toBe(b);
  });

  it("buildChallengePointEntry sets reason=first_correct_answer", () => {
    const e = buildChallengePointEntry(
      {
        userId: "u1",
        challengeWeek: "cw-2026-08-10",
        sourceAttemptId: "att-1",
        amount: 5,
        awardedAt: "2026-08-11T00:00:00Z",
      },
      1,
    );
    expect(e.reason).toBe("first_correct_answer");
    expect(e.amount).toBe(5);
  });
});

describe("weekly challenge window", () => {
  it("week key is cw-YYYY-MM-DD (Shanghai Monday)", () => {
    // 2026-08-10 is a Monday in Asia/Shanghai.
    const w = getWeeklyChallengeWindow("2026-08-10T00:00:00+08:00");
    expect(w.weekKey).toBe("cw-2026-08-10");
    expect(w.timezone).toBe("Asia/Shanghai");
  });

  it("isChallengeWeekKey validates shape", () => {
    expect(isChallengeWeekKey("cw-2026-08-10")).toBe(true);
    expect(isChallengeWeekKey("cw-2026-13-40")).toBe(false);
    expect(isChallengeWeekKey("2026-08-10")).toBe(false);
  });

  it("window spans Monday 00:00 → next Monday 00:00 (7 days)", () => {
    const w = getWeeklyChallengeWindow("2026-08-12T10:00:00+08:00");
    const start = new Date(w.startIso).getTime();
    const end = new Date(w.endIso).getTime();
    expect(end - start).toBe(7 * 24 * 3600 * 1000);
  });
});

function score(over: Partial<LeaderboardRowScore>): LeaderboardRowScore {
  return {
    userId: "u-unknown",
    displayName: "Name",
    totalPoints: 0,
    firstReachedAt: "2026-08-10T00:00:00Z",
    ...over,
  };
}

describe("leaderboard tie-break + ranking", () => {
  it("sorts by total desc", () => {
    const a = score({ userId: "a", totalPoints: 10 });
    const b = score({ userId: "b", totalPoints: 20 });
    expect(compareLeaderboardRows(a, b)).toBeGreaterThan(0); // b (20) before a (10)
  });

  it("ties break by earlier first_reached_at", () => {
    const a = score({ userId: "a", totalPoints: 10, firstReachedAt: "2026-08-11T00:00:00Z" });
    const b = score({ userId: "b", totalPoints: 10, firstReachedAt: "2026-08-10T00:00:00Z" });
    expect(compareLeaderboardRows(a, b)).toBeGreaterThan(0); // b earlier → first
  });

  it("full tie breaks by user_id asc", () => {
    const a = score({ userId: "z", totalPoints: 10, firstReachedAt: "2026-08-10T00:00:00Z" });
    const b = score({ userId: "a", totalPoints: 10, firstReachedAt: "2026-08-10T00:00:00Z" });
    expect(compareLeaderboardRows(a, b)).toBeGreaterThan(0); // a (id lower) first
  });

  it("dense rank: ties share a rank, next is +1", () => {
    const rows = [
      score({ userId: "a", totalPoints: 20, firstReachedAt: "2026-08-10T00:00:00Z" }),
      score({ userId: "b", totalPoints: 15, firstReachedAt: "2026-08-10T00:00:00Z" }),
      score({ userId: "c", totalPoints: 15, firstReachedAt: "2026-08-10T00:00:00Z" }),
      score({ userId: "d", totalPoints: 5, firstReachedAt: "2026-08-10T00:00:00Z" }),
    ];
    const ranked = rankLeaderboard(rows);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 3]);
  });

  it("stable ordering across repeated sorts (same result)", () => {
    const rows = [score({ userId: "a", totalPoints: 5 }), score({ userId: "b", totalPoints: 5 })];
    const once = rankLeaderboard(rows)
      .map((r) => r.userId)
      .join(",");
    const twice = rankLeaderboard(rows)
      .map((r) => r.userId)
      .join(",");
    expect(once).toBe(twice);
  });
});

describe("rebuildLeaderboardProjection", () => {
  it("empty board returns []", () => {
    expect(
      rebuildLeaderboardProjection({
        challengeWeek: "cw-2026-08-10",
        scores: [],
        optedOutUserIds: new Set(),
        excludedUserIds: new Set(),
      }),
    ).toEqual([]);
  });

  it("disabled users are excluded from rows", () => {
    const rows = rebuildLeaderboardProjection({
      challengeWeek: "cw-2026-08-10",
      scores: [
        score({ userId: "a", displayName: "A", totalPoints: 10 }),
        score({ userId: "disabled", displayName: "D", totalPoints: 50 }),
      ],
      optedOutUserIds: new Set(),
      excludedUserIds: new Set(["disabled"]),
    });
    expect(rows.map((r) => r.userId)).toEqual(["a"]);
  });

  it("opt-out users are excluded from rows", () => {
    const rows = rebuildLeaderboardProjection({
      challengeWeek: "cw-2026-08-10",
      scores: [
        score({ userId: "a", displayName: "A", totalPoints: 10 }),
        score({ userId: "private", displayName: "P", totalPoints: 30 }),
      ],
      optedOutUserIds: new Set(["private"]),
      excludedUserIds: new Set(),
    });
    expect(rows.map((r) => r.userId)).toEqual(["a"]);
  });

  it("rebuild is deterministic (same facts → same ranks)", () => {
    const opts = {
      challengeWeek: "cw-2026-08-10",
      scores: [
        score({ userId: "a", displayName: "A", totalPoints: 20 }),
        score({
          userId: "b",
          displayName: "B",
          totalPoints: 20,
          firstReachedAt: "2026-08-11T00:00:00Z",
        }),
        score({ userId: "c", displayName: "C", totalPoints: 10 }),
      ],
      optedOutUserIds: new Set<string>(),
      excludedUserIds: new Set<string>(),
    };
    const r1 = rebuildLeaderboardProjection(opts);
    const r2 = rebuildLeaderboardProjection(opts);
    expect(r1.map((r) => r.userId)).toEqual(r2.map((r) => r.userId));
    expect(r1.map((r) => r.rank)).toEqual(r2.map((r) => r.rank));
  });
});
