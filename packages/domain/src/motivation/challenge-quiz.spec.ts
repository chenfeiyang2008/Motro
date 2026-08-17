// Ticket 14: Challenge Quiz scoring pure-function unit tests.
// Covers: spelling normalization, verdict correctness, points award (first-correct),
// review/already_scored de-duplication, wrong answers, and max-points math.
import { describe, expect, it } from "vitest";
import {
  CHALLENGE_POINT_AMOUNT,
  attemptMaxPoints,
  buildChallengeWordKey,
  isAnswerCorrect,
  judgeChallengeAnswer,
  normalizeSpellingAnswer,
  type ChallengeItemFacts,
} from "./challenge-quiz.js";

function item(over: Partial<ChallengeItemFacts> = {}): ChallengeItemFacts {
  return {
    position: 1,
    direction: "en_to_zh",
    questionType: "choice",
    lexicalEntryId: "lex-1",
    englishSpelling: "run",
    meaning: "跑",
    serverAnswer: "跑",
    scoreEligible: true,
    ...over,
  };
}

describe("normalizeSpellingAnswer", () => {
  it("case-insensitive + trims outer whitespace", () => {
    expect(normalizeSpellingAnswer("  RUN ")).toBe("run");
    expect(normalizeSpellingAnswer("  rUn")).toBe("run");
  });

  it("preserves internal spaces and hyphens (meaningful)", () => {
    expect(normalizeSpellingAnswer(" ice cream ")).toBe("ice cream");
    expect(normalizeSpellingAnswer("well-known")).toBe("well-known");
    // Internal spaces collapse to a single space (outer trimmed).
    expect(normalizeSpellingAnswer("ice   cream")).toBe("ice cream");
    // Hyphen is meaningful: NOT equal to a space.
    expect(normalizeSpellingAnswer("well-known")).not.toBe("well known");
  });
});

describe("isAnswerCorrect", () => {
  it("choice compares the selected option text to the frozen meaning", () => {
    expect(isAnswerCorrect(item(), "跑")).toBe(true);
    expect(isAnswerCorrect(item(), "别的")).toBe(false);
  });

  it("spelling is case/outer-space-insensitive but internal-space/hyphen-sensitive", () => {
    const it = item({ questionType: "spelling", serverAnswer: "run", direction: "zh_to_en" });
    expect(isAnswerCorrect(it, "RUN")).toBe(true);
    expect(isAnswerCorrect(it, "  run ")).toBe(true);
    expect(isAnswerCorrect(it, "ran")).toBe(false);
    // Hyphen meaningful for a hyphenated word.
    const it2 = item({ questionType: "spelling", serverAnswer: "well-known" });
    expect(isAnswerCorrect(it2, "well known")).toBe(false);
    expect(isAnswerCorrect(it2, "WELL-KNOWN")).toBe(true);
  });
});

describe("judgeChallengeAnswer", () => {
  it("first-correct score-eligible answer awards 5 points (kind=scored)", () => {
    const v = judgeChallengeAnswer({ item: item(), clientAnswer: "跑", alreadyScored: false });
    expect(v).toEqual({ isCorrect: true, pointsAwarded: CHALLENGE_POINT_AMOUNT, kind: "scored" });
  });

  it("answer already scored this word/direction => correct but 0 points (already_scored)", () => {
    const v = judgeChallengeAnswer({ item: item(), clientAnswer: "跑", alreadyScored: true });
    expect(v).toEqual({ isCorrect: true, pointsAwarded: 0, kind: "already_scored" });
  });

  it("correct but NOT score-eligible => review, 0 points", () => {
    const v = judgeChallengeAnswer({
      item: item({ scoreEligible: false }),
      clientAnswer: "跑",
      alreadyScored: false,
    });
    expect(v).toEqual({ isCorrect: true, pointsAwarded: 0, kind: "review" });
  });

  it("wrong answer => 0 points, kind=wrong", () => {
    const v = judgeChallengeAnswer({ item: item(), clientAnswer: "错", alreadyScored: false });
    expect(v).toEqual({ isCorrect: false, pointsAwarded: 0, kind: "wrong" });
  });

  it("wrong spelling with trimmed/case insensitivity still wrong", () => {
    const v = judgeChallengeAnswer({
      item: item({ questionType: "spelling", serverAnswer: "run" }),
      clientAnswer: "xyz",
      alreadyScored: false,
    });
    expect(v).toEqual({ isCorrect: false, pointsAwarded: 0, kind: "wrong" });
  });
});

describe("buildChallengeWordKey", () => {
  it("is deterministic over (user, week, lexical, direction)", () => {
    const a = buildChallengeWordKey({
      userId: "u",
      challengeWeek: "cw-2026-08-11",
      lexicalEntryId: "l",
      direction: "en_to_zh",
    });
    const b = buildChallengeWordKey({
      userId: "u",
      challengeWeek: "cw-2026-08-11",
      lexicalEntryId: "l",
      direction: "en_to_zh",
    });
    expect(a).toBe(b);
  });

  it("differs when direction differs", () => {
    const a = buildChallengeWordKey({
      userId: "u",
      challengeWeek: "cw-2026-08-11",
      lexicalEntryId: "l",
      direction: "en_to_zh",
    });
    const b = buildChallengeWordKey({
      userId: "u",
      challengeWeek: "cw-2026-08-11",
      lexicalEntryId: "l",
      direction: "zh_to_en",
    });
    expect(a).not.toBe(b);
  });
});

describe("attemptMaxPoints", () => {
  it("is count(score_eligible) × 5", () => {
    expect(
      attemptMaxPoints([
        { scoreEligible: true },
        { scoreEligible: false },
        { scoreEligible: true },
        { scoreEligible: true },
      ]),
    ).toBe(3 * CHALLENGE_POINT_AMOUNT);
  });
});
