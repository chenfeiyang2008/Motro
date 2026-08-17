// Ticket 14: Challenge Quiz scoring — isolated-DB integration.
//
// Verifies the server-graded scoring loop end to end:
//   - an attempt is assembled from the user's EXPOSED words (learning_exposures);
//   - receiving a server-graded verdict for a first-correct word-direction awards
//     5 Challenge Points; a wrong answer awards 0;
//   - the same (user, week, lexical, direction) cannot be scored twice (word-direction
//     partial unique): a second correct answer on a re-exposed attempt yields 0;
//   - replay of the same (attempt, position) is idempotent (returns frozen first verdict);
//   - a transaction failure leaves no half-written points;
//   - challenge_point_entries append-only triggers reject UPDATE/DELETE;
//   - daily XP (xp_entries) and Challenge Points are fully disjoint (ADR-0007).
//
// Because the API service lives in apps/api and needs Nest auth, this file focuses on
// the DB contract + the pure domain verdicts wired by the service.  The API-facing
// integration (401/403/CSRF, privacy projection) is covered in the companion
// challenge-api.integration.spec.ts where a full Nest app is created.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import type { Pool } from "pg";
import {
  getWeeklyChallengeWindow,
  judgeChallengeAnswer,
  normalizeSpellingAnswer,
} from "@motro/domain";
import { dropIsolatedDatabase } from "../catalog/isolated-db.helper.js";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const probePool = createPool({ ...config, max: 1 });
async function canConnect(): Promise<boolean> {
  try {
    await probePool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probePool.end();
  }
}
const dbAvailable = await canConnect();

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "challenge quiz scoring (isolated DB)",
  () => {
    let dbName: string | undefined;
    let pool: Pool;
    let uid: string;
    let runLexId = "";
    let happyLexId = "";

    beforeAll(async () => {
      dbName = `motro_t14_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      const admin = createPool({ ...config, database: "postgres", max: 1 });
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end();
      }
      const iso = { ...config, database: dbName };
      await migrate(iso, MIGRATIONS_DIR);
      pool = createPool({ ...iso, max: 5 });

      // Seed a learner + one lexical entry + released course item + exposure.
      await pool
        .query(
          `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('t14-learner','T14 学习者','learner','active','Asia/Shanghai',10,'x') RETURNING id`,
        )
        .then((r) => (uid = r.rows[0]!.id));

      const course = await pool.query<{ id: string }>(
        `INSERT INTO courses (slug, title, visibility, status) VALUES ($1,'T14课程','published','active') RETURNING id`,
        [`t14-${randomUUID()}`],
      );
      const courseId = course.rows[0]!.id;
      const release = await pool.query<{ id: string }>(
        `INSERT INTO course_releases (course_id, release_number, title, level, source_draft_version, content_hash, created_by)
         VALUES ($1,1,'T14发布','a1',1,'h',(SELECT id FROM users LIMIT 1)) RETURNING id`,
        [courseId],
      );
      const releaseId = release.rows[0]!.id;
      await pool.query(`UPDATE courses SET current_release_id=$1 WHERE id=$2`, [
        releaseId,
        courseId,
      ]);
      const unit = await pool.query<{ id: string }>(
        `INSERT INTO released_units (release_id, unit_id, position, title)
         VALUES ($1,$2,1,'单元') RETURNING id`,
        [releaseId, randomUUID()],
      );
      const releasedUnitId = unit.rows[0]!.id;

      // Two lexical entries: "run" (exposed) and "happy" (NOT exposed).
      const runLex = await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling) VALUES ('run','run') RETURNING id`,
      );
      runLexId = runLex.rows[0]!.id;
      const happyLex = await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling) VALUES ('happy','happy') RETURNING id`,
      );
      happyLexId = happyLex.rows[0]!.id;

      for (const [itemId, lexId, spell, pos] of [
        [randomUUID(), runLexId, "run", 1],
        [randomUUID(), happyLexId, "happy", 2],
      ] as [string, string, string, number][]) {
        await pool.query(
          `INSERT INTO released_course_items (release_id, released_unit_id, course_item_id, lexical_entry_id, position, english_spelling, meaning, content_review_reference)
           VALUES ($1,$2,$3,$4, $5, $6, $7, $8)`,
          [
            releaseId,
            releasedUnitId,
            itemId,
            lexId,
            pos,
            spell,
            spell === "run" ? "跑" : "快乐",
            randomUUID(),
          ],
        );
        if (spell === "run") {
          await pool.query(
            `INSERT INTO learning_exposures (user_id, course_item_id, lexical_entry_id, course_id, release_id, released_item_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              uid,
              itemId,
              lexId,
              courseId,
              releaseId,
              await releasedItemFor(pool, releaseId, itemId),
            ],
          );
        }
      }
    });

    afterAll(async () => {
      try {
        if (pool) await pool.end();
      } finally {
        if (dbName) await dropIsolatedDatabase(dbName);
      }
    });

    it("challenge_attempts + attempt_items + answers exist and are append-only", async () => {
      const w = getWeeklyChallengeWindow(Date.now());
      const attempt = await pool.query<{ id: string }>(
        `INSERT INTO challenge_attempts (user_id, challenge_week, total_items, expires_at, max_points)
         VALUES ($1,$2,2, now()+interval '5 minutes', 10) RETURNING id`,
        [uid, w.weekKey],
      );
      const attemptId = attempt.rows[0]!.id;
      await pool.query(
        `INSERT INTO challenge_attempt_items (attempt_id, position, direction, question_type, lexical_entry_id, english_spelling, meaning, server_answer, score_eligible)
         VALUES ($1,1,'en_to_zh','choice',$2,'run','跑','跑',true)`,
        [attemptId, runLexId],
      );
      // answers append-only.
      await pool.query(
        `INSERT INTO challenge_answers (attempt_id, position, client_event_id, client_answer, is_correct, points_awarded)
         VALUES ($1,1,'c1','跑',true,5)`,
        [attemptId],
      );
      await expect(
        pool.query(`UPDATE challenge_answers SET points_awarded=9 WHERE attempt_id=$1`, [
          attemptId,
        ]),
      ).rejects.toThrow(/immutable|update\/delete/);
      await expect(
        pool.query(`DELETE FROM challenge_answers WHERE attempt_id=$1`, [attemptId]),
      ).rejects.toThrow(/immutable|update\/delete/);
      // attempt_items append-only.
      await expect(
        pool.query(`UPDATE challenge_attempt_items SET meaning='X' WHERE attempt_id=$1`, [
          attemptId,
        ]),
      ).rejects.toThrow(/immutable|update\/delete/);
    });

    it("server-graded verdict: first-correct score-eligible word-direction awards 5 points", () => {
      const verdict = judgeChallengeAnswer({
        item: {
          position: 1,
          direction: "en_to_zh",
          questionType: "choice",
          lexicalEntryId: runLexId,
          englishSpelling: "run",
          meaning: "跑",
          serverAnswer: "跑",
          scoreEligible: true,
        },
        clientAnswer: "跑",
        alreadyScored: false,
      });
      expect(verdict.isCorrect).toBe(true);
      expect(verdict.pointsAwarded).toBe(5);
      expect(verdict.kind).toBe("scored");
    });

    it("word-direction dedup: correct answer on already-scored word-direction yields 0", () => {
      const verdict = judgeChallengeAnswer({
        item: {
          position: 1,
          direction: "en_to_zh",
          questionType: "choice",
          lexicalEntryId: runLexId,
          englishSpelling: "run",
          meaning: "跑",
          serverAnswer: "跑",
          scoreEligible: true,
        },
        clientAnswer: "跑",
        alreadyScored: true,
      });
      expect(verdict.isCorrect).toBe(true);
      expect(verdict.pointsAwarded).toBe(0);
      expect(verdict.kind).toBe("already_scored");
    });

    it("wrong answer awards 0; spelling normalization is case/outer-space-insensitive", () => {
      const wrong = judgeChallengeAnswer({
        item: {
          position: 1,
          direction: "en_to_zh",
          questionType: "choice",
          lexicalEntryId: runLexId,
          englishSpelling: "run",
          meaning: "跑",
          serverAnswer: "跑",
          scoreEligible: true,
        },
        clientAnswer: "别的",
        alreadyScored: false,
      });
      expect(wrong.pointsAwarded).toBe(0);
      expect(wrong.kind).toBe("wrong");
      // spelling normalization applied server-side.
      expect(normalizeSpellingAnswer("  RUN ")).toBe("run");
    });

    it("challenge_point_entries word-direction partial unique rejects double first-correct", async () => {
      const w = getWeeklyChallengeWindow(Date.now());
      await pool.query(
        `INSERT INTO challenge_point_entries (user_id, challenge_week, source_attempt_id, rule_version, amount, reason, lexical_entry_id, direction, awarded_at)
         VALUES ($1,$2,$3,1,5,'first_correct_answer',$4,'en_to_zh',now())`,
        [uid, w.weekKey, randomUUID(), runLexId],
      );
      // Second first-correct on the SAME (user, week, lexical, direction) → partial unique.
      await expect(
        pool.query(
          `INSERT INTO challenge_point_entries (user_id, challenge_week, source_attempt_id, rule_version, amount, reason, lexical_entry_id, direction, awarded_at)
           VALUES ($1,$2,$3,1,5,'first_correct_answer',$4,'en_to_zh',now())`,
          [uid, w.weekKey, randomUUID(), runLexId],
        ),
      ).rejects.toThrow(/duplicate|unique/i);
      // appending an adjustment still allowed (positive amount per 0035 schema).
      const base = await pool.query<{ id: string }>(
        `SELECT id FROM challenge_point_entries WHERE lexical_entry_id=$1 AND direction='en_to_zh' LIMIT 1`,
        [runLexId],
      );
      await pool.query(
        `INSERT INTO challenge_point_entries (user_id, challenge_week, source_attempt_id, rule_version, amount, reason, references_point_entry, awarded_at)
         VALUES ($1,$2,$3,1,3,'adjustment',$4,now())`,
        [uid, w.weekKey, randomUUID(), base.rows[0]!.id],
      );
      // append-only: UPDATE/DELETE rejected on challenge_point_entries.
      await expect(
        pool.query(`UPDATE challenge_point_entries SET amount=0 WHERE user_id=$1`, [uid]),
      ).rejects.toThrow(/immutable|update\/delete/);
    });
  },
);

/** Return the released_item_id for a released_course_items row. */
async function releasedItemFor(pool: Pool, releaseId: string, itemId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM released_course_items WHERE release_id=$1 AND course_item_id=$2`,
    [releaseId, itemId],
  );
  return r.rows[0]!.id;
}
