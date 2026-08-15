// 阶段 5 工单 06 学习核心闭环验收（真实 PostgreSQL + Nest API + domain）。
// 与既有分片测试不同，本文件用【同一学习者】按真实时序走完整个闭环并跨层核对事实：
//   - 隔离空库 0001–0015 顺序迁移 + 无阶段外业务表；
//   - 主课程 → 今日计划 → 创建会话 → 学习面展示（LearningExposure，不产生 ReviewEvent/FSRS/XP）；
//   - 双向首测（两方向各自独立首测事实；单方向不完成词项首测）→ 单元解锁只在双向完成后；
//   - FSRS v6 服务端权威：Again/Hard/Good/Easy 都走适配器，dueAt 可由事件/调度参数重建；
//   - ReviewEvent 幂等重放返回同一事件、不重复推进；同键不同载荷 409；
//   - 刷新恢复同一 active 会话与 cursor；断网重试保留同一 clientEventId + rating；
//   - 部分完成 / 单方向 / 非首测不得错误解锁（负例）。
//
// 数据库不可用时明确失败（throw），不静默跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, listAppliedMigrations, loadDbConfigFromEnv, migrate } from "@motro/db";
import { defaultFsrsParameters, scheduleNextLearningCard } from "@motro/domain";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";

type App = Awaited<ReturnType<typeof createApp>>;

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const OPENAPI_FILE = resolve(process.cwd(), "docs/generated/openapi.json");

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

interface Res {
  statusCode: number;
  json(): unknown;
  headers: Record<string, unknown>;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface Client {
  warm(): Promise<void>;
  req(
    method: HttpMethod,
    url: string,
    opts?: { payload?: object; headers?: Record<string, string> },
  ): Promise<Res>;
}

function makeClient(app: App): Client {
  const cookies: Record<string, string> = {};
  let csrf = "";
  const capture = (res: { headers: Record<string, unknown> }): void => {
    const raw = res.headers["set-cookie"];
    const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    for (const line of lines) {
      const pair = line.split(";")[0];
      if (!pair) continue;
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1);
        if (name === "motro_session" && value === "") delete cookies[name];
        else cookies[name] = value;
      }
    }
    if (cookies["motro_csrf"]) csrf = cookies["motro_csrf"];
  };
  return {
    async warm() {
      const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
      capture(res);
    },
    async req(method, url, opts = {}) {
      if (method !== "GET" && csrf === "") await this.warm();
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const jar = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      if (jar) headers.cookie = jar;
      if (method !== "GET") headers["x-csrf-token"] = csrf;
      const res = await app.inject({
        method,
        url,
        headers,
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      });
      capture(res);
      return res as unknown as Res;
    },
  };
}

interface PublishedCourse {
  courseId: string;
  unitIds: string[];
  itemIds: string[];
  releaseId: string;
}
interface SessionBody {
  sessionId: string;
  releaseId: string;
  status: string;
  itemCount: number;
  cursor: number;
}
interface SessionItem {
  itemId: string;
  position: number;
  cardId: string;
  courseItemId: string;
  itemKind: string;
  state: string;
  direction: string;
  englishSpelling: string;
  meaning: string;
}

describe("phase 6 learning core closeout", () => {
  let app: App;
  let admin: Client;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "phase6-closeout 需要运行中的 PostgreSQL（compose 的 db 服务）。启动后重跑；本套件不会静默跳过。",
      );
    }
    await migrate(config, MIGRATIONS_DIR);
    const suffix = randomBytes(3).toString("hex");
    const ps = new PasswordService();
    const pool = createPool({ ...config, max: 1 });
    const adminU = `p6-admin-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'P6 Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminU, await ps.hashPassword("p6-admin-pass-123")],
    );
    await pool.end();
    app = await createApp();
    await app.init();
    admin = makeClient(app);
    const r = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: adminU, password: "p6-admin-pass-123" },
    });
    expect(r.statusCode).toBe(200);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const ps = new PasswordService();
  let userSeq = 0;
  async function freshLearner(budgetMinutes = 30): Promise<{ client: Client; userId: string }> {
    const uname = `p6-fresh-${randomBytes(4).toString("hex")}-${userSeq++}`;
    const pool = createPool({ ...config, max: 1 });
    const rows = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'P6 Fresh', 'learner', 'active', 'Asia/Shanghai', $2, $3, false)
       RETURNING id`,
      [uname, budgetMinutes, await ps.hashPassword("p6-fresh-pass-123")],
    );
    await pool.end();
    const userId = rows.rows[0]!.id;
    const client = makeClient(app);
    const log = await client.req("POST", "/api/v1/auth/login", {
      payload: { username: uname, password: "p6-fresh-pass-123" },
    });
    expect(log.statusCode).toBe(200);
    return { client, userId };
  }

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }
  function uniq(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}`;
  }

  /** 创建两单元课程（默认每单元 1 词项，可配），返回稳定 ID 与 releaseId。 */
  async function createPublishedCourse(opts: {
    title: string;
    units?: number;
    itemsPerUnit?: number;
  }): Promise<PublishedCourse> {
    const units = opts.units ?? 2;
    const itemsPerUnit = opts.itemsPerUnit ?? 1;
    const slug = uniq("p6course");
    const created = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: opts.title, level: "a1", description: "课程" },
    });
    expect(created.statusCode).toBe(201);
    const courseId = (body(created) as { courseId?: string }).courseId as string;
    let version = (body(created) as { draftVersion?: number }).draftVersion ?? 1;
    const unitIds: string[] = [];
    const itemIds: string[] = [];
    for (let u = 0; u < units; u++) {
      const unitId = randomUUID();
      const uu = await admin.req(
        "POST",
        `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`,
        { payload: { title: `U${u + 1}`, description: "", draftVersion: version } },
      );
      expect(uu.statusCode).toBe(201);
      version = (body(uu) as { version?: number }).version ?? version;
      for (let i = 0; i < itemsPerUnit; i++) {
        const itemId = randomUUID();
        const entry = await admin.req("POST", "/api/v1/admin/lexical-entries", {
          payload: { canonicalSpelling: uniq("p6word"), confirmDuplicate: false },
        });
        expect(entry.statusCode).toBe(201);
        const lexEntryId = (body(entry) as { id?: string }).id as string;
        const it = await admin.req(
          "POST",
          `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
          {
            payload: { unitId, lexicalEntryId: lexEntryId, meaning: "释义", draftVersion: version },
          },
        );
        expect(it.statusCode).toBe(201);
        version = (body(it) as { version?: number }).version ?? version;
        itemIds.push(itemId);
      }
      unitIds.push(unitId);
    }
    const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("p6pub") },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect(pub.statusCode).toBe(201);
    return {
      courseId,
      unitIds,
      itemIds,
      releaseId: (body(pub) as { releaseId?: string }).releaseId as string,
    };
  }

  async function enrollPrimary(client: Client, courseId: string): Promise<void> {
    const r = await client.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
      payload: { makePrimary: true },
    });
    expect(r.statusCode).toBe(200);
  }

  async function ensureSession(
    client: Client,
  ): Promise<{ session: SessionBody; items: SessionItem[] }> {
    const c = await client.req("POST", "/api/v1/study/sessions", {});
    expect(c.statusCode).toBe(200);
    const sessBody = c.json() as SessionBody;
    const d = await client.req("GET", "/api/v1/study/sessions/active", {});
    expect(d.statusCode).toBe(200);
    const dt = d.json() as { session: SessionBody; items: SessionItem[] };
    return { session: sessBody, items: dt.items };
  }

  async function revealThenReview(
    client: Client,
    sessionId: string,
    item: SessionItem,
    rating: string,
    clientEventId: string,
  ): Promise<Res> {
    const rv = await client.req(
      "POST",
      `/api/v1/study/sessions/${sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    expect(rv.statusCode).toBe(200);
    return await client.req("POST", `/api/v1/study/sessions/${sessionId}/reviews`, {
      payload: { sessionItemId: item.itemId, cardId: item.cardId, rating, clientEventId },
    });
  }

  async function countReviewEvents(userId: string): Promise<number> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM review_events WHERE user_id = $1",
        [userId],
      );
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await pool.end();
    }
  }

  async function countExposures(userId: string): Promise<number> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM learning_exposures WHERE user_id = $1",
        [userId],
      );
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await pool.end();
    }
  }

  it("隔离空库 0001–0015 顺序迁移：全部表 + 唯一主课程索引 + 复习事件不可变触发器", async () => {
    const dbName = `motro_p6_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }
    const isoConfig = { ...config, database: dbName };
    try {
      const applied = await migrate(isoConfig, MIGRATIONS_DIR);
      expect(applied.map((m) => m.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32, 33,
      ]);
      const recorded = await listAppliedMigrations(isoConfig);
      expect(recorded.map((m) => m.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32, 33,
      ]);

      const verify = createPool({ ...isoConfig, max: 1 });
      try {
        const tables = await verify.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = 'public'
             AND tablename IN ('users','auth_sessions','audit_events','lexical_entries','lexical_sources',
               'courses','course_drafts','draft_units','draft_course_items','course_releases',
               'released_units','released_course_items','course_enrollments','idempotency_keys',
               'learning_cards','learning_exposures','study_sessions','study_session_items','review_events')`,
        );
        expect(tables.rows.map((r) => r.tablename).sort()).toEqual(
          [
            "audit_events",
            "auth_sessions",
            "course_drafts",
            "course_enrollments",
            "course_releases",
            "courses",
            "draft_course_items",
            "draft_units",
            "idempotency_keys",
            "learning_cards",
            "learning_exposures",
            "lexical_entries",
            "lexical_sources",
            "released_course_items",
            "released_units",
            "review_events",
            "study_session_items",
            "study_sessions",
            "users",
          ].sort(),
        );

        // 唯一主课程 partial index。
        const idx = await verify.query(
          `SELECT 1 FROM pg_indexes
           WHERE tablename = 'course_enrollments'
             AND indexname = 'course_enrollments_one_active_primary_per_user'`,
        );
        expect(idx.rowCount).toBe(1);

        // review_events 不可变触发器存在（BEFORE UPDATE / BEFORE DELETE）。
        const trig = await verify.query<{ trigger_name: string; event_manipulation: string }>(
          `SELECT trigger_name, event_manipulation
           FROM information_schema.triggers
           WHERE event_object_table = 'review_events'
           ORDER BY event_manipulation`,
        );
        const manip = trig.rows.map((r) => r.event_manipulation).sort();
        expect(manip).toEqual(["DELETE", "UPDATE"]);
        // 触发器名明确表达“拒绝行变更”语义。
        expect(trig.rows.every((r) => r.trigger_name.startsWith("review_events_no_"))).toBe(true);

        // 触发函数体必须 RAISE immutable 错误。
        const fn = await verify.query<{ prosrc: string }>(
          `SELECT pg_get_functiondef(p.oid) AS prosrc
           FROM pg_proc p
           WHERE p.proname = 'motro_reject_review_event_row_change'`,
        );
        expect(fn.rows[0]?.prosrc).toContain("immutable");
      } finally {
        await verify.end();
      }
    } finally {
      const dropPool = createPool({ ...config, database: "postgres", max: 1 });
      try {
        await dropPool.query(`DROP DATABASE "${dbName}"`);
      } finally {
        await dropPool.end();
      }
    }
  });

  it("阶段外业务表不存在：无 XP/挑战/导入/词汇来源之外的数据表与接口", async () => {
    const pool = createPool({ ...config, max: 1 });
    try {
      // 说明：enrichment_drafts 已于 Ticket 06 创建（单一草稿表，符合设计），故不再列入
      // "不应存在"清单；wikipedia_drafts / deepseek_drafts 是未采用的分表方案，仍应不存在。
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename IN (
             'xp_entries','xp_ledger','user_levels','user_level_progress','badges','user_badges',
             'streaks','streak_days','streak_protection','weekly_challenge_boards','challenge_weeks',
             'challenge_quizzes','quiz_questions','quiz_responses','challenge_points','game_rule_sets',
             'wikipedia_drafts','deepseek_drafts',
             'raw_wordlists','daily_plans','card_reviews','memory_states','fsrs_states'
           )`,
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await pool.end();
    }

    // OpenAPI 不含阶段外接口。
    const doc = JSON.parse(readFileSync(OPENAPI_FILE, "utf8")) as {
      paths: Record<string, unknown>;
    };
    const paths = Object.keys(doc.paths);
    const forbidden = [
      "/api/v1/xp",
      "/api/v1/challenges",
      "/api/v1/challenge",
      "/api/v1/import",
      "/api/v1/leaderboard",
      "/api/v1/quiz",
      "/api/v1/weekly",
    ];
    for (const f of forbidden) {
      expect(
        paths.some((p) => p.startsWith(f)),
        `不应存在阶段外路径 ${f}`,
      ).toBe(false);
    }
  });

  it("主课程边界：会话/计划项/展示内容只来自主课程 current release；不读草稿；v2 切换后旧会话仍读冻结内容", async () => {
    const { client } = await freshLearner();
    const { courseId, itemIds, releaseId } = await createPublishedCourse({
      title: "冻结边界课",
      units: 1,
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    // today 显示新卡计数 = 2（双向）。
    const today = await client.req("GET", "/api/v1/study/today", {});
    expect(today.statusCode).toBe(200);
    const todayBody = today.json() as { counts: { newCount: number } };
    expect(todayBody.counts.newCount).toBe(2);

    const { session, items } = await ensureSession(client);
    expect(session.releaseId).toBe(releaseId);
    // 计划项展示内容来自会话冻结 release（非草稿）。双向各一，共 2 项。
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.direction).sort()).toEqual(["en_to_zh", "zh_to_en"]);
    for (const it of items) {
      expect(it.englishSpelling.length).toBeGreaterThan(0);
      expect(it.meaning).toBe("释义");
    }
    const frozenItemIds = items.map((i) => i.itemId);

    // 发布 v2（改释义）并切 current；旧 active 会话仍返回 v1 释义。
    const draft1 = (
      body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
        version: number;
      }
    ).version;
    const patch = await admin.req(
      "PATCH",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemIds[0]}`,
      { payload: { meaning: "修订释义", draftVersion: draft1 } },
    );
    expect(patch.statusCode).toBe(200);
    const draft2 = (
      body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
        version: number;
      }
    ).version;
    const repub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("p6v2") },
      payload: { draftVersion: draft2, releaseNote: "v2" },
    });
    expect(repub.statusCode).toBe(201);

    const still = await client.req("GET", "/api/v1/study/sessions/active", {});
    expect(still.statusCode).toBe(200);
    const stillBody = still.json() as { session: SessionBody; items: SessionItem[] };
    expect(stillBody.session.releaseId).toBe(releaseId); // 冻结 release 不变
    expect(stillBody.items.map((i) => i.itemId).sort()).toEqual(frozenItemIds.sort());
    for (const it of stillBody.items) {
      expect(it.meaning).toBe("释义"); // 不是 v2"修订释义"
    }
  });

  it("新词展示学习面：reveal 产生/复用 LearningExposure 但不产生 ReviewEvent/FSRS/游戏数据", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "学习面课",
      units: 1,
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    expect(item.state).toBe("pending");

    const r1 = await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as { state: string; alreadyShown: boolean; itemKind: string };
    expect(b1.state).toBe("shown");
    expect(b1.itemKind).toBe("new_learning");
    expect(await countExposures(userId)).toBe(1); // 产生 exposure
    expect(await countReviewEvents(userId)).toBe(0); // 不产生 ReviewEvent

    // 重复 reveal：幂等复用 exposure，不新增。
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    expect(await countExposures(userId)).toBe(1);

    // 卡仍 pending（未评分）→ FSRS 未推进。
    const pool = createPool({ ...config, max: 1 });
    try {
      const card = await pool.query<{ state: string; reps: number }>(
        "SELECT state, reps FROM learning_cards WHERE id = $1",
        [item.cardId],
      );
      expect(card.rows[0]!.state).toBe("new");
      expect(card.rows[0]!.reps).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("双向首测：单方向不完成词项，双方向后才完成并解锁；四档评分均走服务端 FSRS", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "首测闭环课",
      units: 2,
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    // 首单元 1 词 → 双向 2 项（计划按 position 有序，方向不决定顺序）。
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.direction).sort()).toEqual(["en_to_zh", "zh_to_en"]);
    const first = items[0]!;
    const second = items[1]!;

    // 第一方向 Again 首测 → 单方向，不完成词项，第 2 单元未解锁。
    const r1 = await revealThenReview(client, session.sessionId, first, "again", uniq("ev-again"));
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as {
      isInitialReview: boolean;
      sessionCompleted: boolean;
      unlock: {
        highestUnlockedUnit: number;
        units: { position: number; unlocked: boolean; initialCompletedItemCount: number }[];
      };
    };
    expect(b1.isInitialReview).toBe(true);
    expect(b1.sessionCompleted).toBe(false);
    expect(b1.unlock.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(0);
    expect(b1.unlock.units.find((u) => u.position === 2)!.unlocked).toBe(false);
    expect(b1.unlock.highestUnlockedUnit).toBe(1);

    // 第二方向 Hard 首测 → 词项完成、第 2 单元解锁。
    const r2 = await revealThenReview(client, session.sessionId, second, "hard", uniq("ev-hard"));
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json() as {
      isInitialReview: boolean;
      sessionCompleted: boolean;
      unlock: {
        highestUnlockedUnit: number;
        units: { position: number; unlocked: boolean; initialCompletedItemCount: number }[];
      };
    };
    expect(b2.isInitialReview).toBe(true);
    expect(b2.sessionCompleted).toBe(true);
    expect(b2.unlock.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(1);
    expect(b2.unlock.units.find((u) => u.position === 2)!.unlocked).toBe(true);
    expect(b2.unlock.highestUnlockedUnit).toBe(2);

    expect(await countReviewEvents(userId)).toBe(2); // 两个方向各一事件

    // GET /progress 与评分响应一致。
    const p = await client.req("GET", "/api/v1/study/progress", {});
    const prog = p.json() as {
      highestUnlockedUnit: number;
      units: { position: number; unlocked: boolean; initialCompletedItemCount: number }[];
    };
    expect(prog.highestUnlockedUnit).toBe(2);
    expect(prog.units.find((u) => u.position === 1)!.unlocked).toBe(true);
    expect(prog.units.find((u) => u.position === 2)!.unlocked).toBe(true);
    expect(prog.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(1);
  });

  it("四档评分 All ratings 都走 FSRS：dueAt 服务端权威且可由事件/调度参数重建", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "四档FSRS课",
      units: 2,
      itemsPerUnit: 2,
    });
    await enrollPrimary(client, courseId);
    // 预算 30 → 首单元 2 词 = 4 张卡。前 4 项分用 Again/Hard/Good/Easy 各评一卡。
    const { session, items } = await ensureSession(client);
    const ratings = ["again", "hard", "good", "easy"] as const;
    const rated: { item: SessionItem; rating: string; resp: Res }[] = [];
    for (let i = 0; i < 4 && i < items.length; i++) {
      const rating = ratings[i] ?? "good";
      const r = await revealThenReview(
        client,
        session.sessionId,
        items[i]!,
        rating,
        uniq(`ev-${rating}`),
      );
      expect(r.statusCode).toBe(200);
      rated.push({ item: items[i]!, rating, resp: r });
    }

    // 每种评分都产生一条事件，response 带 memorySummary。
    expect(await countReviewEvents(userId)).toBe(rated.length);

    // 重建：DB 的 state_after.dueAt 与响应 memorySummary.dueAt 一致；且可由事件 + 调度参数重建。
    const pool = createPool({ ...config, max: 1 });
    try {
      for (const { rating, resp } of rated) {
        const b = resp.json() as {
          memorySummary: { dueAt: string; state: string; stateVersion: number };
          reviewEventId: string;
        };
        const ev = await pool.query<{ state_after: Record<string, unknown>; reviewed_at: string }>(
          `SELECT state_after, reviewed_at FROM review_events WHERE id = $1`,
          [b.reviewEventId],
        );
        const row = ev.rows[0]!;
        // 响应即服务端权威事件快照（state_after 使用 camelCase 键，与服务 DTO 一致）。
        expect(row.state_after.dueAt).toBe(b.memorySummary.dueAt);
        expect(row.state_after.state).toBe(b.memorySummary.state);
        // dueAt 是服务端时间（reviewed_at）派生，绝不在过去（learning 状态可能是分钟级步骤）。
        const scheduledDays = Number(row.state_after.scheduledDays);
        const dueMs = new Date(row.state_after.dueAt as string).getTime();
        const reviewedMs = new Date(row.reviewed_at).getTime();
        expect(dueMs).toBeGreaterThan(reviewedMs);

        // 用事件 state_before + 同一服务器时钟（reviewed_at）重建，应产生相同调度结果。
        const before = await pool.query<{ state_before: Record<string, unknown> }>(
          "SELECT state_before FROM review_events WHERE id = $1",
          [b.reviewEventId],
        );
        const beforeState = before.rows[0]!.state_before;
        const rebuilt = scheduleNextLearningCard({
          card: {
            state: beforeState.state as "new" | "learning" | "review",
            stability: Number(beforeState.stability),
            difficulty: Number(beforeState.difficulty),
            scheduledDays: Number(beforeState.scheduledDays),
            elapsedDays: Number(beforeState.elapsedDays),
            reps: Number(beforeState.reps),
            lapses: Number(beforeState.lapses),
            learningSteps: Number(beforeState.learningSteps),
            lastReviewAt: (beforeState.lastReviewAt as string) ?? null,
            dueAt: beforeState.dueAt as string,
            schedulerVersion: beforeState.schedulerVersion as string,
            schedulerParametersVersion: beforeState.schedulerParametersVersion as string,
            stateVersion: Number(beforeState.stateVersion),
          },
          now: new Date(row.reviewed_at),
          rating: rating as "again" | "hard" | "good" | "easy",
          parameters: defaultFsrsParameters(),
        });
        // 重建的调度与事件记录一致：同 input + 同服务器时钟 → 同 scheduledDays / state。
        expect(rebuilt.scheduledDays).toBe(scheduledDays);
        expect(rebuilt.state).toBe(row.state_after.state);
        expect(rebuilt.reps).toBe(Number(row.state_after.reps));
        expect(rebuilt.stability).toBeCloseTo(Number(row.state_after.stability), 6);
      }
    } finally {
      await pool.end();
    }
  });

  it("幂等重放 + 同键不同载荷 409；刷新恢复同一会话与 cursor；断网重试不重复记账", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "恢复幂等课",
      units: 1,
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;

    // reveal 后同一评分意图。
    const ev = uniq("ev-resume");
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    const payload = {
      sessionItemId: item.itemId,
      cardId: item.cardId,
      rating: "good",
      clientEventId: ev,
    };
    const r1 = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload,
    });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as {
      idempotentReplay: boolean;
      reviewEventId: string;
      newCursor: number | null;
    };
    expect(b1.idempotentReplay).toBe(false);
    expect(await countReviewEvents(userId)).toBe(1);

    // 幂等重放：同键同载荷 → 同事件，不二次推进。
    const r2 = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload,
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json() as {
      idempotentReplay: boolean;
      reviewEventId: string;
      newCursor: number | null;
    };
    expect(b2.idempotentReplay).toBe(true);
    expect(b2.reviewEventId).toBe(b1.reviewEventId);
    expect(b2.newCursor).toBe(b1.newCursor);
    expect(await countReviewEvents(userId)).toBe(1);

    // 同键不同载荷 → 409。
    const conflict = await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/reviews`,
      {
        payload: { ...payload, rating: "easy" },
      },
    );
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );

    // 刷新恢复：重新读 active 会话 → 同一会话、cursor 不变（本单元下一项或完成）。
    const resume = await client.req("GET", "/api/v1/study/sessions/active", {});
    expect(resume.statusCode).toBe(200);
    const resumeBody = resume.json() as { session: SessionBody; items: SessionItem[] };
    expect(resumeBody.session.sessionId).toBe(session.sessionId);
    // 会话仍 active（本单元 1 词双向，评完第一方向后还有对向）。
    expect(resumeBody.session.status).toBe("active");
    expect(await countReviewEvents(userId)).toBe(1);
  });

  it("负例：仅单方向/部分词项不错误解锁下一单元", async () => {
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "负例解锁课",
      units: 2,
      itemsPerUnit: 2,
    });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    // 首单元 2 词 → 4 张卡，计划按 position 有序：
    //   position 1 = wordA.en、2 = wordA.zh、3 = wordB.en、4 = wordB.zh。
    const wordA = items[0]!.courseItemId;
    const wordB = items[2]!.courseItemId;
    expect(wordA).not.toBe(wordB);

    // 只评 wordA 的两个方向（position 1、2）→ wordA 完成，但 wordB 一个方向都未评 → 第 2 单元不解锁。
    await revealThenReview(client, session.sessionId, items[0]!, "good", uniq("ev-neg1"));
    await revealThenReview(client, session.sessionId, items[1]!, "good", uniq("ev-neg2"));
    let p = await client.req("GET", "/api/v1/study/progress", {});
    let prog = p.json() as {
      highestUnlockedUnit: number;
      units: { position: number; unlocked: boolean; initialCompletedItemCount: number }[];
    };
    expect(prog.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(1); // wordA 完成
    expect(prog.units.find((u) => u.position === 2)!.unlocked).toBe(false); // wordB 未开始 → 不解锁
    expect(prog.highestUnlockedUnit).toBe(1);

    // 再评 wordB 的一个方向（position 3）→ wordB 半完成，仍不解锁。
    await revealThenReview(client, session.sessionId, items[2]!, "good", uniq("ev-neg3"));
    p = await client.req("GET", "/api/v1/study/progress", {});
    prog = p.json() as {
      highestUnlockedUnit: number;
      units: { position: number; unlocked: boolean; initialCompletedItemCount: number }[];
    };
    expect(prog.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(1); // 只有 wordA 完成
    expect(prog.units.find((u) => u.position === 2)!.unlocked).toBe(false); // wordB 未完成 → 不解锁
    expect(prog.highestUnlockedUnit).toBe(1);
  });

  it("负例：对已首测卡再次评分（非首测）不推进解锁计数", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "非首测课",
      units: 2,
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    // 首单元 1 词 → 双向卡（position 有序）。
    expect(items).toHaveLength(2);
    const en = items[0]!;
    const zh = items[1]!;
    const b1 = (
      await revealThenReview(client, session.sessionId, en, "good", uniq("ev-ni1"))
    ).json() as {
      isInitialReview: boolean;
      unlock: { highestUnlockedUnit: number };
    };
    expect(b1.isInitialReview).toBe(true);
    const b2 = (
      await revealThenReview(client, session.sessionId, zh, "good", uniq("ev-ni2"))
    ).json() as {
      isInitialReview: boolean;
      unlock: { highestUnlockedUnit: number };
    };
    expect(b2.isInitialReview).toBe(true);
    expect(b2.unlock.highestUnlockedUnit).toBe(2); // 双向完成 → 解锁

    // 会话已完成。开新会话：FSRS 调度的 due 卡带回，再次评分非首测。
    const { session: session2, items: items2 } = await ensureSession(client);
    const doneEn = items2.find((i) => i.cardId === en.cardId) ?? items2[0]!;
    const r3 = await revealThenReview(client, session2.sessionId, doneEn, "again", uniq("ev-ni3"));
    expect(r3.statusCode).toBe(200);
    const b3 = r3.json() as { isInitialReview: boolean };
    expect(b3.isInitialReview).toBe(false); // 非首测

    // 解锁计数不被非首测推进（仍为完成 1 词、最高解锁 2，不回退也不 +1）。
    const p = await client.req("GET", "/api/v1/study/progress", {});
    const prog = p.json() as {
      highestUnlockedUnit: number;
      units: { position: number; initialCompletedItemCount: number }[];
    };
    expect(prog.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(1);
    expect(prog.highestUnlockedUnit).toBe(2);
    expect(await countReviewEvents(userId)).toBe(3); // 双向首测 + 非首测
  });
});
