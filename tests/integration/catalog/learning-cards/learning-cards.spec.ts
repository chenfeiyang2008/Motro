// 阶段 5 工单 01 集成验收：学习卡与学习展示（真实 PostgreSQL + API + domain）。
// 覆盖：0010 空库顺序迁移、双向卡创建、重复创建幂等、用户隔离、跨课程不共享、
// 只允许 current release 内容、草稿词项不可创建卡、无 current release 不可创建、
// 展示首次写入/幂等/不改变 FSRS 状态、不产生复习/XP/排行榜数据、learner/admin 权限边界。
//
// 与 phase4-closeout 一致：数据库不可用时明确失败（throw），不静默跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, listAppliedMigrations, loadDbConfigFromEnv, migrate } from "@motro/db";
import { buildExposureState, buildInitialCardState } from "@motro/domain";
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
  draftVersion: number;
  unitId: string;
  unitIds: string[];
  itemIds: string[];
  entryIds: string[];
}

interface CardItem {
  cardId: string;
  courseId: string;
  releaseId: string;
  courseItemId: string;
  direction: string;
  state: string;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  elapsedDays: number;
  reps: number;
  lapses: number;
  lastReviewAt: string | null;
  dueAt: string;
  schedulerVersion: string;
  englishSpelling: string;
  meaning: string;
  exposed: boolean;
}

interface ExposureBody {
  exposureId: string;
  courseItemId: string;
  lexicalEntryId: string;
  courseId: string;
  releaseId: string;
  firstExposedAt: string;
  alreadyExisted: boolean;
}

describe("learning cards and exposures", () => {
  let app: App;
  let admin: Client;
  let learnerA: Client;
  let learnerB: Client;
  let adminUsername: string;
  let learnerAUsername: string;
  let learnerBUsername: string;

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "learning-cards 需要运行中的 PostgreSQL（compose 的 db 服务）。" +
          "请启动数据库后重跑；本套件不会静默跳过。",
      );
    }

    const suffix = randomBytes(3).toString("hex");
    adminUsername = `lc-admin-${suffix}`;
    learnerAUsername = `lc-learner-a-${suffix}`;
    learnerBUsername = `lc-learner-b-${suffix}`;

    // 开发数据库已迁移则 no-op；0010 未应用则补齐。
    await migrate(config, MIGRATIONS_DIR);

    const seedPool = createPool({ ...config, max: 1 });
    const ps = new PasswordService();
    await seedPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'LC ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, must_change_password = false, status = 'active'`,
      [adminUsername, await ps.hashPassword("lc-admin-pass-123")],
    );
    await seedPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'LC ITest Learner A', 'learner', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, must_change_password = false, status = 'active'`,
      [learnerAUsername, await ps.hashPassword("lc-learner-a-pass-123")],
    );
    await seedPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'LC ITest Learner B', 'learner', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, must_change_password = false, status = 'active'`,
      [learnerBUsername, await ps.hashPassword("lc-learner-b-pass-123")],
    );
    await seedPool.end();

    app = await createApp();
    await app.init();

    async function loginAs(username: string, password: string): Promise<Client> {
      const client = makeClient(app);
      const res = await client.req("POST", "/api/v1/auth/login", {
        payload: { username, password },
      });
      expect(res.statusCode).toBe(200);
      return client;
    }

    admin = await loginAs(adminUsername, "lc-admin-pass-123");
    learnerA = await loginAs(learnerAUsername, "lc-learner-a-pass-123");
    learnerB = await loginAs(learnerBUsername, "lc-learner-b-pass-123");
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }

  function uniq(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}`;
  }

  async function createEntry(spelling?: string): Promise<string> {
    const res = await admin.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: spelling ?? uniq("lcword"), confirmDuplicate: false },
    });
    expect(res.statusCode).toBe(201);
    return (body(res) as { id?: string }).id as string;
  }

  /** 创建课程 + 单元 + N 个词项并发布；可复用既有词条。 */
  async function createPublishedCourse(
    opts: {
      title?: string;
      entryIds?: string[];
      itemCount?: number;
    } = {},
  ): Promise<PublishedCourse> {
    const itemCount = opts.itemCount ?? 1;
    const entryIds: string[] = [];
    for (let i = 0; i < itemCount; i++) {
      entryIds.push(opts.entryIds?.[i] ?? (await createEntry()));
    }
    const slug = uniq("lccourse");
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: opts.title ?? "学习卡课程", level: "a1", description: "课程描述" },
    });
    expect(res.statusCode).toBe(201);
    const created = body(res) as { courseId?: string; draftVersion?: number };
    const courseId = created.courseId as string;
    let version = created.draftVersion ?? 1;

    const unitId = randomUUID();
    const u = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
      payload: { title: "基础词汇", description: "单元描述", draftVersion: version },
    });
    expect(u.statusCode).toBe(201);
    version = (body(u) as { version?: number }).version ?? version;

    const itemIds: string[] = [];
    for (const entryId of entryIds) {
      const itemId = randomUUID();
      const i = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
        payload: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
      });
      expect(i.statusCode).toBe(201);
      version = (body(i) as { version?: number }).version ?? version;
      itemIds.push(itemId);
    }

    const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("lcpub") },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect(pub.statusCode).toBe(201);
    return { courseId, draftVersion: version, unitId, unitIds: [unitId], itemIds, entryIds };
  }

  /**
   * 创建每单元一个词项的多单元课程并发布。
   * 用于“版本变更/指针切换”类测试：词项各占独立单元，便于按单元删除词项来制造版本差异。
   * 阶段 4 发布快照复制曾有“同单元多词项只复制首项”的缺陷，已在本会话中修复并新增
   * 同单元多词项回归测试（见下方「P1 修复」用例）；本 helper 保持每单元一词项的结构，
   * 使版本回收测试聚焦于 current-release 边界而非发布复制本身。
   */
  async function createCourseOnePerUnit(
    itemCount: number,
    title: string,
  ): Promise<PublishedCourse> {
    const entryIds: string[] = [];
    for (let i = 0; i < itemCount; i++) entryIds.push(await createEntry());
    const slug = uniq("lcsep");
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title, level: "a1", description: "课程描述" },
    });
    expect(res.statusCode).toBe(201);
    const courseId = (body(res) as { courseId?: string }).courseId as string;
    let version = (body(res) as { draftVersion?: number }).draftVersion ?? 1;

    const unitIds: string[] = [];
    const itemIds: string[] = [];
    for (const entryId of entryIds) {
      const unitId = randomUUID();
      const u = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
        payload: { title: `单元${unitIds.length + 1}`, description: "", draftVersion: version },
      });
      expect(u.statusCode).toBe(201);
      version = (body(u) as { version?: number }).version ?? version;

      const itemId = randomUUID();
      const i = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
        payload: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
      });
      expect(i.statusCode).toBe(201);
      version = (body(i) as { version?: number }).version ?? version;
      unitIds.push(unitId);
      itemIds.push(itemId);
    }

    const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("lcpub2") },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect(pub.statusCode).toBe(201);
    return { courseId, draftVersion: version, unitId: unitIds[0]!, unitIds, itemIds, entryIds };
  }

  async function enrollPrimary(client: Client, courseId: string): Promise<void> {
    const res = await client.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
      payload: { makePrimary: true },
    });
    expect(res.statusCode).toBe(200);
  }

  async function listCards(client: Client, courseId?: string): Promise<CardItem[]> {
    const url = courseId ? `/api/v1/study/cards?courseId=${courseId}` : "/api/v1/study/cards";
    const res = await client.req("GET", url, {});
    expect(res.statusCode).toBe(200);
    return (body(res) as { items: CardItem[] }).items;
  }

  interface SummaryBody {
    courseId: string;
    releaseId: string;
    releaseNumber: number;
    itemCount: number;
    cards: {
      total: number;
      new: number;
      learning: number;
      review: number;
      enToZh: number;
      zhToEn: number;
    };
    exposedItemCount: number;
  }

  async function getSummary(client: Client): Promise<SummaryBody> {
    const res = await client.req("GET", "/api/v1/study/cards/summary", {});
    expect(res.statusCode).toBe(200);
    return body(res) as unknown as SummaryBody;
  }

  async function exposeItem(
    client: Client,
    courseItemId: string,
  ): Promise<{ statusCode: number; body: ExposureBody | null }> {
    const res = await client.req("POST", "/api/v1/study/exposures", {
      payload: { courseItemId },
    });
    return { statusCode: res.statusCode, body: res.json() as ExposureBody };
  }

  it("0001–0011 migration 从空库顺序应用（一次性隔离数据库）：learning_cards / learning_exposures + 唯一约束 + 展示不可变触发器", async () => {
    const dbName = `motro_lc_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }

    const isoConfig = { ...config, database: dbName };
    try {
      const applied = await migrate(isoConfig, MIGRATIONS_DIR);
      expect(applied.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

      const verify = createPool({ ...isoConfig, max: 1 });
      try {
        const recorded = await listAppliedMigrations(isoConfig);
        expect(recorded.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

        const tables = await verify.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename IN ('learning_cards', 'learning_exposures')`,
        );
        expect(tables.rows.map((r) => r.tablename).sort()).toEqual([
          "learning_cards",
          "learning_exposures",
        ]);

        // 卡身份唯一：每 (user, course_item, direction) 至多一行。
        const cardIdx = await verify.query(
          `SELECT 1 FROM pg_indexes
           WHERE tablename = 'learning_cards'
             AND indexname = 'learning_cards_user_item_direction_unique'`,
        );
        expect(cardIdx.rowCount).toBe(1);

        // 展示唯一：每 (user, course_item) 至多一行。
        const expIdx = await verify.query(
          `SELECT 1 FROM pg_indexes
           WHERE tablename = 'learning_exposures'
             AND indexname = 'learning_exposures_user_item_unique'`,
        );
        expect(expIdx.rowCount).toBe(1);

        // 展示不可变触发器已安装。
        const triggers = await verify.query<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger
           WHERE tgrelid = 'learning_exposures'::regclass
             AND NOT tgisinternal
             AND tgname IN ('learning_exposures_no_update', 'learning_exposures_no_delete')`,
        );
        expect(triggers.rows.map((r) => r.tgname).sort()).toEqual([
          "learning_exposures_no_delete",
          "learning_exposures_no_update",
        ]);

        // 0011：learning_cards 调度参数版本列 + 学习步骤列，均 NOT NULL。
        const cols = await verify.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_name = 'learning_cards'
             AND column_name IN ('scheduler_parameters_version', 'learning_steps')
           ORDER BY column_name`,
        );
        expect(cols.rows).toEqual([
          { column_name: "learning_steps", is_nullable: "NO" },
          { column_name: "scheduler_parameters_version", is_nullable: "NO" },
        ]);
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

  it("同一课程词项创建两个方向独立卡；重复读取幂等不产生重复卡", async () => {
    const { courseId, itemIds } = await createPublishedCourse({ title: "双向卡课程" });
    await enrollPrimary(learnerA, courseId);

    const summary1 = body(await learnerA.req("GET", "/api/v1/study/cards/summary", {})) as {
      courseId: string;
      itemCount: number;
      cards: { total: number; enToZh: number; zhToEn: number; new: number };
    };
    expect(summary1.courseId).toBe(courseId);
    expect(summary1.itemCount).toBe(1);
    expect(summary1.cards).toEqual({
      total: 2,
      new: 2,
      learning: 0,
      review: 0,
      enToZh: 1,
      zhToEn: 1,
    });

    const cards1 = await listCards(learnerA);
    expect(cards1).toHaveLength(2);
    expect(cards1.map((c) => c.direction).sort()).toEqual(["en_to_zh", "zh_to_en"]);
    expect(cards1.every((c) => c.courseItemId === itemIds[0])).toBe(true);
    expect(cards1.every((c) => c.state === "new")).toBe(true);
    expect(cards1.every((c) => c.stability === 0)).toBe(true);
    expect(cards1.every((c) => c.difficulty === 0)).toBe(true);
    expect(cards1.every((c) => c.schedulerVersion === "fsrs-v6")).toBe(true);
    expect(cards1.every((c) => c.reps === 0 && c.lapses === 0)).toBe(true);
    expect(cards1.every((c) => c.dueAt !== undefined && c.dueAt.length > 0)).toBe(true);

    // 重复读取（摘要 + 列表）不再创建卡。
    const summary2 = body(await learnerA.req("GET", "/api/v1/study/cards/summary", {})) as {
      cards: { total: number };
    };
    expect(summary2.cards.total).toBe(2);
    const cards2 = await listCards(learnerA);
    expect(cards2).toHaveLength(2);
    expect(cards2.map((c) => c.cardId).sort()).toEqual(cards1.map((c) => c.cardId).sort());

    // 数据库唯一约束兜底：同 (user, item, direction) 再插 → 23505。
    const pool = createPool({ ...config, max: 1 });
    try {
      const user = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
        learnerAUsername,
      ]);
      await expect(
        pool.query(
          `INSERT INTO learning_cards (user_id, course_id, course_item_id, direction)
           VALUES ($1, $2, $3, 'en_to_zh')`,
          [user.rows[0]?.id, courseId, itemIds[0]],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pool.end();
    }
  });

  it("不同用户数据隔离：B 的主课程卡不影响 A，A 只能看到自己的卡", async () => {
    const { courseId } = await createPublishedCourse({ title: "隔离课程" });
    await enrollPrimary(learnerA, courseId);

    // B 未报名/未设主 → 无主课程 404。
    const none = await learnerB.req("GET", "/api/v1/study/cards/summary", {});
    expect(none.statusCode).toBe(404);

    // B 报名并设主同一课程后，B 有自己的卡，且 A 的卡数量不变。
    await enrollPrimary(learnerB, courseId);
    const bSummary = body(await learnerB.req("GET", "/api/v1/study/cards/summary", {})) as {
      cards: { total: number };
    };
    expect(bSummary.cards.total).toBe(2);
    const aSummary = body(await learnerA.req("GET", "/api/v1/study/cards/summary", {})) as {
      cards: { total: number };
    };
    expect(aSummary.cards.total).toBe(2);

    const aCards = await listCards(learnerA);
    const bCards = await listCards(learnerB);
    expect(aCards.map((c) => c.cardId).sort()).not.toEqual(bCards.map((c) => c.cardId).sort());
    expect(aCards.every((c) => c.exposed === false)).toBe(true);

    // 数据库核对：A/B 各 2 张卡，互不重叠。
    const pool = createPool({ ...config, max: 1 });
    try {
      const users = await pool.query<{ id: string; username: string }>(
        "SELECT id, username FROM users WHERE username IN ($1, $2)",
        [learnerAUsername, learnerBUsername],
      );
      const byName = new Map(users.rows.map((r) => [r.username, r.id]));
      // 按课程作用域核对：A/B 在该课程各有自己的 2 张卡，且卡片集合互不重叠。
      const aCount = await pool.query(
        "SELECT count(*)::int AS n FROM learning_cards WHERE user_id = $1 AND course_id = $2",
        [byName.get(learnerAUsername), courseId],
      );
      const bCount = await pool.query(
        "SELECT count(*)::int AS n FROM learning_cards WHERE user_id = $1 AND course_id = $2",
        [byName.get(learnerBUsername), courseId],
      );
      expect(aCount.rows[0]?.n).toBe(2);
      expect(bCount.rows[0]?.n).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it("不同课程的相同词条使用不同 course_item_id，不共享学习卡", async () => {
    const entryId = await createEntry();
    const courseA = await createPublishedCourse({ title: "共享词条课程A", entryIds: [entryId] });
    const courseB = await createPublishedCourse({ title: "共享词条课程B", entryIds: [entryId] });
    expect(courseA.itemIds[0]).not.toBe(courseB.itemIds[0]);

    await enrollPrimary(learnerA, courseA.courseId);
    // 也加入课程 B（非主课程），才能按 B 查询学习卡状态。
    const enrollB = await learnerA.req(
      "POST",
      `/api/v1/catalog/courses/${courseB.courseId}/enroll`,
      {
        payload: { makePrimary: false },
      },
    );
    expect(enrollB.statusCode).toBe(200);
    const aCards = await listCards(learnerA); // 主课程 A
    const bCards = await listCards(learnerA, courseB.courseId);
    expect(aCards).toHaveLength(2);
    expect(bCards).toHaveLength(2);
    // 两张卡方向相同、拼写相同（同一词条），但课程词项身份不同。
    expect(aCards[0]?.englishSpelling).toBe(bCards[0]?.englishSpelling);
    expect(aCards.map((c) => c.courseItemId).sort()).not.toEqual(
      bCards.map((c) => c.courseItemId).sort(),
    );
    expect(new Set([...aCards, ...bCards].map((c) => c.cardId)).size).toBe(4);

    // 数据库核对：两门课程 release 引用同一词条，但 course_item_id 不同。
    const pool = createPool({ ...config, max: 1 });
    try {
      const rows = await pool.query<{ course_item_id: string; lexical_entry_id: string }>(
        `SELECT rci.course_item_id, rci.lexical_entry_id
         FROM released_course_items rci
         JOIN course_releases r ON r.id = rci.release_id
         JOIN courses c ON c.id = r.course_id AND c.current_release_id = r.id
         WHERE c.id IN ($1, $2)`,
        [courseA.courseId, courseB.courseId],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.lexical_entry_id).toBe(rows.rows[1]?.lexical_entry_id);
      expect(rows.rows[0]?.course_item_id).not.toBe(rows.rows[1]?.course_item_id);
    } finally {
      await pool.end();
    }
  });

  it("只允许 current release 内容；版本变更不破坏历史卡，移除词项不可再展示", async () => {
    const { courseId, itemIds, unitIds } = await createCourseOnePerUnit(2, "指针课程");
    const [itemX, itemY] = itemIds as [string, string];
    const unitY = unitIds[1]!; // 第二个单元承载词项 Y
    await enrollPrimary(learnerA, courseId);

    // 先按 v1 创建卡：两词项 × 两方向 = 4 张。
    const cardsV1 = await listCards(learnerA);
    expect(cardsV1).toHaveLength(4);
    expect(cardsV1.every((c) => c.courseItemId === itemX || c.courseItemId === itemY)).toBe(true);

    // v1 下两个词项都可展示。
    const x1 = await exposeItem(learnerA, itemX);
    expect(x1.statusCode).toBe(200);
    expect(x1.body?.alreadyExisted).toBe(false);
    const y1 = await exposeItem(learnerA, itemY);
    expect(y1.statusCode).toBe(200);

    // 删除词项 Y 所在单元（级联删除词项）并发布 v2 → current pointer 指向 v2。
    const draft = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const del = await admin.req(
      "DELETE",
      `/api/v1/admin/courses/${courseId}/draft/units/${unitY}`,
      { payload: { draftVersion: draft.version } },
    );
    expect(del.statusCode).toBe(200);
    const draft2 = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const repub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("lcv2") },
      payload: { draftVersion: draft2.version, releaseNote: "版本二" },
    });
    expect(repub.statusCode).toBe(201);

    // v2 是 current：Y 不在当前版本 → 再次展示 404。
    const y2 = await exposeItem(learnerA, itemY);
    expect(y2.statusCode).toBe(404);

    // 列表只显示 current release 词项 X 的两张卡；但数据库保留 Y 的历史卡。
    const cardsAfter = await listCards(learnerA);
    expect(cardsAfter).toHaveLength(2);
    expect(cardsAfter.every((c) => c.courseItemId === itemX)).toBe(true);

    const pool = createPool({ ...config, max: 1 });
    try {
      const total = await pool.query(
        "SELECT count(*)::int AS n FROM learning_cards WHERE user_id = (SELECT id FROM users WHERE username = $1) AND course_id = $2",
        [learnerAUsername, courseId],
      );
      expect(total.rows[0]?.n).toBe(4); // 历史卡保留
    } finally {
      await pool.end();
    }

    // 切回 v1：Y 再次成为 current release 内容，列表恢复 4 张卡，Y 的展示仍是首次事实。
    const history = body(
      await admin.req("GET", `/api/v1/admin/courses/${courseId}/releases`, {}),
    ) as { items: { id: string; releaseNumber: number }[] };
    const v1Id = history.items.find((r) => r.releaseNumber === 1)?.id as string;
    expect(v1Id).toBeTruthy();
    const move = await admin.req("PUT", `/api/v1/admin/courses/${courseId}/current-release`, {
      payload: { releaseId: v1Id },
    });
    expect(move.statusCode).toBe(200);

    const cardsBack = await listCards(learnerA);
    expect(cardsBack).toHaveLength(4);
    const yReplay = await exposeItem(learnerA, itemY);
    expect(yReplay.statusCode).toBe(200);
    expect(yReplay.body?.alreadyExisted).toBe(true);
    expect(yReplay.body?.exposureId).toBe(y1.body?.exposureId);
    expect(yReplay.body?.firstExposedAt).toBe(y1.body?.firstExposedAt);
  });

  it("草稿词项不可创建学习卡（同课程：已发布词项可展示，未发布草稿词项 404）", async () => {
    const { courseId, itemIds } = await createPublishedCourse({ title: "草稿隔离课程" });
    await enrollPrimary(learnerA, courseId);

    // 已发布词项可展示。
    const published = await exposeItem(learnerA, itemIds[0]!);
    expect(published.statusCode).toBe(200);

    // 向 active 草稿追加一个未发布词项 D。
    const draft = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
      units: { id: string }[];
    };
    const draftItemId = randomUUID();
    const draftEntryId = await createEntry();
    const add = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${draftItemId}`,
      {
        payload: {
          unitId: draft.units[0]?.id,
          lexicalEntryId: draftEntryId,
          meaning: "坚持",
          draftVersion: draft.version,
        },
      },
    );
    expect(add.statusCode).toBe(201);

    // 草稿词项（不在 current release）不可创建卡/展示。
    const denied = await exposeItem(learnerA, draftItemId);
    expect(denied.statusCode).toBe(404);

    // 数据库确认草稿词项没有产生学习卡。
    const pool = createPool({ ...config, max: 1 });
    try {
      const cards = await pool.query(
        "SELECT count(*)::int AS n FROM learning_cards WHERE course_item_id = $1",
        [draftItemId],
      );
      expect(cards.rows[0]?.n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("无 current release 的课程不可创建学习卡", async () => {
    // 只创建草稿，不发布。
    const slug = uniq("lcunpublished");
    const created = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "未发布课程", level: "a1", description: "" },
    });
    expect(created.statusCode).toBe(201);
    const draftCourseId = (body(created) as { courseId?: string }).courseId as string;

    // 学习者目录不可见、报名 404 → 无法成为任何人的卡来源。
    const enroll = await learnerA.req("POST", `/api/v1/catalog/courses/${draftCourseId}/enroll`, {
      payload: { makePrimary: true },
    });
    expect(enroll.statusCode).toBe(404);

    const pool = createPool({ ...config, max: 1 });
    try {
      const cards = await pool.query(
        "SELECT count(*)::int AS n FROM learning_cards WHERE course_id = $1",
        [draftCourseId],
      );
      expect(cards.rows[0]?.n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("P1 修复：同一单元含多个词项时发布快照复制全部词项（released_course_items 数量正确）", async () => {
    // 复现原缺陷：同单元 2 个词项，旧 doPublishRelease 逐行 INSERT released_units，
    // 第二行命中 ON CONFLICT DO NOTHING 无 RETURNING，导致第二个词项未复制到 released_course_items。
    const { courseId, itemIds, unitId } = await createPublishedCourse({
      title: "同单元多词项课程",
      itemCount: 2,
    });
    const [itemA, itemB] = itemIds as [string, string];

    // 发布后：该单元 2 个词项必须全部复制进 released_course_items。
    const pool = createPool({ ...config, max: 1 });
    try {
      const releaseId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM course_releases WHERE course_id = $1 AND release_number = 1`,
          [courseId],
        )
      ).rows[0]?.id as string;

      const released = await pool.query<{
        course_item_id: string;
        english_spelling: string;
        meaning: string;
        position: number;
      }>(
        `SELECT rci.course_item_id, rci.english_spelling, rci.meaning, rci.position
         FROM released_course_items rci
         WHERE rci.release_id = $1
           AND rci.released_unit_id IN
               (SELECT id FROM released_units WHERE release_id = $1 AND unit_id = $2)
         ORDER BY rci.position ASC`,
        [releaseId, unitId],
      );
      expect(released.rows).toHaveLength(2);

      const ids = released.rows.map((r) => r.course_item_id);
      expect(ids).toContain(itemA);
      expect(ids).toContain(itemB);

      const byId = new Map(released.rows.map((r) => [r.course_item_id, r]));
      for (const itemId of [itemA, itemB]) {
        const row = byId.get(itemId);
        expect(row).toBeTruthy();
        expect(row!.english_spelling.length).toBeGreaterThan(0);
        expect(row!.meaning.length).toBeGreaterThan(0);
        expect(row!.position).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await pool.end();
    }

    // 学习面：两词项都能成为学习卡（双向 = 4 张），确认无词项被发布复制遗漏。
    await enrollPrimary(learnerA, courseId);
    const cards = await listCards(learnerA);
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.courseItemId === itemA || c.courseItemId === itemB)).toBe(true);
  });

  it("学习展示首次写入、重复幂等且不可变；不改变学习卡 FSRS 状态", async () => {
    const { courseId, itemIds, entryIds } = await createPublishedCourse({ title: "展示课程" });
    await enrollPrimary(learnerA, courseId);

    // 首次展示。
    const first = await exposeItem(learnerA, itemIds[0]!);
    expect(first.statusCode).toBe(200);
    expect(first.body?.alreadyExisted).toBe(false);
    expect(first.body?.courseItemId).toBe(itemIds[0]);
    expect(first.body?.lexicalEntryId).toBe(entryIds[0]);
    expect(first.body?.courseId).toBe(courseId);

    // 重复展示幂等：同一 exposureId 与 firstExposedAt。
    const replay = await exposeItem(learnerA, itemIds[0]!);
    expect(replay.statusCode).toBe(200);
    expect(replay.body?.alreadyExisted).toBe(true);
    expect(replay.body?.exposureId).toBe(first.body?.exposureId);
    expect(replay.body?.firstExposedAt).toBe(first.body?.firstExposedAt);

    // 展示事实不可变：UPDATE/DELETE 被触发器拒绝。
    const pool = createPool({ ...config, max: 1 });
    try {
      const row = await pool.query<{ id: string }>(
        "SELECT id FROM learning_exposures WHERE course_item_id = $1",
        [itemIds[0]],
      );
      const exposureId = row.rows[0]?.id as string;
      await expect(
        pool.query("UPDATE learning_exposures SET request_id = 'x' WHERE id = $1", [exposureId]),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query("DELETE FROM learning_exposures WHERE id = $1", [exposureId]),
      ).rejects.toThrow(/immutable/);

      // 展示不改变 FSRS 状态：展示前后卡状态完全一致。
      const before = await pool.query(
        `SELECT state, stability, difficulty, scheduled_days, elapsed_days, reps, lapses, due_at
         FROM learning_cards WHERE course_item_id = $1 AND direction = 'en_to_zh'`,
        [itemIds[0]],
      );
      await exposeItem(learnerA, itemIds[0]!);
      const after = await pool.query(
        `SELECT state, stability, difficulty, scheduled_days, elapsed_days, reps, lapses, due_at
         FROM learning_cards WHERE course_item_id = $1 AND direction = 'en_to_zh'`,
        [itemIds[0]],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);

      // 展示行数仍为 1。
      const count = await pool.query(
        "SELECT count(*)::int AS n FROM learning_exposures WHERE course_item_id = $1",
        [itemIds[0]],
      );
      expect(count.rows[0]?.n).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("学习展示 / 学习卡不产生 review_events、XP 或排行榜等学习业务数据", async () => {
    const pool = createPool({ ...config, max: 1 });
    try {
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename IN (
             'review_events','card_reviews','memory_states','fsrs_states',
             'xp_entries','xp_ledger','daily_plans','study_sessions','study_session_items',
             'game_rule_sets','badges','user_levels','streak_days','streak_protections',
             'quest_instances','quest_progress_events','challenge_weeks','quiz_attempts',
             'quiz_question_snapshots','quiz_responses','challenge_score_events',
             'challenge_score_adjustments','weekly_challenge_rewards','weekly_challenge_boards'
           )`,
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await pool.end();
    }

    // 领域纯函数形状可调用（domain 门禁）。
    const initial = buildInitialCardState({
      userId: "u1",
      courseId: "c1",
      courseItemId: "i1",
      direction: "en_to_zh",
    });
    expect(initial.state).toBe("new");
    expect(buildExposureState(null)).toEqual({ exposed: false, firstExposedAt: null });
  });

  it("P1 修复：学习卡摘要只统计当前 current release 词项（移除词项的历史卡不计数）", async () => {
    // 发布含两个词项（每单元一个）的版本并创建卡：两词项 × 双方向 = 4 张。
    const { courseId, itemIds, unitIds } = await createCourseOnePerUnit(2, "摘要课程");
    const [itemX, itemY] = itemIds as [string, string];
    const unitY = unitIds[1]!;
    await enrollPrimary(learnerA, courseId);

    // 先触发 ensureCourseCards：summary + list 都幂等补齐卡。
    const summaryV1 = await getSummary(learnerA);
    expect(summaryV1.itemCount).toBe(2);
    expect(summaryV1.cards.total).toBe(4);
    expect(summaryV1.cards.enToZh).toBe(2);
    expect(summaryV1.cards.zhToEn).toBe(2);
    expect(summaryV1.cards.new).toBe(4);

    // V1 下 X、Y 都先记录学习展示。
    const expX = await exposeItem(learnerA, itemX);
    expect(expX.statusCode).toBe(200);
    const expY = await exposeItem(learnerA, itemY);
    expect(expY.statusCode).toBe(200);
    const summaryV1Exp = await getSummary(learnerA);
    expect(summaryV1Exp.exposedItemCount).toBe(2);

    // 发布新版本，删除承载词项 Y 的单元（级联删除 Y）。
    const draft = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const del = await admin.req(
      "DELETE",
      `/api/v1/admin/courses/${courseId}/draft/units/${unitY}`,
      { payload: { draftVersion: draft.version } },
    );
    expect(del.statusCode).toBe(200);
    const draft2 = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const repub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("lcsumv2") },
      payload: { draftVersion: draft2.version, releaseNote: "版本二" },
    });
    expect(repub.statusCode).toBe(201);
    const v2Id = (body(repub) as { releaseId?: string }).releaseId;
    expect(v2Id).toBeTruthy();
    expect((body(repub) as { releaseNumber?: number }).releaseNumber).toBe(2);

    // V2 是 current release：摘要只统计当前版本中仍存在的词项 X（双向 2 张）。
    const summaryV2 = await getSummary(learnerA);
    expect(summaryV2.itemCount).toBe(1);
    expect(summaryV2.cards.total).toBe(2);
    expect(summaryV2.cards.enToZh).toBe(1);
    expect(summaryV2.cards.zhToEn).toBe(1);
    // exposedItemCount 与 cards 同一边界：Y 已从当前版本移除 → 不计数，且不大于 itemCount。
    expect(summaryV2.exposedItemCount).toBe(1);
    expect(summaryV2.exposedItemCount).toBeLessThanOrEqual(summaryV2.itemCount);

    // 历史卡与历史展示记录都保留：Y 的卡、Y 的展示行未删除。
    const pool = createPool({ ...config, max: 1 });
    try {
      const rows = await pool.query<{ course_item_id: string }>(
        `SELECT DISTINCT course_item_id FROM learning_cards
         WHERE course_id = $1 AND user_id = (SELECT id FROM users WHERE username = $2)`,
        [courseId, learnerAUsername],
      );
      const ids = rows.rows.map((r) => r.course_item_id);
      expect(ids).toContain(itemX);
      expect(ids).toContain(itemY); // 历史卡保留

      const expRows = await pool.query<{ course_item_id: string }>(
        `SELECT course_item_id FROM learning_exposures
         WHERE course_id = $1 AND user_id = (SELECT id FROM users WHERE username = $2)`,
        [courseId, learnerAUsername],
      );
      const expIds = expRows.rows.map((r) => r.course_item_id);
      expect(expIds).toContain(itemX);
      expect(expIds).toContain(itemY); // 历史展示保留
    } finally {
      await pool.end();
    }
  });

  it("P1 修复：展示幂等重放返回首次展示冻结的 releaseId / lexicalEntryId", async () => {
    // 单个词项课程：发布 v1，首展，再发布保留同一 stable course_item_id 的 v2 并切为 current。
    const { courseId, itemIds, entryIds } = await createPublishedCourse({ title: "冻结事实课程" });
    const itemA = itemIds[0]!;
    const entryA = entryIds[0]!;
    await enrollPrimary(learnerA, courseId);

    // 首次展示 → 记录首次版本的 releaseId 与词条。
    const first = await exposeItem(learnerA, itemA);
    expect(first.statusCode).toBe(200);
    expect(first.body?.alreadyExisted).toBe(false);
    const firstReleaseId = first.body?.releaseId;
    const firstLexicalEntryId = first.body?.lexicalEntryId;
    expect(firstReleaseId).toBeTruthy();
    expect(firstLexicalEntryId).toBe(entryA);

    // 修改释义并发布 v2 → current pointer 切到 v2（同一 stable course_item_id 保留）。
    const draft = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const patch = await admin.req(
      "PATCH",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemA}`,
      { payload: { meaning: "坚持（修订）", draftVersion: draft.version } },
    );
    expect(patch.statusCode).toBe(200);
    const draft2 = body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
      version: number;
    };
    const repub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("lcfreeze") },
      payload: { draftVersion: draft2.version, releaseNote: "版本二" },
    });
    expect(repub.statusCode).toBe(201);
    const v2ReleaseId = (body(repub) as { releaseId?: string }).releaseId;
    expect(v2ReleaseId).toBeTruthy();
    expect(v2ReleaseId).not.toBe(firstReleaseId); // 当前版本已改变

    // v2 词项仍可展示（同一 stable course_item_id 属于 current release）。
    const v2Expose = await exposeItem(learnerA, itemA);
    expect(v2Expose.statusCode).toBe(200);

    // 重放：返回首次冻结的事实。
    const replay = await exposeItem(learnerA, itemA);
    expect(replay.statusCode).toBe(200);
    expect(replay.body?.alreadyExisted).toBe(true);
    // releaseId 必须是首次展示时的 releaseId，不能是当前 v2。
    expect(replay.body?.releaseId).toBe(firstReleaseId);
    expect(replay.body?.lexicalEntryId).toBe(entryA); // 首次词条
    expect(replay.body?.firstExposedAt).toBe(first.body?.firstExposedAt);
    expect(replay.body?.courseItemId).toBe(itemA);
    expect(replay.body?.courseId).toBe(courseId);

    // 数据库仍只有一行展示。
    const pool = createPool({ ...config, max: 1 });
    try {
      const rows = await pool.query<{ release_id: string; lexical_entry_id: string }>(
        `SELECT release_id, lexical_entry_id FROM learning_exposures
         WHERE user_id = (SELECT id FROM users WHERE username = $1) AND course_item_id = $2`,
        [learnerAUsername, itemA],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.release_id).toBe(firstReleaseId);
      expect(rows.rows[0]?.lexical_entry_id).toBe(entryA);
    } finally {
      await pool.end();
    }
  });

  it("learner/admin 权限边界：learner 无法访问管理接口；admin 经学习接口只看到自己的数据；未登录 401", async () => {
    // learner 访问管理接口 → 403。
    const denied = await learnerA.req("GET", "/api/v1/admin/courses", {});
    expect(denied.statusCode).toBe(403);
    const deniedDraft = await learnerA.req(
      "GET",
      `/api/v1/admin/courses/${randomUUID()}/draft`,
      {},
    );
    expect(deniedDraft.statusCode).toBe(403);

    // 管理员经学习接口只能访问自己的 learner 数据（admin 无主课程 → 404，绝不返回他人数据）。
    const adminSummary = await admin.req("GET", "/api/v1/study/cards/summary", {});
    expect(adminSummary.statusCode).toBe(404);

    // 未登录访问 /study/*（安全方法）→ 401；不安全方法在未带 CSRF 时先被 403 拒绝。
    const anon = await app.inject({
      method: "GET",
      url: "/api/v1/study/cards/summary",
    });
    expect(anon.statusCode).toBe(401);
    const anonWrite = await app.inject({
      method: "POST",
      url: "/api/v1/study/exposures",
      payload: { courseItemId: randomUUID() },
    });
    expect(anonWrite.statusCode).toBe(403); // CSRF 双提交校验先于会话守卫
  });
});
