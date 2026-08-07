// 0015 migration：review_events 数据库级关系一致性约束（阶段 5 工单 04 P2）。
// 真实 PostgreSQL 集成验收：
//   1) 正确关联（session + 属于它的 item + 该 item 绑定的卡）→ 可插入；
//   2) session 与 session_item 不匹配（item 不属于该 session）→ 被复合 FK 拒绝；
//   3) item 与 card 不匹配（card 非该 item 绑定卡）→ 被复合 FK 拒绝。
//
// 直接以原始 SQL 插入 FK 链条所需的最小一致行（user → course → release → learning_card → 两个 session → 各自 item），
// 不依赖 API，聚焦数据库层关系一致性。数据库不可用即抛错，不静默跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

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

interface FkChain {
  userId: string;
  sessionA: string;
  sessionB: string;
  itemA: string;
  itemB: string;
  cardA: string;
  cardB: string;
}

describe("review_events 关系一致性复合 FK（0015）", () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "review_events FK 测试需要运行中的 PostgreSQL（compose 的 db 服务）。启动后重跑；不会静默跳过。",
      );
    }
    await migrate(config, MIGRATIONS_DIR);
    pool = createPool({ ...config, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  /** 构造最小一致链，返回事件引用所需的三元组（sessionA/itemA/cardA 是自洽的一对）。 */
  async function buildFkChain(): Promise<FkChain> {
    const userId = randomUUID();
    const suffix = randomBytes(4).toString("hex");
    const courseId = randomUUID();
    const courseItemIdA = randomUUID();
    const courseItemIdB = randomUUID();
    const cardA = randomUUID();
    const cardB = randomUUID();
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const itemA = randomUUID();
    const itemB = randomUUID();

    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (id, username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
       VALUES ($1, $2, 'FkUser', 'learner', 'active', 'Asia/Shanghai', 10, $3)`,
      [userId, `fkr-${suffix}`, await ps.hashPassword("fk-pass-123")],
    );
    await pool.query("INSERT INTO courses (id, slug, title) VALUES ($1, $2, 'fk')", [
      courseId,
      `fk-${suffix}`,
    ]);
    const releaseId = randomUUID();
    await pool.query(
      `INSERT INTO course_releases
         (id, course_id, release_number, title, level, source_draft_version, content_hash, created_by)
       VALUES ($1, $2, 1, 'release', 'a1', 1, 'hash', $3)`,
      [releaseId, courseId, userId],
    );
    await pool.query(
      `INSERT INTO learning_cards (id, user_id, course_id, course_item_id, direction)
       VALUES ($1, $2, $3, $4, 'en_to_zh'), ($5, $2, $3, $6, 'zh_to_en')`,
      [cardA, userId, courseId, courseItemIdA, cardB, courseItemIdB],
    );
    await pool.query(
      `INSERT INTO study_sessions (id, user_id, course_id, release_id, status, daily_budget_minutes, plan_rule_version)
       VALUES ($1, $2, $3, $4, 'active', 5, 'daily-plan-v1')`,
      [sessionA, userId, courseId, releaseId],
    );
    await pool.query(
      `INSERT INTO study_sessions (id, user_id, course_id, release_id, status, daily_budget_minutes, plan_rule_version)
       VALUES ($1, $2, $3, $4, 'completed', 5, 'daily-plan-v1')`,
      [sessionB, userId, courseId, releaseId],
    );
    // itemA 属于 sessionA 且绑定 cardA；itemB 属于 sessionB 且绑定 cardB。
    await pool.query(
      `INSERT INTO study_session_items (id, session_id, position, card_id, course_item_id, item_kind)
       VALUES ($1, $2, 1, $3, $4, 'initial_review')`,
      [itemA, sessionA, cardA, courseItemIdA],
    );
    await pool.query(
      `INSERT INTO study_session_items (id, session_id, position, card_id, course_item_id, item_kind)
       VALUES ($1, $2, 1, $3, $4, 'initial_review')`,
      [itemB, sessionB, cardB, courseItemIdB],
    );

    return { userId, sessionA, sessionB, itemA, itemB, cardA, cardB };
  }

  /** 写入一条 review_events；成功返回 { ok:true }，被 FK 拒绝返回 { ok:false, message }。 */
  async function insertReview(
    chain: FkChain,
    over: { sessionId: string; sessionItemId: string; cardId: string },
  ): Promise<{ ok: boolean; message: string }> {
    const cols = [
      "user_id",
      "session_id",
      "session_item_id",
      "card_id",
      "client_event_id",
      "request_hash",
      "rating",
      "is_initial_review",
      "scheduler_version",
      "scheduler_parameters_version",
      "state_before",
      "state_after",
      "reviewed_at",
      "response_json",
    ];
    const values: unknown[] = [
      chain.userId,
      over.sessionId,
      over.sessionItemId,
      over.cardId,
      "review-" + randomBytes(6).toString("hex"),
      "reqhash",
      "good",
      false,
      "fsrs-v6",
      "fsrs-v6/default",
      JSON.stringify({ state: "new" }),
      JSON.stringify({ state: "review" }),
      new Date(),
      JSON.stringify({ rating: "good" }),
    ];
    try {
      await pool.query(
        `INSERT INTO review_events (${cols.join(", ")})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb)`,
        values,
      );
      return { ok: true, message: "" };
    } catch (e) {
      return { ok: false, message: String((e as Error).message) };
    }
  }

  it("正确关联（session + 属于它的 item + 该 item 绑定卡）可插入", async () => {
    const chain = await buildFkChain();
    const result = await insertReview(chain, {
      sessionId: chain.sessionA,
      sessionItemId: chain.itemA,
      cardId: chain.cardA,
    });
    expect(result.ok).toBe(true);
  });

  it("session 与 session_item 不匹配（item 属于另一会话）被 FK 拒绝", async () => {
    const chain = await buildFkChain();
    // sessionA + itemB（itemB 属于 sessionB）→ (session_id, session_item_id) 自相矛盾。
    const result = await insertReview(chain, {
      sessionId: chain.sessionA,
      sessionItemId: chain.itemB,
      cardId: chain.cardB,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("review_events_session_item_fk");
  });

  it("item 与 card 不匹配（card 非该 item 绑定卡）被 FK 拒绝", async () => {
    const chain = await buildFkChain();
    // itemA 绑 cardA；却用 cardB 写事件 → (session_item_id, card_id) 自相矛盾。
    const result = await insertReview(chain, {
      sessionId: chain.sessionA,
      sessionItemId: chain.itemA,
      cardId: chain.cardB,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("review_events_item_card_fk");
  });
});
