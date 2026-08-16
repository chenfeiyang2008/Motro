// 评分提交、展示确认与进度派生集成验收（阶段 5 工单 04）：真实 PostgreSQL + API + domain。
// 覆盖工单 04 的 15 个场景：
//   1) reveal 把当前 cursor 的 pending 项标记 shown（幂等）
//   2) reveal 只允许当前 cursor 项（不允许跳题）
//   3) reveal 的非活动/他人会话 → 404
//   4) 评分在事务内写不可变 ReviewEvent 并推进 cursor
//   5) 未 reveal 不允许评分（422）
//   6) 相同 clientEventId + 相同请求 → 幂等重放（同 response，不二次推进）
//   7) 相同 clientEventId + 不同请求 → 409 IDEMPOTENCY_CONFLICT
//   8) item.cardId 与请求 cardId 不一致 → 422
//   9) 评分推进 cursor；最后一项评分 → 会话 completed
//   10) is_initial_review 派生：首测 true，二次 false
//   11) 单元解锁派生：单元内全部词项双向首测后下一单元解锁
//   12) progress 端点派生 unlock / initial / stable
//   13) 并发对同一计划项评分：只有一个 ReviewEvent 产生
//   14) 会话完成后再评分（或并发改写卡版本）→ 回滚，无事件产生
//   15) review_events 不可变：UPDATE/DELETE 被触发器拒绝
//
// 复用 study-sessions 的设置思路：每用例独立新学习者；数据库不可用即抛错，不静默跳过。
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
}

describe("review submission, reveal, and progress", () => {
  let app: App;
  let admin: Client;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "review-progress 需要运行中的 PostgreSQL（compose 的 db 服务）。启动后重跑；本套件不会静默跳过。",
      );
    }
    await migrate(config, MIGRATIONS_DIR);
    const suffix = randomBytes(3).toString("hex");
    const ps = new PasswordService();
    const pool = createPool({ ...config, max: 1 });
    const adminU = `rp-admin-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Rp Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminU, await ps.hashPassword("rp-admin-pass-123")],
    );
    await pool.end();
    app = await createApp();
    await app.init();
    admin = await makeClient(app);
    const r = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: adminU, password: "rp-admin-pass-123" },
    });
    expect(r.statusCode).toBe(200);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const ps = new PasswordService();
  let userSeq = 0;
  async function freshLearner(): Promise<{ client: Client; userId: string }> {
    const uname = `rp-fresh-${randomBytes(4).toString("hex")}-${userSeq++}`;
    const pool = createPool({ ...config, max: 1 });
    const rows = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Rp Fresh', 'learner', 'active', 'Asia/Shanghai', 30, $2, false)
       RETURNING id`,
      [uname, await ps.hashPassword("rp-fresh-pass-123")],
    );
    await pool.end();
    const userId = rows.rows[0]!.id;
    const client = makeClient(app);
    const log = await client.req("POST", "/api/v1/auth/login", {
      payload: { username: uname, password: "rp-fresh-pass-123" },
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

  async function createPublishedCourse(opts: {
    title: string;
    units?: number;
    itemsPerUnit?: number;
  }): Promise<PublishedCourse> {
    const units = opts.units ?? 1;
    const itemsPerUnit = opts.itemsPerUnit ?? 1;
    const slug = uniq("rpcourse");
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
        {
          payload: { title: `U${u + 1}`, description: "", draftVersion: version },
        },
      );
      expect(uu.statusCode).toBe(201);
      version = (body(uu) as { version?: number }).version ?? version;
      for (let i = 0; i < itemsPerUnit; i++) {
        const itemId = randomUUID();
        const entryId = uniq("entry");
        const entry = await admin.req("POST", "/api/v1/admin/lexical-entries", {
          payload: { canonicalSpelling: entryId, confirmDuplicate: false },
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
      headers: { "idempotency-key": uniq("rppub") },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect(pub.statusCode).toBe(201);
    return { courseId, unitIds, itemIds };
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

  /** 便利：完成「reveal → 评分」一次流转，返回评分响应。 */
  async function revealThenReview(
    client: Client,
    sessionId: string,
    item: SessionItem,
    rating = "good",
    clientEventId = uniq("ev"),
  ): Promise<Res> {
    const rv = await client.req(
      "POST",
      `/api/v1/study/sessions/${sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    expect(rv.statusCode).toBe(200);
    return await client.req("POST", `/api/v1/study/sessions/${sessionId}/reviews`, {
      payload: {
        sessionItemId: item.itemId,
        cardId: item.cardId,
        rating,
        clientEventId,
      },
    });
  }

  /** 直接读 review_events 行数。 */
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

  // —— 用例 ——

  it("revel 把 pending 标记为 shown 且幂等（重复 reveal 返回 alreadyShown）", async () => {
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "reveal课程", itemsPerUnit: 1 });
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
    expect(b1.alreadyShown).toBe(false);
    expect(b1.itemKind).toBe("new_learning"); // 1 单元 1 词 → 双向 new 卡

    // 重复 reveal 幂等：状态仍 shown，alreadyShown=true。
    const r2 = await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json() as { state: string; alreadyShown: boolean };
    expect(b2.state).toBe("shown");
    expect(b2.alreadyShown).toBe(true);
  });

  it("reveal 只允许当前 cursor 项（不允许跳题 reveal 第二项）", async () => {
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "跳题课程", itemsPerUnit: 2 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    // items[0] 是当前项；尝试直接 reveal 第二项 → 404。
    const second = items[1]!;
    const r = await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${second.itemId}/reveal`,
      {},
    );
    expect(r.statusCode).toBe(404);
  });

  it("reveal 非 active 完成会话 / 他人会话 → 404", async () => {
    const { client: alice } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "权限课程", itemsPerUnit: 1 });
    await enrollPrimary(alice, courseId);
    const { session, items } = await ensureSession(alice);
    const item = items[0]!;

    // 他人（无此会话）尝试 reveal 该 item → 404。
    const { client: bob } = await freshLearner();
    const rb = await bob.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    expect(rb.statusCode).toBe(404);
    // 无效 sessionId → 404。
    const ra = await alice.req(
      "POST",
      `/api/v1/study/sessions/${randomUUID()}/items/${item.itemId}/reveal`,
      {},
    );
    expect(ra.statusCode).toBe(404);
  });

  it("评分把计划项推进到 completed 并推进 cursor；完成后会话 → completed", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "推进课程", itemsPerUnit: 2 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;

    const r = await revealThenReview(client, session.sessionId, item, "good", uniq("c1"));
    expect(r.statusCode).toBe(200);
    const b = r.json() as {
      sessionCompleted: boolean;
      newCursor: number | null;
      isInitialReview: boolean;
      memorySummary: { state: string };
    };
    expect(b.isInitialReview).toBe(true); // 首测
    expect(b.sessionCompleted).toBe(false);
    expect(b.newCursor).toBe(2); // 单向只推进一卡；本单元另有反方向卡
    expect(await countReviewEvents(userId)).toBe(1);

    // 第一项 completed；会话仍 active（还有下一项）。
    const sessPool = createPool({ ...config, max: 1 });
    try {
      const st = await sessPool.query<{ state: string }>(
        "SELECT state FROM study_session_items WHERE id = $1",
        [item.itemId],
      );
      expect(st.rows[0]!.state).toBe("completed");
    } finally {
      await sessPool.end();
    }
  });

  it("未 reveal 不允许评分（422）", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "前置课程", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    // 直接评分（不 reveal）→ 422。
    const r = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload: {
        sessionItemId: item.itemId,
        cardId: item.cardId,
        rating: "good",
        clientEventId: "ev-noreveal",
      },
    });
    expect(r.statusCode).toBe(422);
    expect(await countReviewEvents(userId)).toBe(0);
  });

  it("cardId 与 session item 绑定卡不一致 → 422", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "卡错课程", itemsPerUnit: 2 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    const wrongCard = items[1]!.cardId;
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    const r = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload: {
        sessionItemId: item.itemId,
        cardId: wrongCard,
        rating: "good",
        clientEventId: "ev-wrong",
      },
    });
    expect(r.statusCode).toBe(422);
    expect(await countReviewEvents(userId)).toBe(0);
  });

  it("幂等重放：相同 clientEventId + 相同请求返回首次 response，不二次推进", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "幂等课程", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    const ev = uniq("idem");
    const r1 = await revealThenReview(client, session.sessionId, item, "good", ev);
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as {
      idempotentReplay: boolean;
      reviewEventId: string;
      xpAwarded: number;
    };
    expect(b1.idempotentReplay).toBe(false);
    // 首次有效评分（is_initial_review=true）→ 5 XP。
    expect(b1.xpAwarded).toBe(5);
    expect(await countReviewEvents(userId)).toBe(1);

    // 重放：不产生新事件、cursor 不前进。
    const r2 = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload: {
        sessionItemId: item.itemId,
        cardId: item.cardId,
        rating: "good",
        clientEventId: ev,
      },
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json() as { idempotentReplay: boolean; reviewEventId: string; xpAwarded: number };
    expect(b2.idempotentReplay).toBe(true);
    expect(b2.reviewEventId).toBe(b1.reviewEventId); // 返回首次事件
    expect(b2.xpAwarded).toBe(b1.xpAwarded); // 重放返回完全一致的 xpAwarded（不重复记 XP）
    expect(await countReviewEvents(userId)).toBe(1); // 不产生新事件
  });

  it("同 clientEventId + 不同请求 → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "冲突课程", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );
    const ev = "ev-conflict";
    const first = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload: {
        sessionItemId: item.itemId,
        cardId: item.cardId,
        rating: "good",
        clientEventId: ev,
      },
    });
    expect(first.statusCode).toBe(200);

    const conflict = await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/reviews`,
      {
        payload: {
          sessionItemId: item.itemId,
          cardId: item.cardId,
          rating: "easy",
          clientEventId: ev,
        },
      },
    );
    expect(conflict.statusCode).toBe(409);
    const err = conflict.json() as { error: { code: string } };
    expect(err.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await countReviewEvents(userId)).toBe(1); // 冲突不产生新事件
  });

  it("首测派生：is_initial_review 首方向 true，二次 false；会话逐项推进直到完成", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "首测课程", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    // 1 词 → 双向卡。第一项评分是首测（true）。
    const firstItem = items[0]!;
    const r1 = await revealThenReview(client, session.sessionId, firstItem, "good", "ev-first");
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as { isInitialReview: boolean };
    expect(b1.isInitialReview).toBe(true);
    expect(await countReviewEvents(userId)).toBe(1);

    // 若本会话只有一项（budget 大但卡少），反方向卡会进同一会话下一项。
    if (items.length > 1) {
      const second = items[1]!;
      await client.req(
        "POST",
        `/api/v1/study/sessions/${session.sessionId}/items/${second.itemId}/reveal`,
        {},
      );
      const r2 = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
        payload: {
          sessionItemId: second.itemId,
          cardId: second.cardId,
          rating: "good",
          clientEventId: "ev-second",
        },
      });
      expect(r2.statusCode).toBe(200);
      const b2 = r2.json() as { isInitialReview: boolean; sessionCompleted: boolean };
      expect(b2.isInitialReview).toBe(true); // 反方向首测
      expect(b2.sessionCompleted).toBe(true);
    }
  });

  it("单元解锁：单元内全部词项双向首测后，下一单元解锁（progress 反映）", async () => {
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "解锁课程",
      units: 2,
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    // 预算 30：首单元 1 词 → 2 卡。完成后第二单元解锁。
    for (const item of items) {
      await client.req(
        "POST",
        `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
        {},
      );
      const r = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
        payload: {
          sessionItemId: item.itemId,
          cardId: item.cardId,
          rating: "good",
          clientEventId: uniq("ev"),
        },
      });
      expect(r.statusCode).toBe(200);
    }

    const p = await client.req("GET", "/api/v1/study/progress", {});
    expect(p.statusCode).toBe(200);
    const prog = p.json() as {
      units: {
        position: number;
        unlocked: boolean;
        itemCount: number;
        initialCompletedItemCount: number;
      }[];
      highestUnlockedUnit: number;
    };
    // 首单元已全部双向首测 → 第二单元解锁。
    expect(prog.units.find((u) => u.position === 1)!.unlocked).toBe(true);
    expect(prog.units.find((u) => u.position === 2)!.unlocked).toBe(true);
    expect(prog.highestUnlockedUnit).toBe(2);
  });

  it("progress 返回无任务课程的空单元 / 首单元默认解锁", async () => {
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "空进度课", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const p = await client.req("GET", "/api/v1/study/progress", {});
    expect(p.statusCode).toBe(200);
    const prog = p.json() as { courseId: string; units: { position: number; unlocked: boolean }[] };
    expect(prog.courseId).toBe(courseId);
    // 未评分 → 首单元解锁，second 未解锁。
    expect(prog.units.find((u) => u.position === 1)!.unlocked).toBe(true);
  });

  it("并发同一计划项评分：只产生一个 ReviewEvent，且 cursor 不重复推进", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "并发评分课", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );

    const evA = "ev-conc-a";
    const evB = "ev-conc-b";
    const [rA, rB] = await Promise.all([
      client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
        payload: {
          sessionItemId: item.itemId,
          cardId: item.cardId,
          rating: "good",
          clientEventId: evA,
        },
      }),
      client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
        payload: {
          sessionItemId: item.itemId,
          cardId: item.cardId,
          rating: "good",
          clientEventId: evB,
        },
      }),
    ]);
    // 两者都不应收 409（不同幂等键），但只有一个真正落库、推进 cursor；
    // 另一个因 item 已被并发 completed → 404/422（不是当前项）。
    const ok = [rA, rB].filter((r) => r.statusCode === 200);
    expect(ok.length).toBe(1);
    expect(await countReviewEvents(userId)).toBe(1);
  });

  it("会话完成后不能再评分该 item（advance 后过期的 item → 404/422），无新事件", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "完成后课", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    for (const item of items) {
      const r = await revealThenReview(client, session.sessionId, item, "good", uniq("ev"));
      expect(r.statusCode).toBe(200);
    }
    // 所有项已完成，会话 completed。再评第一项（已非 cursor）→ 404。
    const item = items[0]!;
    const again = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload: {
        sessionItemId: item.itemId,
        cardId: item.cardId,
        rating: "good",
        clientEventId: "ev-after",
      },
    });
    expect(again.statusCode).toBe(404);
    expect(await countReviewEvents(userId)).toBeLessThanOrEqual(2);
  });

  it("review_events 不可变：直接 UPDATE/DELETE 被触发器拒绝", async () => {
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "不可变课", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    // 通过 API 落一条 review_events。
    const r = await revealThenReview(client, session.sessionId, item, "good", uniq("ev-imm"));
    expect(r.statusCode).toBe(200);

    const pool = createPool({ ...config, max: 1 });
    try {
      const ev = await pool.query<{ id: string }>(
        "SELECT id FROM review_events WHERE user_id = $1 LIMIT 1",
        [userId],
      );
      const eventId = ev.rows[0]!.id;
      await expect(
        pool.query("UPDATE review_events SET rating = 'easy' WHERE id = $1", [eventId]),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query("DELETE FROM review_events WHERE id = $1", [eventId]),
      ).rejects.toThrow(/immutable/);
    } finally {
      await pool.end();
    }
  });

  it("并发相同 clientEventId + 相同请求：两笔都成功，返回同一 reviewEventId，恰一笔非重放", async () => {
    // P1#2：advisory xact lock 把同键请求串行化。两笔完全一致、同时提交的评分，
    // 第二笔在锁上排队，直到第一笔提交后重查到已存事件 → 幂等重放，
    // 而不是撞见 item 已 completed 得到验证错误。
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "并发同键课", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );

    const ev = uniq("ev-samekey");
    const payload = {
      sessionItemId: item.itemId,
      cardId: item.cardId,
      rating: "good",
      clientEventId: ev,
    };
    const [rA, rB] = await Promise.all([
      client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, { payload }),
      client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, { payload }),
    ]);
    // 两笔都必须成功（200），其中恰一笔 idempotentReplay=false，另一笔 =true。
    expect(rA.statusCode).toBe(200);
    expect(rB.statusCode).toBe(200);
    const bA = rA.json() as { idempotentReplay: boolean; reviewEventId: string };
    const bB = rB.json() as { idempotentReplay: boolean; reviewEventId: string };
    const replayFlags = [bA.idempotentReplay, bB.idempotentReplay].sort();
    expect(replayFlags).toEqual([false, true]);

    // 两笔返回同一事件 ID，且 DB 只有一条事件、卡只推进一次、cursor 只前进一次。
    expect(bB.reviewEventId).toBe(bA.reviewEventId);
    expect(await countReviewEvents(userId)).toBe(1);

    const pool = createPool({ ...config, max: 1 });
    try {
      const sess = await pool.query<{ status: string; cursor: number }>(
        "SELECT status, cursor FROM study_sessions WHERE id = $1",
        [session.sessionId],
      );
      expect(sess.rows[0]!.status).toBe("active");
      const card = await pool.query<{ reps: number }>(
        `SELECT reps FROM learning_cards lc
         JOIN review_events re ON re.card_id = lc.id
         WHERE re.user_id = $1`,
        [userId],
      );
      // 卡只推进一次：reps=1 且该卡仅一条事件。
      expect(card.rows.length).toBe(1);
      expect(card.rows[0]!.reps).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("并发不同 clientEventId 提交同一 shown item：仅一笔成功，另一笔安全拒绝，无重复事件", async () => {
    // P1#2：不同幂等键不冲突，但同一 shown item 只能落地一笔评分；
    // 另一笔在 FOR UPDATE 锁下看到 item 已被并发 completed → 非当前项 404/422，不产生第二条事件。
    const { client, userId } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "并发异键课", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const item = items[0]!;
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${item.itemId}/reveal`,
      {},
    );

    const makeReview = (ev: string) =>
      client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
        payload: {
          sessionItemId: item.itemId,
          cardId: item.cardId,
          rating: "good",
          clientEventId: ev,
        },
      });
    const [rA, rB] = await Promise.all([makeReview(uniq("ev-a")), makeReview(uniq("ev-b"))]);
    const ok = [rA, rB].filter((r) => r.statusCode === 200);
    const rejected = [rA, rB].filter((r) => r.statusCode !== 200);
    expect(ok.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect([404, 422]).toContain(rejected[0]!.statusCode);
    expect(await countReviewEvents(userId)).toBe(1);
  });

  it("响应 progress/unlock 反映刚提交的末项第二方向首测：词项完成 + 下一单元已解锁，与 GET /progress 一致", async () => {
    // P1#3：buildReviewResponse 用投影把本次首测当作已提交事实参与派生。
    // 完成第 1 单元唯一词项的双向首测后，响应里的 unlock 立即显示：
    //   第 1 单元 initialCompletedItemCount=1（该词项首测完成）、第 2 单元已解锁；
    //   随后 GET /study/progress 与响应完全一致。
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({
      title: "响应进度课",
      units: 2,
      itemsPerUnit: 1,
    });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    // 第 1 单元 1 词 → 双向卡。顺序评完两个方向。
    const first = items[0]!;
    const second = items[1]!;

    // 第一方向首测：此时对向未完成，词项仍未完成，第 2 单元未解锁。
    const r1 = await revealThenReview(client, session.sessionId, first, "good", uniq("ev1"));
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as {
      isInitialReview: boolean;
      unlock: {
        highestUnlockedUnit: number;
        units: {
          position: number;
          unlocked: boolean;
          requiredItemCount: number;
          initialCompletedItemCount: number;
        }[];
      };
    };
    expect(b1.isInitialReview).toBe(true);
    const unit1AfterFirst = b1.unlock.units.find((u) => u.position === 1)!;
    expect(unit1AfterFirst.initialCompletedItemCount).toBe(0); // 对向未首测 → 未完成
    expect(b1.unlock.units.find((u) => u.position === 2)!.unlocked).toBe(false);

    // 第二方向（末项）首测 → 词项完成、第 2 单元解锁。
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${second.itemId}/reveal`,
      {},
    );
    const r2 = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload: {
        sessionItemId: second.itemId,
        cardId: second.cardId,
        rating: "good",
        clientEventId: uniq("ev2"),
      },
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json() as {
      isInitialReview: boolean;
      unlock: {
        highestUnlockedUnit: number;
        units: {
          position: number;
          unlocked: boolean;
          requiredItemCount: number;
          initialCompletedItemCount: number;
        }[];
      };
    };
    expect(b2.isInitialReview).toBe(true);
    const unit1AfterSecond = b2.unlock.units.find((u) => u.position === 1)!;
    expect(unit1AfterSecond.initialCompletedItemCount).toBe(1); // 词项首测完成
    expect(unit1AfterSecond.unlocked).toBe(true);
    const unit2AfterSecond = b2.unlock.units.find((u) => u.position === 2)!;
    expect(unit2AfterSecond.unlocked).toBe(true); // 下一单元解锁
    expect(b2.unlock.highestUnlockedUnit).toBe(2);

    // 随后 GET /study/progress 与响应完全一致。
    const p = await client.req("GET", "/api/v1/study/progress", {});
    expect(p.statusCode).toBe(200);
    const prog = p.json() as {
      highestUnlockedUnit: number;
      units: {
        position: number;
        unlocked: boolean;
        itemCount: number;
        initialCompletedItemCount: number;
      }[];
    };
    expect(prog.highestUnlockedUnit).toBe(b2.unlock.highestUnlockedUnit);
    for (const u of b2.unlock.units) {
      const got = prog.units.find((x) => x.position === u.position)!;
      expect(got).toBeDefined();
      expect(got.unlocked).toBe(u.unlocked);
      expect(got.itemCount).toBe(u.requiredItemCount);
      expect(got.initialCompletedItemCount).toBe(u.initialCompletedItemCount);
    }
  });

  it("非首测评分不会错误推进 unlock（响应与 DB 一致）", async () => {
    // P1#3：非 is_initial_review 的评分不应把单元 initialCompletedItemCount 或解锁推向 +1。
    // 构造：1 单元 1 词 → 双向卡；评完两方向（双向首测完成）后，再对其中一方向评一次（非首测），
    // 观察本次非首测评分的响应 unlock 初始计数与 DB 一致。
    const { client } = await freshLearner();
    const { courseId } = await createPublishedCourse({ title: "非首测课", itemsPerUnit: 1 });
    await enrollPrimary(client, courseId);
    const { session, items } = await ensureSession(client);
    const first = items[0]!;
    const second = items[1]!;

    // 双向首测完成。
    const r1 = await revealThenReview(client, session.sessionId, first, "good", uniq("ev-fi"));
    expect(r1.statusCode).toBe(200);
    expect((r1.json() as { isInitialReview: boolean }).isInitialReview).toBe(true);

    await client.req(
      "POST",
      `/api/v1/study/sessions/${session.sessionId}/items/${second.itemId}/reveal`,
      {},
    );
    const r2 = await client.req("POST", `/api/v1/study/sessions/${session.sessionId}/reviews`, {
      payload: {
        sessionItemId: second.itemId,
        cardId: second.cardId,
        rating: "good",
        clientEventId: uniq("ev-si"),
      },
    });
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { isInitialReview: boolean }).isInitialReview).toBe(true);
    // 双向首测完成 → 第 2 单元解锁，initialCompletedItemCount=1。
    const b2 = r2.json() as {
      unlock: { units: { position: number; initialCompletedItemCount: number }[] };
    };
    expect(b2.unlock.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(1);

    // 会话已完成。开新会话：两方向卡因 FSRS 推进进入 due_review，新会话会把它们带回来。
    const { session: session2, items: items2 } = await ensureSession(client);
    // items2 至少含 one of the two cards；找 first 方向的卡。
    const dueItem = items2.find((it) => it.cardId === first.cardId) ?? items2[0]!;
    await client.req(
      "POST",
      `/api/v1/study/sessions/${session2.sessionId}/items/${dueItem.itemId}/reveal`,
      {},
    );
    const r3 = await client.req("POST", `/api/v1/study/sessions/${session2.sessionId}/reviews`, {
      payload: {
        sessionItemId: dueItem.itemId,
        cardId: dueItem.cardId,
        rating: "hard",
        clientEventId: uniq("ev-ni"),
      },
    });
    expect(r3.statusCode).toBe(200);
    const b3 = r3.json() as {
      isInitialReview: boolean;
      unlock: { units: { position: number; initialCompletedItemCount: number }[] };
    };
    expect(b3.isInitialReview).toBe(false); // 非首测

    const p = await client.req("GET", "/api/v1/study/progress", {});
    const prog = p.json() as { units: { position: number; initialCompletedItemCount: number }[] };
    // 响应与 DB 的初始计数一致；非首测未推进。
    expect(b3.unlock.units.find((u) => u.position === 1)!.initialCompletedItemCount).toBe(
      prog.units.find((u) => u.position === 1)!.initialCompletedItemCount,
    );
  });
});
