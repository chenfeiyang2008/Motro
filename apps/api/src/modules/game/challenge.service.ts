// Ticket 14: server-graded Challenge Quiz service.
//
// Closes the Challenge Points seam: GET /challenge/current assembles a frozen
// 10-question attempt from the user's exposed released course items; POST
// /challenge/attempts/:attemptId/answers submits one answer, grades it
// server-side, and appends Challenge Points only for first-correct answers of a
// (user, week, lexical_entry, direction), once per week (ADR-0007).  Daily XP
// never enters this path; the leaderboard reads only challenge_point_entries.
//
// Idempotency: the client sends a client_event_id per answer.  Same (attempt,
// position) => frozen first response; concurrent/duplicate submit collapses to
// one graded fact.  Scoring runs inside one transaction (BEGIN..COMMIT) so a
// failure leaves no half-written points.
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import {
  attemptMaxPoints,
  getWeeklyChallengeWindow,
  judgeChallengeAnswer,
  type ChallengeDirection,
  type ChallengeItemFacts,
} from "@motro/domain";

const RULE_VERSION = 1;
const ATTEMPT_TOTAL_ITEMS = 10;
const ATTEMPT_TTL_MS = 5 * 60 * 1000; // 5 minutes (ADR-0007)

interface AttemptItemRow {
  item_id: string;
  position: number;
  direction: ChallengeDirection;
  question_type: "choice" | "spelling";
  lexical_entry_id: string;
  english_spelling: string;
  meaning: string;
  server_answer: string;
  score_eligible: boolean;
}

interface AttemptRow {
  id: string;
  user_id: string;
  challenge_week: string;
  total_items: number;
  status: string;
  expires_at: Date;
  created_at: Date;
  points_earned: number;
  max_points: number;
}

@Injectable()
export class ChallengeService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Get (or create) the current week's in-progress attempt for the user and
   * return its frozen question set.  If an active attempt already exists, reuse
   * it; otherwise assemble a fresh 10-question attempt.
   */
  async getCurrentChallenge(userId: string) {
    const window = getWeeklyChallengeWindow(Date.now());
    const weekKey = window.weekKey;

    // Reuse an existing in-progress attempt for this user+week.
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM challenge_attempts
       WHERE user_id=$1 AND challenge_week=$2 AND status='in_progress' AND expires_at > now()
       LIMIT 1`,
      [userId, weekKey],
    );
    if (existing.rows[0]) {
      const attempt = await this.loadAttempt(existing.rows[0].id, userId);
      return this.toCurrentDto(attempt, weekKey);
    }

    // Assemble a new attempt: 10 questions chosen from this user's exposed words.
    const items = await this.assembleItems(userId);
    if (items.length === 0) {
      // No eligible words yet — leaderboard surface treats this as "coming soon".
      return {
        challengeWeek: weekKey,
        weekStart: window.startIso,
        weekEnd: window.endIso,
        timezone: window.timezone,
        attemptId: null,
        status: "in_progress",
        expiresAt: null,
        items: [] as unknown[],
        maxPoints: 0,
      };
    }
    const maxPoints = attemptMaxPoints(items.map((i) => ({ scoreEligible: i.score_eligible })));
    const created = await this.pool.query<AttemptRow>(
      `INSERT INTO challenge_attempts (user_id, challenge_week, total_items, expires_at, max_points)
       VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond', $5)
       RETURNING *`,
      [userId, weekKey, items.length, ATTEMPT_TTL_MS, maxPoints],
    );
    const attemptId = created.rows[0]!.id;

    // Insert frozen item snapshots.
    for (const it of items) {
      await this.pool.query(
        `INSERT INTO challenge_attempt_items
           (attempt_id, position, direction, question_type, lexical_entry_id,
            english_spelling, meaning, server_answer, score_eligible)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          attemptId,
          it.position,
          it.direction,
          it.question_type,
          it.lexical_entry_id,
          it.english_spelling,
          it.meaning,
          it.server_answer,
          it.score_eligible,
        ],
      );
    }
    const dto = await this.loadAttempt(attemptId, userId);
    return this.toCurrentDto(dto, weekKey);
  }

  /**
   * Submit one answer.  Server-graded, idempotent (client_event_id), atomic.
   * Returns the graded verdict + this answer's points.
   */
  async submitAnswer(
    userId: string,
    attemptId: string,
    position: number,
    clientEventId: string,
    clientAnswer: string,
  ) {
    const item = await this.pool.query<AttemptItemRow>(
      `SELECT i.id AS item_id, i.position, i.direction, i.question_type, i.lexical_entry_id,
              i.english_spelling, i.meaning, i.server_answer, i.score_eligible
       FROM challenge_attempt_items i
       JOIN challenge_attempts a ON a.id = i.attempt_id
       WHERE i.attempt_id=$1 AND i.position=$2 AND a.user_id=$3`,
      [attemptId, position, userId],
    );
    const row = item.rows[0];
    if (!row) {
      throw new NotFoundException("该挑战题不在当前测验中，或测验不存在");
    }
    const facts: ChallengeItemFacts = {
      position: row.position,
      direction: row.direction,
      questionType: row.question_type,
      lexicalEntryId: row.lexical_entry_id,
      englishSpelling: row.english_spelling,
      meaning: row.meaning,
      serverAnswer: row.server_answer,
      scoreEligible: row.score_eligible,
    };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Attempt ownership + liveness within the transaction.
      const attempt = await client.query<AttemptRow>(
        `SELECT * FROM challenge_attempts WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [attemptId, userId],
      );
      const a = attempt.rows[0];
      if (!a) {
        await client.query("ROLLBACK");
        throw new NotFoundException("测验不存在或不属于当前用户");
      }
      if (a.status === "completed" || a.status === "cutoff") {
        await client.query("ROLLBACK");
        throw new ConflictException("测验已结束，不能继续作答");
      }
      if (new Date(a.expires_at).getTime() < Date.now()) {
        await client.query(`UPDATE challenge_attempts SET status='cutoff' WHERE id=$1`, [
          attemptId,
        ]);
        await client.query("COMMIT");
        throw new ConflictException("测验已超时（5 分钟），不能再作答");
      }

      // Re-confirm score eligibility server-side from learning_exposures (overrides
      // the frozen item flag).  Done before idempotency so it is authoritative.
      const eligible = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM learning_exposures
         WHERE user_id=$1 AND lexical_entry_id=$2`,
        [userId, row.lexical_entry_id],
      );
      facts.scoreEligible = Number(eligible.rows[0]?.n ?? 0) > 0;

      // Idempotency: has this (position) already been answered?
      const answered = await client.query<{
        id: string;
        is_correct: boolean;
        points_awarded: number;
      }>(
        `SELECT id, is_correct, points_awarded FROM challenge_answers
         WHERE attempt_id=$1 AND position=$2`,
        [attemptId, position],
      );
      const existing = answered.rows[0];

      // Word-direction dedup check (ADR-0007): has this user already scored this
      // word/direction in the current week?
      const alreadyScored = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM challenge_point_entries
         WHERE user_id=$1 AND challenge_week=$2 AND lexical_entry_id=$3 AND direction=$4
           AND reason='first_correct_answer'`,
        [userId, a.challenge_week, row.lexical_entry_id, row.direction],
      );
      const already = Number(alreadyScored.rows[0]?.n ?? 0) > 0;

      const verdict = judgeChallengeAnswer({ item: facts, clientAnswer, alreadyScored: already });

      if (existing) {
        // Idempotent replay: return the frozen first result.
        await client.query("COMMIT");
        return {
          attemptId,
          position: row.position,
          isCorrect: existing.is_correct,
          pointsAwarded: existing.points_awarded,
          correctAnswer: row.server_answer,
          kind: existing.points_awarded > 0 ? "scored" : existing.is_correct ? "review" : "wrong",
        };
      }

      await client.query(
        `INSERT INTO challenge_answers
           (attempt_id, position, client_event_id, client_answer, is_correct, points_awarded)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          attemptId,
          row.position,
          clientEventId,
          clientAnswer,
          verdict.isCorrect,
          verdict.pointsAwarded,
        ],
      );

      // Append a Challenge Point entry ONLY for a scored first-correct answer.
      if (verdict.kind === "scored" && verdict.pointsAwarded > 0) {
        await client.query(
          `INSERT INTO challenge_point_entries
             (user_id, challenge_week, source_attempt_id, rule_version, amount, reason,
              lexical_entry_id, direction, awarded_at)
           VALUES ($1,$2,$3,$4,$5,'first_correct_answer',$6,$7, now())`,
          [
            userId,
            a.challenge_week,
            attemptId,
            RULE_VERSION,
            verdict.pointsAwarded,
            row.lexical_entry_id,
            row.direction,
          ],
        );
        await client.query(
          `UPDATE challenge_attempts SET points_earned = points_earned + $2 WHERE id=$1`,
          [attemptId, verdict.pointsAwarded],
        );
      }

      // Mark the attempt completed when all items answered.
      const done = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM challenge_answers WHERE attempt_id=$1`,
        [attemptId],
      );
      if (Number(done.rows[0]?.n ?? 0) >= a.total_items) {
        await client.query(
          `UPDATE challenge_attempts SET status='completed', completed_at=now() WHERE id=$1`,
          [attemptId],
        );
      }

      await client.query("COMMIT");
      return {
        attemptId,
        position: row.position,
        isCorrect: verdict.isCorrect,
        pointsAwarded: verdict.pointsAwarded,
        correctAnswer: row.server_answer,
        kind: verdict.kind,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ---- private helpers ----

  private async loadAttempt(attemptId: string, userId: string) {
    const a = await this.pool.query<AttemptRow>(
      `SELECT * FROM challenge_attempts WHERE id=$1 AND user_id=$2`,
      [attemptId, userId],
    );
    if (!a.rows[0]) throw new NotFoundException("测验不存在或不属于当前用户");
    const items = await this.pool.query<AttemptItemRow>(
      `SELECT id AS item_id, position, direction, question_type, lexical_entry_id,
              english_spelling, meaning, server_answer, score_eligible
       FROM challenge_attempt_items WHERE attempt_id=$1 ORDER BY position`,
      [attemptId],
    );
    return { attempt: a.rows[0], items: items.rows };
  }

  private toCurrentDto(loaded: { attempt: AttemptRow; items: AttemptItemRow[] }, weekKey: string) {
    const window = getWeeklyChallengeWindow(Date.now());
    return {
      challengeWeek: weekKey,
      weekStart: window.startIso,
      weekEnd: window.endIso,
      timezone: window.timezone,
      attemptId: loaded.attempt.id,
      status: loaded.attempt.status,
      expiresAt: loaded.attempt.expires_at.toISOString(),
      items: loaded.items.map((i) => ({
        position: i.position,
        direction: i.direction,
        questionType: i.question_type,
        englishSpelling: i.english_spelling,
        meaning: i.meaning,
      })),
      maxPoints: loaded.attempt.max_points,
    };
  }

  /**
   * Assemble 10 questions from released course items the user has been exposed
   * to (learning_exposures).  ADR-0007: five English→Chinese four-choice questions
   * (prompt = english_spelling, answer = meaning) and five Chinese→English exact
   * spelling questions (prompt = meaning, answer = english_spelling).  Words the
   * user has seen the learning face of are score-eligible; we pick from the user's
   * actual exposed lexical entries, ordered by exposure recency, and alternate the
   * two question types per position so the attempt has exactly 5 choice + 5 spelling.
   */
  private async assembleItems(userId: string): Promise<AttemptItemRow[]> {
    const r = await this.pool.query<{
      lexical_entry_id: string;
      english_spelling: string;
      meaning: string;
    }>(
      `SELECT rci.lexical_entry_id, rci.english_spelling, rci.meaning,
              MAX(lexp.first_exposed_at) AS first_exposed_at
       FROM released_course_items rci
       JOIN learning_exposures lexp
         ON lexp.lexical_entry_id = rci.lexical_entry_id AND lexp.user_id=$1
       GROUP BY rci.lexical_entry_id, rci.english_spelling, rci.meaning
       ORDER BY MAX(lexp.first_exposed_at) DESC NULLS LAST
       LIMIT ${ATTEMPT_TOTAL_ITEMS}`,
      [userId],
    );

    // Interleave: positions 1,3,5,7,9 => choice (en→zh); 2,4,6,8,10 => spelling
    // (zh→en).  Each position uses one of the exposed words.
    const items: AttemptItemRow[] = [];
    for (let idx = 0; idx < r.rows.length; idx++) {
      const word = r.rows[idx]!;
      const isChoice = idx % 2 === 0;
      items.push({
        item_id: "",
        position: idx + 1,
        direction: isChoice ? "en_to_zh" : "zh_to_en",
        question_type: isChoice ? "choice" : "spelling",
        lexical_entry_id: word.lexical_entry_id,
        english_spelling: word.english_spelling,
        meaning: word.meaning,
        // choice: frozen answer is the meaning; spelling: frozen answer is the English spelling.
        server_answer: isChoice ? word.meaning : word.english_spelling,
        score_eligible: true,
      });
    }
    return items;
  }
}
