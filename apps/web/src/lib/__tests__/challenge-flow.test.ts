import { describe, expect, it } from "vitest";
import {
  allAnswered,
  applyVerdict,
  buildInitialFlow,
  currentQuestionIndex,
  isExpired,
  markConflict,
  markEnded,
  markRetryable,
  progressLabel,
  projectResult,
  type ChallengeItemFlow,
  type VerdictFlow,
} from "../challenge-flow";

function item(overrides: Partial<ChallengeItemFlow> = {}): ChallengeItemFlow {
  return {
    position: 1,
    direction: "en_to_zh",
    questionType: "choice",
    englishSpelling: "run",
    meaning: "跑",
    choices: ["跑", "走", "跳", "看"],
    ...overrides,
  };
}

function verdict(overrides: Partial<VerdictFlow> = {}): VerdictFlow {
  return {
    isCorrect: true,
    pointsAwarded: 5,
    kind: "scored",
    correctAnswer: "跑",
    ...overrides,
  };
}

describe("buildInitialFlow", () => {
  it("returns not_eligible when attemptId is null and items empty", () => {
    const flow = buildInitialFlow({
      attemptId: null,
      weekKey: "cw-2026-08-11",
      weekEndIso: "2026-08-18T00:00:00Z",
      items: [],
    });
    expect(flow.phase).toBe("not_eligible");
    expect(flow.attemptId).toBeNull();
    expect(flow.items).toHaveLength(0);
  });

  it("returns in_progress with items when attemptId is present", () => {
    const items = [
      item({ position: 1 }),
      item({ position: 2, direction: "zh_to_en", questionType: "spelling" }),
    ];
    const flow = buildInitialFlow({
      attemptId: "aaa",
      weekKey: "cw-2026-08-11",
      weekEndIso: "2026-08-18T00:00:00Z",
      items,
    });
    expect(flow.phase).toBe("in_progress");
    expect(flow.attemptId).toBe("aaa");
    expect(flow.items).toHaveLength(2);
    expect(flow.perItem).toHaveLength(2);
    expect(flow.currentIndex).toBe(0);
    expect(flow.answeredCount).toBe(0);
  });

  it("stores expiresAtIso from input", () => {
    const expiresAt = "2026-08-12T00:05:00Z";
    const flow = buildInitialFlow({
      attemptId: "aaa",
      weekKey: "cw-2026-08-11",
      weekEndIso: "2026-08-18T00:00:00Z",
      expiresAtIso: expiresAt,
      items: [item()],
    });
    expect(flow.expiresAtIso).toBe(expiresAt);
  });
});

describe("currentQuestionIndex", () => {
  it("returns 0 for in_progress with items", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    expect(currentQuestionIndex(flow)).toBe(0);
  });

  it("returns null for not_eligible", () => {
    const flow = buildInitialFlow({
      attemptId: null,
      weekKey: "cw",
      weekEndIso: "z",
      items: [],
    });
    expect(currentQuestionIndex(flow)).toBeNull();
  });
});

describe("allAnswered", () => {
  it("false when items not all answered", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item(), item({ position: 2 })],
    });
    expect(allAnswered(flow)).toBe(false);
  });

  it("true when all are answered", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    const final = applyVerdict(flow, 1, verdict());
    expect(allAnswered(final)).toBe(true);
  });
});

describe("applyVerdict", () => {
  it("advances to next question and records verdict", () => {
    const items = [
      item({ position: 1 }),
      item({ position: 2, questionType: "spelling", direction: "zh_to_en" }),
    ];
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items,
    });
    const next = applyVerdict(flow, 1, verdict());
    expect(next.perItem[0]?.phase).toBe("answered");
    const firstAnswered = next.perItem[0];
    expect(firstAnswered?.phase === "answered" && firstAnswered.verdict.isCorrect).toBe(true);
    expect(next.currentIndex).toBe(1);
    expect(next.answeredCount).toBe(1);
    expect(next.phase).toBe("in_progress");
  });

  it("marks completed when all items answered", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    const final = applyVerdict(flow, 1, verdict());
    expect(final.phase).toBe("completed");
    expect(allAnswered(final)).toBe(true);
  });

  it("increments scoreEligibleCorrectCount only when pointsAwarded > 0", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    // wrong verdict: pointsAwarded = 0
    const wrong = applyVerdict(
      flow,
      1,
      verdict({ isCorrect: false, pointsAwarded: 0, kind: "wrong" }),
    );
    expect(wrong.scoreEligibleCorrectCount).toBe(0);

    // scored verdict: pointsAwarded = 5
    const scored = applyVerdict(
      flow,
      1,
      verdict({ isCorrect: true, pointsAwarded: 5, kind: "scored" }),
    );
    expect(scored.scoreEligibleCorrectCount).toBe(1);
  });

  it("returns unchanged state for unknown position", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    const same = applyVerdict(flow, 99, verdict());
    expect(same).toEqual(flow);
  });
});

describe("markRetryable", () => {
  it("marks the item as retryable with error", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    const next = markRetryable(flow, 1, "网络断开");
    expect(next.perItem[0]?.phase).toBe("retryable");
    const retryable = next.perItem[0];
    if (retryable?.phase === "retryable") {
      expect(retryable.error).toBe("网络断开");
    }
    // 不推进索引
    expect(next.currentIndex).toBe(0);
  });
});

describe("markConflict", () => {
  it("sets phase to conflict", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    expect(markConflict(flow).phase).toBe("conflict");
  });
});

describe("markEnded", () => {
  it("sets phase to ended (not completed)", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    expect(markEnded(flow).phase).toBe("ended");
  });

  it("preserves completed phase", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    const completed = applyVerdict(flow, 1, verdict());
    expect(completed.phase).toBe("completed");
    expect(markEnded(completed).phase).toBe("completed");
  });
});

describe("isExpired", () => {
  it("returns true when expiresAt is in the past", () => {
    expect(isExpired("2020-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    expect(isExpired("2099-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(false);
  });

  it("returns false when expiresAt is null", () => {
    expect(isExpired(null, "2026-01-01T00:00:00Z")).toBe(false);
  });
});

describe("progressLabel", () => {
  it("shows 0/N for unanswered", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item(), item({ position: 2 })],
    });
    expect(progressLabel(flow)).toBe("0 / 10");
  });

  it("shows correct count", () => {
    const items = [item({ position: 1 }), item({ position: 2 }), item({ position: 3 })];
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items,
    });
    const answered = applyVerdict(flow, 1, verdict());
    const answered2 = applyVerdict(
      answered,
      2,
      verdict({ isCorrect: false, pointsAwarded: 0, kind: "wrong" }),
    );
    // progressLabel counts answered items (all phases with "answered")
    expect(progressLabel(answered2)).toBe("2 / 10");
  });
});

describe("projectResult", () => {
  it("returns null for non-completed flow", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    expect(projectResult(flow)).toBeNull();
  });

  it("projects correct count, points, and reviewed from completed flow", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item(), item({ position: 2, questionType: "spelling", direction: "zh_to_en" })],
    });
    // Q1: correct scored
    let s = applyVerdict(flow, 1, verdict({ isCorrect: true, pointsAwarded: 5, kind: "scored" }));
    // Q2: wrong
    s = applyVerdict(s, 2, verdict({ isCorrect: false, pointsAwarded: 0, kind: "wrong" }));

    const result = projectResult(s);
    expect(result).not.toBeNull();
    expect(result!.totalItems).toBe(2);
    expect(result!.correctCount).toBe(1);
    expect(result!.newChallengePoints).toBe(5);
    expect(result!.alreadyScoredCount).toBe(0);
  });

  it("counts already_scored separately", () => {
    const flow = buildInitialFlow({
      attemptId: "a",
      weekKey: "cw",
      weekEndIso: "z",
      items: [item()],
    });
    const final = applyVerdict(
      flow,
      1,
      verdict({ isCorrect: true, pointsAwarded: 0, kind: "already_scored" }),
    );
    const result = projectResult(final);
    expect(result!.alreadyScoredCount).toBe(1);
    expect(result!.newChallengePoints).toBe(0);
  });
});
