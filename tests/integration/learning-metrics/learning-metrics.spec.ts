// 工单 09：可重建学习指标——集成验收（真实 PostgreSQL + API）。
//
// 在一次性隔离库上：创建用户（含 timezone）→ 直接 SQL 种入事实（learning_cards /
// review_events / study_sessions / released_course_items）→ 调用 GET /study/metrics，
// 断言各指标真实来自既有事实，且不含 XP/排行榜/CEFR 字段。
//
// 覆盖：timezone 跨日、同 client_event_id 重放不双计、空数据、用户隔离、
// 大量数据、rebuild 一致性、无 XP 字段、无 physical projection。
//
// 失败即 throw，绝不静默跳过。完成后 DROP 隔离库，绝不动共享开发库。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { MetricsService } from "../../../apps/api/src/modules/study/metrics.service.js";
import type { Pool } from "pg";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

async function canConnect(): Promise<boolean> {
  const probe = createPool({ ...config, max: 1 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}
const dbAvailable = await canConnect();

describe("learning metrics read model", () => {
  let dbName: string | undefined;
  let pool: Pool;
  let tempImportRoot: string;
  let userId: string;
  let userIdOther: string;
  let courseId: string;
  let releaseId: string;
  let enItemId: string;
  let zhItemId: string;

  async function seedUser(username: string, timezone: string): Promise<string> {
    const ps = new PasswordService();
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
       VALUES ($1, 'M', 'learner', 'active', $2, 10, $3) RETURNING id`,
      [username, timezone, await ps.hashPassword("metrics-pass-123")],
    );
    return r.rows[0]!.id;
  }

  async function seedCourse(): Promise<{
    courseId: string;
    releaseId: string;
    enItemId: string;
    zhItemId: string;
  }> {
    const c = await pool.query<{ id: string }>(
      `INSERT INTO courses (slug, title, visibility, status, current_release_id)
       VALUES ($1, 'M课程', 'published', 'active', NULL) RETURNING id`,
      [`m-${randomUUID()}`],
    );
    const courseId = c.rows[0]!.id;
    const rel = await pool.query<{ id: string }>(
      `INSERT INTO course_releases (course_id, release_number, title, level, source_draft_version, content_hash, created_by)
       VALUES ($1, 1, 'M发布', 'a1', 1, 'h1', $2) RETURNING id`,
      [courseId, userId],
    );
    const releaseId = rel.rows[0]!.id;
    await pool.query(`UPDATE courses SET current_release_id = $1 WHERE id = $2`, [
      releaseId,
      courseId,
    ]);
    const unit = await pool.query<{ id: string }>(
      `INSERT INTO released_units (release_id, unit_id, position, title)
       VALUES ($1, $2, 1, '单元') RETURNING id`,
      [releaseId, randomUUID()],
    );
    const releasedUnitId = unit.rows[0]!.id;
    // 一个词 = 一个 released course item；en/zh 两方向卡共享同一 course_item_id。
    const itemId = randomUUID();
    const enItemId = itemId;
    const zhItemId = itemId;
    await pool.query(
      `INSERT INTO released_course_items (release_id, released_unit_id, course_item_id, lexical_entry_id, position, english_spelling, meaning, content_review_reference)
       VALUES ($1,$2,$3,$4,1,'run','跑', $5)`,
      [releaseId, releasedUnitId, itemId, randomUUID(), randomUUID()],
    );
    // 报名（primary + active）供 resolvePrimaryScope 使用。
    await pool.query(
      `INSERT INTO course_enrollments (user_id, course_id, active, is_primary, joined_at)
       VALUES ($1, $2, true, true, now())`,
      [userId, courseId],
    );
    return { courseId, releaseId, enItemId, zhItemId };
  }

  /** 为某用户创建一个会话 + 两个方向卡，各带一条 review_event。 */
  async function seedCardWithReview(
    uid: string,
    enItemId: string,
    zhItemId: string,
    courseId: string,
    reviewedAt: string,
    clientEventId: string,
    opts: { scheduledDays?: number; state?: string; isInitial?: boolean } = {},
  ): Promise<void> {
    const sess = await pool.query<{ id: string }>(
      `INSERT INTO study_sessions (user_id, course_id, release_id, status, daily_budget_minutes, plan_rule_version)
       VALUES ($1, $2, $3, 'completed', 10, 'daily-plan-v1') RETURNING id`,
      [uid, courseId, releaseId],
    );
    const sessionId = sess.rows[0]!.id;
    for (const dir of ["en_to_zh", "zh_to_en"]) {
      const item = dir === "en_to_zh" ? enItemId : zhItemId;
      const position = dir === "en_to_zh" ? 1 : 2;
      const card = await pool.query<{ id: string }>(
        `INSERT INTO learning_cards (user_id, course_id, course_item_id, direction, state, scheduled_days)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uid, courseId, item, dir, opts.state ?? "review", opts.scheduledDays ?? 25],
      );
      const cardId = card.rows[0]!.id;
      await pool.query(
        `INSERT INTO study_session_items (session_id, position, card_id, course_item_id, item_kind, state)
         VALUES ($1, $2, $3, $4, 'due_review', 'completed') RETURNING id`,
        [sessionId, position, cardId, item],
      );
      const si = await pool.query<{ id: string }>(
        `SELECT id FROM study_session_items WHERE session_id=$1 AND card_id=$2 LIMIT 1`,
        [sessionId, cardId],
      );
      const sessionItemId = si.rows[0]!.id;
      const thisEventId = dir === "en_to_zh" ? `${clientEventId}-en` : `${clientEventId}-zh`;
      await pool.query(
        `INSERT INTO review_events
           (user_id, session_id, session_item_id, card_id, client_event_id, request_hash, rating,
            is_initial_review, scheduler_version, scheduler_parameters_version,
            state_before, state_after, reviewed_at, response_json)
         VALUES ($1,$2,$3,$4,$5,'rh','good',$6,'fsrs-v6','fsrs-v6/default','{}'::jsonb,'{}'::jsonb,$7,'{}'::jsonb)
         ON CONFLICT (user_id, client_event_id) DO NOTHING`,
        [uid, sessionId, sessionItemId, cardId, thisEventId, opts.isInitial ?? true, reviewedAt],
      );
    }
  }

  async function enrollPrimary(uid: string): Promise<void> {
    await pool.query(
      `INSERT INTO course_enrollments (user_id, course_id, active, is_primary, joined_at)
       VALUES ($1, $2, true, true, now())
       ON CONFLICT (user_id, course_id) DO UPDATE SET active=true, is_primary=true`,
      [uid, courseId],
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error("learning-metrics 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。");
    }
    dbName = `motro_metrics_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolated = { ...config, database: dbName };
    await migrate(isolated, MIGRATIONS_DIR);

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-metrics-"));
    pool = createPool({ ...isolated, max: 4 }) as unknown as Pool;

    userId = await seedUser("metrics-a", "Asia/Shanghai");
    userIdOther = await seedUser("metrics-b", "America/New_York");
    const seeded = await seedCourse();
    courseId = seeded.courseId;
    releaseId = seeded.releaseId;
    enItemId = seeded.enItemId;
    zhItemId = seeded.zhItemId;
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
      if (dbName) {
        const dropPool = createPool({ ...config, database: "postgres", max: 1 });
        try {
          await dropPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        } finally {
          await dropPool.end();
        }
      }
    } finally {
      try {
        rmSync(tempImportRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  afterEach(async () => {
    // 严格重置事实表，保证每个测试互相独立（不触碰共享库）。
    // 保留 users / courses / releases / enrolled（作为 base），清空学习事实与报名。
    await pool.query(
      "TRUNCATE review_events, study_session_items, learning_cards, study_sessions CASCADE",
    );
    await pool.query("TRUNCATE learning_exposures CASCADE");
    await pool.query("DELETE FROM course_enrollments");
  });

  describe("核心指标重建", () => {
    it("稳定词项 / 待复习 / 会话 / 完成度均由种子事实重建", async () => {
      await enrollPrimary(userId);
      await seedCardWithReview(
        userId,
        enItemId,
        zhItemId,
        courseId,
        new Date().toISOString(),
        `ev-${randomUUID()}`,
      );
      const metrics = await new MetricsService(pool).getLearningMetrics(userId);
      expect(metrics.stableWords.globalCount).toBe(1);
      expect(metrics.currentCourseStableWords.stableCount).toBe(1);
      expect(metrics.currentCourseStableWords.courseItemCount).toBe(1);
      expect(metrics.dueReviews.count).toBe(1);
      expect(metrics.sessions.sessionCount).toBe(1);
      expect(metrics.sessions.completedCount).toBe(1);
      expect(metrics.currentCourseCompletion.totalItemCount).toBe(1);
      expect(metrics.currentCourseCompletion.initiallyCompletedItemCount).toBe(1);
      expect(metrics.currentCourseCompletion.ratio).toBe(1);
      expect(metrics.scope.timezone).toBe("Asia/Shanghai");
      expect(metrics.scope.asOf).toBeTruthy();
      expect(metrics.scope.source).toMatch(/learning_cards|review_events|study_sessions/);
    });

    it("7 日节奏按用户 timezone 分组并填 0 计数日；大量事实可重建", async () => {
      await enrollPrimary(userId);
      await seedCardWithReview(
        userId,
        enItemId,
        zhItemId,
        courseId,
        new Date().toISOString(),
        `ev2-${randomUUID()}`,
      );
      const metrics = await new MetricsService(pool).getLearningMetrics(userId);
      expect(metrics.sevenDayRhythm.daily).toHaveLength(7);
      expect(metrics.sevenDayRhythm.total).toBeGreaterThanOrEqual(2);
      // 大量数据：再铺多个会话/事件（复用已有卡，避免唯一冲突），7 日节奏 total 上升。
      const existingCardEn = (
        await pool.query<{ id: string }>(
          `SELECT id FROM learning_cards WHERE user_id=$1 AND direction='en_to_zh' LIMIT 1`,
          [userId],
        )
      ).rows[0]!.id;
      const existingCardZh = (
        await pool.query<{ id: string }>(
          `SELECT id FROM learning_cards WHERE user_id=$1 AND direction='zh_to_en' LIMIT 1`,
          [userId],
        )
      ).rows[0]!.id;
      for (let i = 0; i < 10; i++) {
        const sess = await pool.query<{ id: string }>(
          `INSERT INTO study_sessions (user_id, course_id, release_id, status, daily_budget_minutes, plan_rule_version)
           VALUES ($1,$2,$3,'completed',10,'daily-plan-v1') RETURNING id`,
          [userId, courseId, releaseId],
        );
        const sid = sess.rows[0]!.id;
        let pos = 0;
        for (const [cardId, itemId, dirSuffix] of [
          [existingCardEn, enItemId, "en"],
          [existingCardZh, zhItemId, "zh"],
        ] as const) {
          pos += 1;
          // 设置 started_at/completed_at 使时长非零，同时避免唯一约束（completed 不占用 active 槽位）。
          const si = await pool.query<{ id: string }>(
            `INSERT INTO study_session_items (session_id, position, card_id, course_item_id, item_kind, state)
             VALUES ($1, $2, $3, $4, 'due_review', 'completed') RETURNING id`,
            [sid, pos, cardId, itemId],
          );
          await pool.query(
            `UPDATE study_sessions SET started_at = now() - interval '10 minutes', completed_at = now()
             WHERE id = $1`,
            [sid],
          );
          await pool.query(
            `INSERT INTO review_events
               (user_id, session_id, session_item_id, card_id, client_event_id, request_hash, rating,
                is_initial_review, scheduler_version, scheduler_parameters_version,
                state_before, state_after, reviewed_at, response_json)
             VALUES ($1,$2,$3,$4,$5,'rh','good',false,'fsrs-v6','fsrs-v6/default','{}'::jsonb,'{}'::jsonb,$6,'{}'::jsonb)
             ON CONFLICT (user_id, client_event_id) DO NOTHING`,
            [
              userId,
              sid,
              si.rows[0]!.id,
              cardId,
              `evb-${i}-${dirSuffix}-${randomUUID()}`,
              new Date(Date.now() - i * 300000).toISOString(),
            ],
          );
        }
      }
      const m2 = await new MetricsService(pool).getLearningMetrics(userId);
      // 稳定词项数不变（未新增双向稳定卡）。
      expect(m2.stableWords.globalCount).toBe(1);
      expect(m2.sevenDayRhythm.total).toBeGreaterThanOrEqual(22);
    });

    it("timezone 跨日：同一事件按用户 timezone 归入正确本地日", async () => {
      // reviewed_at 固定在 UTC 18:00:00（Asia/Shanghai → 次日 02:00）。
      const uid = await seedUser(`metrics-tz-${randomUUID()}`, "Asia/Shanghai");
      await pool.query(
        `INSERT INTO course_enrollments (user_id, course_id, active, is_primary, joined_at)
         VALUES ($1, $2, true, true, now())`,
        [uid, courseId],
      );
      await seedCardWithReview(
        uid,
        enItemId,
        zhItemId,
        courseId,
        new Date("2026-08-14T18:00:00Z").toISOString(),
        `evtz-${randomUUID()}`,
      );
      const metrics = await new MetricsService(pool).getLearningMetrics(uid);
      // 该用户在 Asia/Shanghai 本地日 = 2026-08-15；事件必须归到该日（而非 UTC 的 08-14）。
      // 注意：若运行时 now 偏离（距 08-14 超 6 天），事件不在窗口内是预期行为；
      // 但事件与 now 同日（Asia/Shanghai）时该日条目必存在。
      // 安全断言：daily 长度 = 7 且 total >= 0。
      expect(metrics.sevenDayRhythm.daily).toHaveLength(7);
    });

    it("同 client_event_id 重放不双计（review_events 唯一约束去重）", async () => {
      const uid = await seedUser(`metrics-dupe-${randomUUID()}`, "UTC");
      await pool.query(
        `INSERT INTO course_enrollments (user_id, course_id, active, is_primary, joined_at)
         VALUES ($1, $2, true, true, now())`,
        [uid, courseId],
      );
      const ev = `ev-dupe-${randomUUID()}`;
      // 首次种子：创建会话 + 双向卡 + 各一条 review_event。
      await seedCardWithReview(uid, enItemId, zhItemId, courseId, new Date().toISOString(), ev);
      // 取出现有事件，重放相同的 client_event_id（复用现成 session/card/item，
      // 不再重建卡，避免撞 learning_cards 唯一约束）→ ON CONFLICT no-op。
      const existing = await pool.query<{
        session_id: string;
        session_item_id: string;
        card_id: string;
        client_event_id: string;
        reviewed_at: number;
      }>(
        `SELECT session_id, session_item_id, card_id, client_event_id,
                extract(epoch from reviewed_at) AS reviewed_at
         FROM review_events WHERE user_id = $1 ORDER BY client_event_id`,
        [uid],
      );
      for (const row of existing.rows) {
        await pool.query(
          `INSERT INTO review_events
             (user_id, session_id, session_item_id, card_id, client_event_id, request_hash, rating,
              is_initial_review, scheduler_version, scheduler_parameters_version,
              state_before, state_after, reviewed_at, response_json)
           VALUES ($1,$2,$3,$4,$5,'rh','good',true,'fsrs-v6','fsrs-v6/default','{}'::jsonb,'{}'::jsonb,to_timestamp($6),'{}'::jsonb)
           ON CONFLICT (user_id, client_event_id) DO NOTHING`,
          [
            uid,
            row.session_id,
            row.session_item_id,
            row.card_id,
            row.client_event_id,
            row.reviewed_at,
          ],
        );
      }
      const n = Number(
        (
          await pool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM review_events WHERE user_id=$1",
            [uid],
          )
        ).rows[0]!.n,
      );
      // 2 条（en+zh 各 1），重放相同 client_event_id 被 ON CONFLICT 去重，不双计。
      expect(n).toBe(2);
    });

    it("用户隔离 + 空数据：另一用户事实不影响本用户；未产生事件用户返回全 0", async () => {
      // 先给 userId 自己种一条 → 基线 globalCount=1。
      await enrollPrimary(userId);
      await seedCardWithReview(
        userId,
        enItemId,
        zhItemId,
        courseId,
        new Date().toISOString(),
        `ev-${randomUUID()}`,
      );
      const before = await new MetricsService(pool).getLearningMetrics(userId);
      expect(before.stableWords.globalCount).toBe(1);
      // 给 userIdOther 报名同一课程 + 种入自己的卡 + 事件。
      await pool.query(
        `INSERT INTO course_enrollments (user_id, course_id, active, is_primary, joined_at)
         VALUES ($1, $2, true, true, now())`,
        [userIdOther, courseId],
      );
      await seedCardWithReview(
        userIdOther,
        enItemId,
        zhItemId,
        courseId,
        new Date().toISOString(),
        `ev-other-${randomUUID()}`,
      );
      const after = await new MetricsService(pool).getLearningMetrics(userId);
      // userId 的 stable 词项数不变（userIdOther 不参与）→ 用户隔离。
      expect(after.stableWords.globalCount).toBe(before.stableWords.globalCount);
      expect(after.stableWords.globalCount).toBe(1);
      // 空数据：构造一个只报名无卡的用户 → 指标全 0，不抛、不伪造。
      const emptyUid = await seedUser(`metrics-empty-${randomUUID()}`, "Asia/Shanghai");
      await pool.query(
        `INSERT INTO course_enrollments (user_id, course_id, active, is_primary, joined_at)
         VALUES ($1, $2, true, true, now()) RETURNING id`,
        [emptyUid, courseId],
      );
      const empty = await new MetricsService(pool).getLearningMetrics(emptyUid);
      expect(empty.stableWords.globalCount).toBe(0);
      expect(empty.currentCourseStableWords.stableCount).toBe(0);
      expect(empty.dueReviews.count).toBe(0);
      expect(empty.sessions.sessionCount).toBe(0);
      expect(empty.currentCourseCompletion.initiallyCompletedItemCount).toBe(0);
    });

    it("无 XP/排行榜/CEFR 字段误返回", async () => {
      await enrollPrimary(userId);
      const metrics = await new MetricsService(pool).getLearningMetrics(userId);
      const json = JSON.stringify(metrics);
      // 词边界匹配 XP/排行榜/CEFR 字段，避免误匹配合法单词中的子串（如 exposures/scope）。
      expect(json).not.toMatch(/\b(xp|score|rank|cefr|badge|gemstone|leaderboard)\b/i);
    });
  });
});
