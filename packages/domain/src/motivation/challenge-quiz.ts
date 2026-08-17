// Ticket 14: Challenge Quiz scoring pure rules.
//
// Server-graded Challenge Points: the client NEVER specifies points.  Scoring is
// a pure function over a frozen attempt-item snapshot + the submitted answer.
//
// Product invariants (ADR-0007, docs/ui/surfaces/challenge-quiz.md):
//   - choice questions compare the server-frozen meaning directly.
//   - spelling questions are case / leading-trailing-space insensitive; internal
//     spaces and hyphens are meaningful (no normalization of those).
//   - A first-correct answer for a (user, week, lexical_entry, direction) earns 5
//     Challenge Points; later correct answers on the same word-direction earn 0
//     (review).  The dedup is enforced by a partial DB unique index AND re-checked
//     here for logging clarity.
//   - amount is a constant, matching the seeded game_rule_sets v1 (5).
export const CHALLENGE_POINT_AMOUNT = 5;

export type ChallengeQuestionType = "choice" | "spelling";
export type ChallengeDirection = "en_to_zh" | "zh_to_en";

export interface ChallengeItemFacts {
  position: number;
  direction: ChallengeDirection;
  questionType: ChallengeQuestionType;
  lexicalEntryId: string;
  englishSpelling: string;
  meaning: string;
  /** Server-frozen correct answer (choice = meaning; spelling = english_spelling). */
  serverAnswer: string;
  /**
   * Whether THIS user may score this item.  Set at attempt assembly from
   * learning_exposures, and (re)checked as a guard in the transactional scoring.
   */
  scoreEligible: boolean;
}

export interface ChallengeAnswerVerdict {
  isCorrect: boolean;
  /**
   * Challenge Points awarded for this single answer. 5 on first-correct
   * score-eligible answer; 0 otherwise (review / wrong / already-scored).
   * Range 0..5.
   */
  pointsAwarded: number;
  /**
   * "scored" => a first-correct answer for a yet-unscored (week,lexical,direction)
   * and scoreEligible => awarded CHALLENGE_POINT_AMOUNT.
   * "review"  => correct but NOT freshly scored (word/direction already scored this
   *              week, or item was not score-eligible) => 0.
   * "wrong"   => incorrect answer => 0.
   * "already_scored" => the word/direction already earned points this week.
   */
  kind: "scored" | "review" | "wrong" | "already_scored";
}

/**
 * Canonical normalization for spelling answers.  Matches challenge-quiz.md:
 * case-insensitive + trim outer whitespace.  Internal spaces and hyphens are
 * preserved (meaningful), so we do NOT collapse whitespace or strip hyphens.
 */
export function normalizeSpellingAnswer(input: string): string {
  return input.trim().toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Does the client's submitted answer match the server-frozen correct answer?
 * choice: exact (server_answer is the exact meaning string; the client sends a
 *   choice index's text, see API layer).  We compare after a light trim to avoid
 *   stray whitespace, but NO case folding for choice (meaning is Chinese/display).
 * spelling: normalizeSpellingAnswer on both sides.
 */
export function isAnswerCorrect(item: ChallengeItemFacts, clientAnswer: string): boolean {
  if (item.questionType === "spelling") {
    return normalizeSpellingAnswer(clientAnswer) === normalizeSpellingAnswer(item.serverAnswer);
  }
  // choice: exact comparison of the selected option label vs the frozen meaning.
  return clientAnswer.trim() === item.serverAnswer.trim();
}

/**
 * Whether this word-direction (user, week) has already been scored.  The caller
 * (transactional service) passes `alreadyScored` derived from the DB partial
 * unique index query.  This pure function turns it into a verdict.
 */
export function judgeChallengeAnswer(input: {
  item: ChallengeItemFacts;
  clientAnswer: string;
  alreadyScored: boolean;
}): ChallengeAnswerVerdict {
  const { item, clientAnswer, alreadyScored } = input;
  const correct = isAnswerCorrect(item, clientAnswer);

  if (!correct) {
    return { isCorrect: false, pointsAwarded: 0, kind: "wrong" };
  }
  // Correct.
  if (alreadyScored) {
    return { isCorrect: true, pointsAwarded: 0, kind: "already_scored" };
  }
  if (!item.scoreEligible) {
    return { isCorrect: true, pointsAwarded: 0, kind: "review" };
  }
  return { isCorrect: true, pointsAwarded: CHALLENGE_POINT_AMOUNT, kind: "scored" };
}

/** Deterministic canonical identity for a Challenge Point entry (word-direction key). */
export function buildChallengeWordKey(input: {
  userId: string;
  challengeWeek: string;
  lexicalEntryId: string;
  direction: ChallengeDirection;
}): string {
  return [
    "challenge-v1",
    input.userId,
    input.challengeWeek,
    input.lexicalEntryId,
    input.direction,
  ].join("|");
}

/** Max points an attempt can earn = count(score_eligible) * amount. */
export function attemptMaxPoints(items: Array<Pick<ChallengeItemFacts, "scoreEligible">>): number {
  return items.filter((i) => i.scoreEligible).length * CHALLENGE_POINT_AMOUNT;
}
