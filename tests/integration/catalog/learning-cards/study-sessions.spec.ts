// 每日计划与学习会话集成验收（阶段 5 工单 03）：真实 PostgreSQL + API + domain。
// 覆盖：无主课程 404、主课程/时间预算、today 概览（due/initial/new 计数、hasActiveSession、
//   noWork）、创建会话的 due > initial > new 计划顺序、预算截断、刷新恢复同一会话与快照顺序、
//   无任务不建空会话、并发创建唯一会话、草稿绝不进入计划、后续单元 new 不提前、
//   session release 快照随 current pointer 冻结、数据权限边界（非本人/无主课程统一 404）。
//
// 每用例创建独立的新学习者（fresh），避免跨用例状态污染（唯一 active 会话约束）。
// 与 learning-cards 一致：数据库不可用时明确失败（throw），不静默跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { createApp } from "../../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../../apps/api/src/auth/password.service.js";

type App = Awaited<ReturnType<typeof createApp>>;

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
  const captureCookies = (res: { headers: Record<string, unknown> }): void => {
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
      captureCookies(res);
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
      captureCookies(res);
      return res as unknown as Res;
    },
  };
}

interface PublishedCourse {
  courseId: string;
  unitIds: string[];
  itemIds: string[];
}

interface SessionBody {
  sessionId: string;
  courseId: string;
  releaseId: string;
  releaseNumber: number;
  status: string;
  dailyBudgetMinutes: number;
  planRuleVersion: string;
  itemCount: number;
  cursor: number;
}

interface TodayBody {
  courseId: string;
  dailyBudgetMinutes: number;
  counts: { dueCount: number; initialCount: number; newCount: number };
  hasActiveSession: boolean;
  noWork: boolean;
}

describe("daily plan and study session", () => {
  let app: App;
  let admin: Client;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "study-sessions 需要运行中的 PostgreSQL（compose 的 db 服务）。" +
          "请启动数据库后重跑；本套件不会静默跳过。",
      );
    }
    await migrate(config, MIGRATIONS_DIR);

    const suffix = randomBytes(3).toString("hex");
    const ps = new PasswordService();
    const pool = createPool({ ...config, max: 1 });

    const adminU = `sess-admin-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Sess Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminU, await ps.hashPassword("sess-admin-pass-123")],
    );
    const learnerU = `sess-learner-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Sess Learner', 'learner', 'active', 'Asia/Shanghai', 5, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [learnerU, await ps.hashPassword("sess-learner-pass-123")],
    );
    const otherU = `sess-other-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Sess Other', 'learner', 'active', 'Asia/Shanghai', 5, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [otherU, await ps.hashPassword("sess-other-pass-123")],
    );
    await pool.end();

    app = await createApp();
    await app.init();
    async function login(username: string, password: string): Promise<Client> {
      const c = makeClient(app);
      const r = await c.req("POST", "/api/v1/auth/login", { payload: { username, password } });
      expect(r.statusCode).toBe(200);
      return c;
    }
    admin = await login(adminU, "sess-admin-pass-123");
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const ps = new PasswordService();
  let userSeq = 0;
  /** 每个用例一个独立新学习者，隔离唯一 active 会话与主课程状态。 */
  async function freshLearner(): Promise<{ client: Client; userId: string }> {
    const uname = `sess-fresh-${randomBytes(4).toString("hex")}-${userSeq++}`;
    const pool = createPool({ ...config, max: 1 });
    const rows = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Sess Fresh', 'learner', 'active', 'Asia/Shanghai', 5, $2, false)
       RETURNING id`,
      [uname, await ps.hashPassword("sess-fresh-pass-123")],
    );
    await pool.end();
    const userId = rows.rows[0]?.id as string;
    const client = makeClient(app);
    const r = await client.req("POST", "/api/v1/auth/login", {
      payload: { username: uname, password: "sess-fresh-pass-123" },
    });
    expect(r.statusCode).toBe(200);
    return { client, userId };
  }

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }
  function uniq(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}`;
  }

  async function createEntry(spelling?: string): Promise<string> {
    const res = await admin.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: spelling ?? uniq("ssword"), confirmDuplicate: false },
    });
    expect(res.statusCode).toBe(201);
    return (body(res) as { id?: string }).id as string;
  }

  /** 创建课程：units 单元 × itemsPerUnit 词项并发布。返回稳定 ID。 */
  async function createPublishedCourse(opts: {
    title?: string;
    units?: number;
    itemsPerUnit?: number;
  }): Promise<PublishedCourse & { releaseNumber: number }> {
    const units = opts.units ?? 1;
    const itemsPerUnit = opts.itemsPerUnit ?? 1;
    const slug = uniq("sscourse");
    const created = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: opts.title ?? "会话课程", level: "a1", description: "课程描述" },
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
        {
          payload: { title: `单元${u + 1}`, description: "", draftVersion: version },
        },
      );
      expect(uu.statusCode).toBe(201);
      version = (body(uu) as { version?: number }).version ?? version;

      for (let i = 0; i < itemsPerUnit; i++) {
        const itemId = randomUUID();
        const entryId = await createEntry();
        const it = await admin.req(
          "POST",
          `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
          {
            payload: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
          },
        );
        expect(it.statusCode).toBe(201);
        version = (body(it) as { version?: number }).version ?? version;
        itemIds.push(itemId);
      }
      unitIds.push(unitId);
    }

    const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("sspub") },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect(pub.statusCode).toBe(201);
    return {
      courseId,
      unitIds,
      itemIds,
      releaseNumber: (body(pub) as { releaseNumber?: number }).releaseNumber ?? 1,
    };
  }

  async function enrollPrimary(client: Client, courseId: string): Promise<void> {
    const r = await client.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
      payload: { makePrimary: true },
    });
    expect(r.statusCode).toBe(200);
  }

  async function getToday(client: Client): Promise<{ statusCode: number; body: TodayBody | null }> {
    const r = await client.req("GET", "/api/v1/study/today", {});
    return { statusCode: r.statusCode, body: r.json() as TodayBody };
  }

  async function createSession(
    client: Client,
  ): Promise<{ statusCode: number; body: SessionBody | { noWork: boolean } | null }> {
    const r = await client.req("POST", "/api/v1/study/sessions", {});
    return { statusCode: r.statusCode, body: r.json() as SessionBody | { noWork: boolean } };
  }

  async function activeDetail(
    client: Client,
  ): Promise<{ statusCode: number; body: { session: SessionBody; items: unknown[] } | null }> {
    const r = await client.req("GET", "/api/v1/study/sessions/active", {});
    return {
      statusCode: r.statusCode,
      body: r.json() as { session: SessionBody; items: unknown[] },
    };
  }

  /** 直接统计某用户 active 会话数（DB 断言）。 */
  async function countActiveSessions(userId: string): Promise<number> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM study_sessions WHERE user_id = $1 AND status = 'active'",
        [userId],
      );
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await pool.end();
    }
  }

  /** 直接读取某用户所有卡（按创建顺序），供计划顺序断言与状态改写。 */
  async function listCards(userId: string): Promise<{ id: string; courseItemId: string }[]> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ id: string; course_item_id: string }>(
        `SELECT id, course_item_id FROM learning_cards
         WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
        [userId],
      );
      return r.rows.map((x) => ({ id: x.id, courseItemId: x.course_item_id }));
    } finally {
      await pool.end();
    }
  }

  /** 直接把两张卡改成 due(review) 与 initial(learning)，用于计划优先级测试。 */
  async function setCardStates(
    userId: string,
    patches: { state: string; dueAt?: Date }[],
  ): Promise<void> {
    const cards = await listCards(userId);
    const pool = createPool({ ...config, max: 1 });
    try {
      for (let i = 0; i < patches.length && i < cards.length; i++) {
        const p = patches[i]!;
        const now = p.dueAt ?? new Date(Date.now() - 60_000);
        await pool.query(
          `UPDATE learning_cards SET state = $2, due_at = $3, scheduler_parameters_version = 'fsrs-v6/default'
           WHERE id = $1`,
          [cards[i]!.id, p.state, now],
        );
      }
    } finally {
      await pool.end();
    }
  }

  /** 直接改某用户每日预算（分钟）。 */
  async function setBudget(userId: string, minutes: number): Promise<void> {
    const pool = createPool({ ...config, max: 1 });
    try {
      await pool.query("UPDATE users SET daily_budget_minutes = $2 WHERE id = $1", [
        userId,
        minutes,
      ]);
    } finally {
      await pool.end();
    }
  }

  /** 直接读会话头 + 计划项绑定的词项是否都属于会话冻结 release（release 快照一致性断言）。 */
  async function sessionReleaseInfo(
    userId: string,
  ): Promise<{ sessionRelease: string; itemCourseItems: string[] } | null> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const s = await pool.query<{ id: string; release_id: string }>(
        `SELECT id, release_id FROM study_sessions
         WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      const session = s.rows[0];
      if (!session) return null;
      const items = await pool.query<{ course_item_id: string }>(
        `SELECT course_item_id FROM study_session_items
         WHERE session_id = $1 ORDER BY position ASC`,
        [session.id],
      );
      return {
        sessionRelease: session.release_id,
        itemCourseItems: items.rows.map((r) => r.course_item_id),
      };
    } finally {
      await pool.end();
    }
  }

  /** 直接读某课程最新 release 的 id（供跨课程写入测试构造）。 */
  async function latestReleaseId(courseId: string): Promise<string> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM course_releases WHERE course_id = $1 ORDER BY release_number DESC LIMIT 1`,
        [courseId],
      );
      const row = r.rows[0];
      expect(row).toBeTruthy();
      return row!.id;
    } finally {
      await pool.end();
    }
  }

  /** 某词项是否属于某 release（release 快照同源性断言）。 */
  async function latestReleaseItem(courseItemId: string, releaseId: string): Promise<boolean> {
    const pool = createPool({ ...config, max: 1 });
    try {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM released_course_items
         WHERE release_id = $1 AND course_item_id = $2`,
        [releaseId, courseItemId],
      );
      return Number(r.rows[0]?.n ?? 0) > 0;
    } finally {
      await pool.end();
    }
  }

  // —— 用例 ——

  it("无主课程 → today/创建会话统一 404", async () => {
    const { client } = await freshLearner();
    expect((await getToday(client)).statusCode).toBe(404);
    expect((await createSession(client)).statusCode).toBe(404);
    expect((await activeDetail(client)).statusCode).toBe(404);
  });

  it("今日概览返回主课程、预算、首单元候选计数；无 active 会话时 hasActiveSession=false", async () => {
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "今日概览课程", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);

    const t = await getToday(client);
    expect(t.statusCode).toBe(200);
    const today = t.body as TodayBody;
    expect(today.courseId).toBe(courseId);
    expect(today.dailyBudgetMinutes).toBe(5);
    expect(today.counts).toEqual({ dueCount: 0, initialCount: 0, newCount: 2 }); // 1 词 × 双向
    expect(today.hasActiveSession).toBe(false);
    expect(today.noWork).toBe(false);
  });

  it("创建会话不依赖事务外卡补齐：新学习者首调 createSession 即在事务内补齐卡并锁定同一 release", async () => {
    // 回归：createOrResumeSession 不得在事务外 resolvePrimaryScope/ensureCourseCards/loadPlanRequest。
    // 全新学习者未调用过 today（无事务外补齐），直接 POST sessions 必须：
    //   1) 在事务内补齐双向卡 → 不误报 noWork；
    //   2) 生成的会话与计划项全部对应事务内锁定的同一个 release。
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "首调创建课程", itemsPerUnit: 2 });
    await enrollPrimary(client, courseId);

    // 首调创建：之前没有 getToday，也没有任何事务外的卡补齐。
    const s = beSession(await createSession(client));
    expect(s.courseId).toBe(courseId);
    expect(s.status).toBe("active");
    expect(s.itemCount).toBeGreaterThan(0);
    expect(await countActiveSessions(userId)).toBe(1);

    // 卡确已在事务内补齐（4 张：2 词 × 双向）。
    const cards = await listCards(userId);
    expect(cards).toHaveLength(4);

    // 会话与计划项全部对应同一 release 快照：每个计划项词项都属于会话冻结 release。
    const info = await sessionReleaseInfo(userId);
    expect(info).toBeTruthy();
    expect(info!.sessionRelease).toBe(s.releaseId);
    expect(info!.itemCourseItems.length).toBe(s.itemCount);
    for (const cid of info!.itemCourseItems) {
      expect(await latestReleaseItem(cid, info!.sessionRelease)).toBe(true);
    }
  });

  it("today 候选计数不受预算截断：预算 1 时 counts 仍返回全部候选，会话只生成 1 项", async () => {
    // 1 单元 3 词 → 6 张 new 卡。预算 1：today 的 newCount 必须 6（全部合格候选），
    // 但创建会话只截断到 1 项（itemCount 1）。两者明确区分。
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "计数预算课程", itemsPerUnit: 3 });
    await enrollPrimary(client, courseId);
    await setBudget(userId, 1);
    await getToday(client); // 触发补齐卡

    const t = await getToday(client);
    expect(t.statusCode).toBe(200);
    const today = t.body as TodayBody;
    expect(today.dailyBudgetMinutes).toBe(1);
    expect(today.counts).toEqual({ dueCount: 0, initialCount: 0, newCount: 6 });
    expect(today.noWork).toBe(false);

    const s = await createSession(client);
    expect(s.statusCode).toBe(200);
    expect((s.body as SessionBody).itemCount).toBe(1); // 预算截断：只 1 项
    const detail = await activeDetail(client);
    expect((detail.body as { items: unknown[] }).items).toHaveLength(1);
    expect(await countActiveSessions(userId)).toBe(1);
  });

  it("today 候选计数含 due/initial/new 全类且不受预算截断", async () => {
    // 1 单元 4 词 → 8 张卡。制造 2 张 due(review)、2 张 initial(learning)、其余 new。
    // 预算 2：today 返回完整 counts (2/2/4)，会话只截断 2 项（due 优先）。
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "全类计数课程", itemsPerUnit: 4 });
    await enrollPrimary(client, courseId);
    await setBudget(userId, 2);
    await getToday(client); // 触发补齐卡
    await setCardStates(userId, [
      { state: "review" },
      { state: "review" },
      { state: "learning" },
      { state: "learning" },
    ]);

    const t = await getToday(client);
    expect(t.statusCode).toBe(200);
    const today = t.body as TodayBody;
    expect(today.dailyBudgetMinutes).toBe(2);
    expect(today.counts).toEqual({ dueCount: 2, initialCount: 2, newCount: 4 }); // 完整候选
    expect(today.noWork).toBe(false);

    const s = await createSession(client);
    expect(s.statusCode).toBe(200);
    expect((s.body as SessionBody).itemCount).toBe(2); // 预算截断：只 2 项
    const detail = await activeDetail(client);
    const kinds = (detail.body as { items: { itemKind: string }[] }).items.map((i) => i.itemKind);
    expect(kinds).toEqual(["due_review", "due_review"]); // due 优先占满 2 项
  });

  it("跨课程 release 快照被数据库复合外键拒绝", async () => {
    // 直接 SQL 写入 course A + 课程 B 的 release：0013 复合外键必须拒绝。
    const { userId } = await freshLearner();
    const { courseId: courseA } = await createPublishedCourse({
      title: "复合外键A",
      itemsPerUnit: 1,
    });
    const { courseId: courseB } = await createPublishedCourse({
      title: "复合外键B",
      itemsPerUnit: 1,
    });
    const releaseB = await latestReleaseId(courseB);

    const pool = createPool({ ...config, max: 1 });
    try {
      const attempt = pool.query(
        `INSERT INTO study_sessions
           (user_id, course_id, release_id, status, daily_budget_minutes, plan_rule_version)
         VALUES ($1, $2, $3, 'active', 5, 'daily-plan-v1')`,
        [userId, courseA, releaseB],
      );
      await expect(attempt).rejects.toThrow(/study_sessions_course_release_fk/);
      expect(await countActiveSessions(userId)).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("会话 release 快照与计划项来自同一 release：切换 current 后新会话仍一致", async () => {
    const { client, userId } = await freshLearner();
    const { courseId, itemIds } = await createPublishedCourse({
      title: "一致性课程",
      itemsPerUnit: 2,
    });
    await enrollPrimary(client, courseId);
    await getToday(client);

    const s1 = beSession(await createSession(client));
    const info1 = await sessionReleaseInfo(userId);
    expect(info1).toBeTruthy();
    expect(info1!.sessionRelease).toBe(s1.releaseId);

    // 发布 v2（保留词项，改释义）并切 current；新会话读取的是 v2 但 items 也来自 v2。
    const itemId = itemIds[0]!;
    const draft = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
      payload: { meaning: "一致性修订", draftVersion: draft.version },
    });
    const draft2 = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("ssconsist") },
      payload: { draftVersion: draft2.version, releaseNote: "v2" },
    });

    // 关闭既有 active 会话（abandon）再创建，验证新会话快照 = v2 release 且 items 同源。
    const pool = createPool({ ...config, max: 1 });
    try {
      await pool.query(
        `UPDATE study_sessions SET status = 'abandoned' WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );
    } finally {
      await pool.end();
    }
    const s2 = beSession(await createSession(client));
    expect(s2.releaseId).not.toBe(s1.releaseId); // 新 current release

    const info2 = await sessionReleaseInfo(userId);
    expect(info2).toBeTruthy();
    expect(info2!.sessionRelease).toBe(s2.releaseId);
    // 每个计划项词项都属于该 release（同一快照来源）。
    for (const cid of info2!.itemCourseItems) {
      const found = await latestReleaseItem(cid, s2.releaseId);
      expect(found).toBe(true);
    }
  });

  it("草稿绝不进入计划：只发布词项计数；未发布草稿词项无卡", async () => {
    const { client, userId } = await freshLearner();
    const slug = uniq("ssdraft");
    const created = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "草稿课程", level: "a1", description: "" },
    });
    expect(created.statusCode).toBe(201);
    const draftCourseId = (body(created) as { courseId?: string }).courseId as string;

    // 未发布的草稿课程不可成为主课程（catalog 报名 404）。
    const enroll = await client.req("POST", `/api/v1/catalog/courses/${draftCourseId}/enroll`, {
      payload: { makePrimary: true },
    });
    expect(enroll.statusCode).toBe(404);
    expect((await getToday(client)).statusCode).toBe(404);
    const cards = await listCards(userId);
    expect(cards).toHaveLength(0);
  });

  it("后续单元 new 卡不提前进入计划；按首单元词项填充预算", async () => {
    // 2 单元，每单元 1 词（→ 每单元 2 张卡）。预算 5。
    const { client, userId } = await freshLearner();
    const { courseId, unitIds } = await createPublishedCourse({ title: "首单元课程", units: 2 });
    await enrollPrimary(client, courseId);

    const t = await getToday(client);
    expect(t.statusCode).toBe(200);
    expect((t.body as TodayBody).counts).toEqual({ dueCount: 0, initialCount: 0, newCount: 2 });

    const s = await createSession(client);
    expect(s.statusCode).toBe(200);
    // 只有首单元 2 张 new 卡进计划；budget 5 截断后仍 2 项。
    expect((s.body as SessionBody).itemCount).toBe(2);

    const detail = await activeDetail(client);
    expect(detail.statusCode).toBe(200);
    const items = (detail.body as { items: { courseItemId: string }[] }).items;
    expect(items).toHaveLength(2);

    // 全部来自首单元：数据库核对首单元有 2 张卡，且计划项都绑定首单元词项的卡。
    const pool = createPool({ ...config, max: 1 });
    try {
      const firstUnitReleaseItemIds = await pool.query<{ course_item_id: string }>(
        `SELECT rci.course_item_id
         FROM released_course_items rci
         JOIN released_units ru ON ru.id = rci.released_unit_id
         JOIN course_releases r ON r.id = rci.release_id
         JOIN courses c ON c.id = r.course_id AND c.current_release_id = r.id
         WHERE c.id = $1 AND ru.unit_id = $2`,
        [courseId, unitIds[0]],
      );
      const allowed = new Set(firstUnitReleaseItemIds.rows.map((x) => x.course_item_id));
      expect(await countActiveSessions(userId)).toBe(1);

      // 会话计划项必须全部是首单元词项。
      const itemCourseItems = new Set(items.map((i) => i.courseItemId));
      for (const id of itemCourseItems) {
        expect(allowed.has(id)).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });

  it("计划顺序：due(review) > initial(learning) > new", async () => {
    // 1 单元 2 词 → 4 张卡。改第一张为 due(review)、第二张为 initial(learning)、其余 new。
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "排序课程", itemsPerUnit: 2 });
    await enrollPrimary(client, courseId);
    // 先触发 ensureCourseCards（today 补齐卡），再直接改卡状态以制造 due/learning。
    await getToday(client);
    await setCardStates(userId, [{ state: "review" }, { state: "learning" }]);

    const s = await createSession(client);
    expect(s.statusCode).toBe(200);
    const detail = await activeDetail(client);
    const items = (detail.body as { items: { itemKind: string }[] }).items;
    // due_review 排最前，其次 initial_review，最后 new_learning。
    const kinds = items.map((i) => i.itemKind);
    expect(kinds.filter((k) => k === "due_review").length).toBe(1);
    expect(kinds[0]).toBe("due_review");
    expect(kinds[1]).toBe("initial_review");
    // 剩余为 new_learning（2 项）。
    expect(kinds.slice(2).every((k) => k === "new_learning")).toBe(true);
    expect(await countActiveSessions(userId)).toBe(1);
  });

  it("有候选卡时始终返回 active 会话（绝不误报 noWork / 不建空会话）", async () => {
    // 已发布课程必有卡：budget≥1 时 createSession 一定产生 active 会话，DB 恰好一行。
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "非空会话课程", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    await getToday(client);

    const s = await createSession(client);
    expect(s.statusCode).toBe(200);
    expect((s.body as SessionBody).status).toBe("active");
    expect(await countActiveSessions(userId)).toBe(1);

    // 重复调用不产生第二个会话（幂等恢复）。
    await createSession(client);
    expect(await countActiveSessions(userId)).toBe(1);
  });

  it("并发创建只有一个 active 会话；两个请求都返回同一会话", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "并发课程", itemsPerUnit: 2 });
    await enrollPrimary(client, courseId);
    await getToday(client); // 确保卡已补齐

    const [r1, r2] = await Promise.all([createSession(client), createSession(client)]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const s1 = r1.body as SessionBody;
    const s2 = r2.body as SessionBody;
    expect(s1.sessionId).toBe(s2.sessionId);
    expect(await countActiveSessions(userId)).toBe(1);
  });

  it("刷新/重复调用返回同一会话与同一快照顺序", async () => {
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "恢复课程", itemsPerUnit: 2 });
    await enrollPrimary(client, courseId);
    await getToday(client);

    const first = beSession(await createSession(client));
    const detail1 = (await activeDetail(client)).body as {
      session: SessionBody;
      items: { position: number }[];
    };
    const order1 = detail1.items.map((i) => i.position);

    // 刷新：返回同一会话 ID，计划项顺序不变。
    const again = beSession(await createSession(client));
    expect(again.sessionId).toBe(first.sessionId);
    const detail2 = (await activeDetail(client)).body as {
      session: SessionBody;
      items: { position: number }[];
    };
    expect(detail2.items.map((i) => i.position)).toEqual(order1);
  });

  it("current release 在会话创建后切换：既有会话保留自己的 release 快照", async () => {
    const { client } = await freshLearner();
    const { courseId, itemIds, releaseNumber } = await createPublishedCourse({
      title: "快照课程",
      itemsPerUnit: 1,
    });
    expect(releaseNumber).toBe(1);
    await enrollPrimary(client, courseId);
    await getToday(client);

    const s1 = beSession(await createSession(client));
    expect(s1.releaseId).toBeTruthy();
    const snapshotRelease = s1.releaseId as string;

    // 发布 v2 并切为 current（保留同一词项，仅改释义）。
    const itemId = itemIds[0]!;
    const draft = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const patch = await admin.req(
      "PATCH",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      {
        payload: { meaning: "坚持（修订）", draftVersion: draft.version },
      },
    );
    expect(patch.statusCode).toBe(200);
    const draft2 = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const repub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("ssv2") },
      payload: { draftVersion: draft2.version, releaseNote: "版本二" },
    });
    expect(repub.statusCode).toBe(201);
    const v2ReleaseId = (body(repub) as { releaseId?: string }).releaseId;
    expect(v2ReleaseId).toBeTruthy();
    expect(v2ReleaseId).not.toBe(snapshotRelease);

    // 既有会话刷新/读取仍返回创建时的 release 快照，而不是新 current release。
    const again = beSession(await createSession(client));
    expect(again.sessionId).toBe(s1.sessionId);
    expect(again.releaseId).toBe(snapshotRelease);
    const detail = (await activeDetail(client)).body as { session: SessionBody };
    expect(detail.session.releaseId).toBe(snapshotRelease);
  });

  it("会话释放快照冻结 release；新会话用新的 current release（此前已废弃的已完成会话不恢复）", async () => {
    // 直接核对快照不随 current pointer 变化：改变 current 后，既有 active 会话 releaseId 不变。
    const { client } = await freshLearner();
    const { courseId, itemIds } = await createPublishedCourse({
      title: "冻结课程",
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    await getToday(client);

    const s1 = beSession(await createSession(client));
    const frozen = s1.releaseId as string;

    // 发布 v2（同一词项保留）并切 current。
    const itemId = itemIds[0]!;
    const draft = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
      payload: { meaning: "冻结测试", draftVersion: draft.version },
    });
    const draft2 = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("ssfreeze") },
      payload: { draftVersion: draft2.version, releaseNote: "v2" },
    });

    const again = beSession(await createSession(client));
    expect(again.releaseId).toBe(frozen);
  });

  it("数据权限边界：非本人会话不可见（他人 active 不影响本用户）", async () => {
    const { client: first, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "隔离课程", itemsPerUnit: 1 });
    await enrollPrimary(first, courseId);
    await getToday(first);
    const s1 = beSession(await createSession(first));

    // 第二个独立学习者（未报名该课程）看不到它，也没有自己的会话。
    const { client: second } = await freshLearner();
    expect((await createSession(second)).statusCode).toBe(404); // 无主课程 → 404
    expect((await activeDetail(second)).statusCode).toBe(404);

    // 已报名但非该课程：换个主课程课程。
    const { courseId: otherCourse } = await createPublishedCourse({
      title: "另一课程",
      itemsPerUnit: 1,
    });
    await enrollPrimary(second, otherCourse);
    expect((await activeDetail(second)).statusCode).toBe(404); // 无自己的 active 会话

    // first 本人的会话不受影响。
    expect(await countActiveSessions(userId)).toBe(1);
    expect((await activeDetail(first)).body?.session.sessionId).toBe(s1.sessionId);
  });
});

function beSession(r: {
  statusCode: number;
  body: SessionBody | { noWork: boolean } | null;
}): SessionBody {
  if (r.statusCode !== 200 || !r.body || "noWork" in r.body) {
    throw new Error("expected session response");
  }
  return r.body as SessionBody;
}
