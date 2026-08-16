// 阶段 4 出口集成验收：真实 PostgreSQL + API + domain + OpenAPI。
// 覆盖：0001–0009 空库顺序迁移（一次性隔离数据库）、OpenAPI/domain 门禁、
// release 不可变、current pointer 不改快照、草稿修改不影响已发布内容、
// 每用户至多一个 active primary、learner 无法访问草稿/管理接口、无学习业务数据表。
//
// 与既有集成测试不同：本文件【不】静默跳过——数据库不可用时明确失败（throw），
// 满足“数据库测试不能静默跳过；数据库不可用时必须明确失败”。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, listAppliedMigrations, loadDbConfigFromEnv, migrate } from "@motro/db";
import { buildCatalogDetail, buildCatalogSummary, buildEnrollmentState } from "@motro/domain";
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
  itemId: string;
  entryId: string;
  releaseNumber: number;
}

describe("phase 4 closeout", () => {
  let app: App;
  let admin: Client;
  let learner: Client;
  let adminUsername: string;
  let learnerUsername: string;

  beforeAll(async () => {
    if (!dbAvailable) {
      // 数据库测试不得静默跳过：连接不可用即明确失败。
      throw new Error(
        "phase4-closeout 需要运行中的 PostgreSQL（compose 的 db 服务）。" +
          "请启动数据库后重跑；本套件不会静默跳过。",
      );
    }

    const suffix = randomBytes(3).toString("hex");
    adminUsername = `p4-admin-${suffix}`;
    learnerUsername = `p4-learner-${suffix}`;

    // 开发数据库已迁移则 no-op；未迁移则补齐，保证 API 测试依赖的表存在。
    await migrate(config, MIGRATIONS_DIR);

    const seedPool = createPool({ ...config, max: 1 });
    const ps = new PasswordService();
    const adminHash = await ps.hashPassword("p4-admin-pass-123");
    await seedPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'P4 ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, must_change_password = false, status = 'active'`,
      [adminUsername, adminHash],
    );
    const learnerHash = await ps.hashPassword("p4-learner-pass-123");
    await seedPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'P4 ITest Learner', 'learner', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, must_change_password = false, status = 'active'`,
      [learnerUsername, learnerHash],
    );
    await seedPool.end();

    app = await createApp();
    await app.init();
    admin = makeClient(app);
    const alogin = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: adminUsername, password: "p4-admin-pass-123" },
    });
    expect(alogin.statusCode).toBe(200);

    learner = makeClient(app);
    const llogin = await learner.req("POST", "/api/v1/auth/login", {
      payload: { username: learnerUsername, password: "p4-learner-pass-123" },
    });
    expect(llogin.statusCode).toBe(200);
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

  /** 管理员创建词条 + 课程 + 两个单元 + 每单元一个词项并发布。 */
  async function createPublishedCourse(title?: string): Promise<PublishedCourse> {
    const entryRes = await admin.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: uniq("p4word"), confirmDuplicate: false },
    });
    expect(entryRes.statusCode).toBe(201);
    const entryId = (body(entryRes) as { id?: string }).id as string;

    const slug = uniq("p4course");
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: title ?? "阶段四课程", level: "a1", description: "课程描述" },
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

    const itemId = randomUUID();
    const i = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
      payload: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
    });
    expect(i.statusCode).toBe(201);
    version = (body(i) as { version?: number }).version ?? version;

    const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("p4pub") },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect(pub.statusCode).toBe(201);
    return {
      courseId,
      draftVersion: version,
      unitId,
      itemId,
      entryId,
      releaseNumber: (body(pub) as { releaseNumber?: number }).releaseNumber ?? 1,
    };
  }

  it("0001–0013 migration 从空库顺序应用（一次性隔离数据库），产生全部表、唯一主课程索引与学习卡约束", async () => {
    const dbName = `motro_p4_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }

    const isoConfig = { ...config, database: dbName };
    const applied = await migrate(isoConfig, MIGRATIONS_DIR);
    expect(applied.map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27, 28, 29, 30, 31, 32, 33, 34, 35,
    ]);

    const verify = createPool({ ...isoConfig, max: 1 });
    try {
      const recorded = await listAppliedMigrations(isoConfig);
      expect(recorded.map((m) => m.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
      ]);

      const tables = await verify.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename IN ('users','auth_sessions','audit_events','lexical_entries',
             'courses','course_drafts','draft_units','draft_course_items',
             'course_releases','released_units','released_course_items','course_enrollments',
             'learning_cards','learning_exposures','study_sessions','study_session_items',
             'review_events')`,
      );
      expect(tables.rows.map((r) => r.tablename).sort()).toEqual(
        [
          "users",
          "auth_sessions",
          "audit_events",
          "lexical_entries",
          "courses",
          "course_drafts",
          "draft_units",
          "draft_course_items",
          "course_releases",
          "released_units",
          "released_course_items",
          "course_enrollments",
          "learning_cards",
          "learning_exposures",
          "review_events",
          "study_session_items",
          "study_sessions",
        ].sort(),
      );

      // 唯一主课程防线：partial unique index 存在且拒绝第二个 active primary。
      const idx = await verify.query(
        `SELECT 1 FROM pg_indexes
         WHERE tablename = 'course_enrollments'
           AND indexname = 'course_enrollments_one_active_primary_per_user'`,
      );
      expect(idx.rowCount).toBe(1);

      // 0011：learning_cards 新增调度参数版本列（NOT NULL，固定默认回填既有行）。
      const schedulerParamsCol = await verify.query(
        `SELECT is_nullable
         FROM information_schema.columns
         WHERE table_name = 'learning_cards' AND column_name = 'scheduler_parameters_version'`,
      );
      expect(schedulerParamsCol.rowCount).toBe(1);
      expect(schedulerParamsCol.rows[0]?.is_nullable).toBe("NO");

      // 0013：study_sessions 复合外键 (course_id, release_id) → course_releases(course_id, id)，
      // 拒绝跨课程 release 快照。
      const compositeFk = await verify.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'study_sessions_course_release_fk'`,
      );
      expect(compositeFk.rows[0]?.def).toBe(
        "FOREIGN KEY (course_id, release_id) REFERENCES course_releases(course_id, id)",
      );
    } finally {
      await verify.end();
    }

    // 清理：断开隔离库连接后删除，不触碰开发数据库。
    const dropPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await dropPool.query(`DROP DATABASE "${dbName}"`);
    } finally {
      await dropPool.end();
    }
  });

  it("OpenAPI 门禁：产物包含阶段 4 全部契约（admin 内容、目录、报名、主课程）", () => {
    const doc = JSON.parse(readFileSync(OPENAPI_FILE, "utf8")) as {
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    const paths = doc.paths;
    for (const p of [
      "/api/v1/admin/lexical-entries",
      "/api/v1/admin/courses",
      "/api/v1/admin/courses/{id}/draft",
      "/api/v1/admin/courses/{id}/draft/units/{unitId}",
      "/api/v1/admin/courses/{id}/draft/items/{itemId}",
      "/api/v1/admin/courses/{id}/validate",
      "/api/v1/admin/courses/{id}/releases",
      "/api/v1/admin/courses/{id}/current-release",
      "/api/v1/catalog/courses",
      "/api/v1/catalog/courses/{id}",
      "/api/v1/catalog/courses/{id}/enroll",
      "/api/v1/catalog/primary-course",
    ]) {
      expect(paths[p], `OpenAPI 缺少路径 ${p}`).toBeTruthy();
    }
    const raw = JSON.stringify(doc);
    expect(raw).toContain("isEnrolled");
    expect(raw).toContain("isPrimary");
    expect(raw).toContain("releaseNumber");
    expect(raw).toContain("currentReleaseId");
  });

  it("domain 门禁：目录/详情/报名状态纯函数可调用且形状正确", () => {
    const summary = buildCatalogSummary({
      courseId: "c1",
      title: "课程",
      level: "a1",
      description: "",
      releaseId: "r1",
      releaseNumber: 2,
      enrollment: { isEnrolled: true, isPrimary: true },
    });
    expect(summary.isEnrolled).toBe(true);
    expect(summary.isPrimary).toBe(true);
    expect(summary.contentSource).toBe("published_release");
    expect(summary.progressStatus).toBe("not_started");

    const detail = buildCatalogDetail(
      {
        courseId: "c1",
        title: "课程",
        level: "a1",
        description: "",
        releaseId: "r1",
        releaseNumber: 2,
      },
      [
        { unitId: "u2", position: 2, title: "单元二", description: "" },
        { unitId: "u1", position: 1, title: "单元一", description: "" },
      ],
    );
    expect(detail.units.map((u) => u.position)).toEqual([1, 2]);

    // 软停用报名 → 未报名。
    expect(buildEnrollmentState({ active: false, is_primary: true })).toEqual({
      isEnrolled: false,
      isPrimary: false,
    });
    expect(buildEnrollmentState({ active: true, is_primary: false })).toEqual({
      isEnrolled: true,
      isPrimary: false,
    });
  });

  it("release rows 禁止 UPDATE/DELETE（快照不可变）", async () => {
    const { courseId, draftVersion } = await createPublishedCourse("不可变课程");
    const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("p4imm") },
      payload: { draftVersion, releaseNote: "不可变" },
    });
    const releaseId = (body(pub) as { releaseId?: string }).releaseId as string;

    const pool = createPool({ ...config, max: 1 });
    try {
      await expect(
        pool.query("UPDATE course_releases SET title = '篡改' WHERE id = $1", [releaseId]),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query("DELETE FROM course_releases WHERE id = $1", [releaseId]),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query("UPDATE released_units SET title = '篡改' WHERE release_id = $1", [releaseId]),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query("UPDATE released_course_items SET meaning = '篡改' WHERE release_id = $1", [
          releaseId,
        ]),
      ).rejects.toThrow(/immutable/);
    } finally {
      await pool.end();
    }
  });

  it("current pointer 切换不改快照：切回版本 1 后两版内容与行数不变", async () => {
    // createPublishedCourse 已发布版本 1（标题“指针课程”）。
    const { courseId } = await createPublishedCourse("指针课程");
    const history1 = body(
      await admin.req("GET", `/api/v1/admin/courses/${courseId}/releases`, {}),
    ) as { items: { id: string; releaseNumber: number; title: string }[] };
    const v1Id = history1.items.find((r) => r.releaseNumber === 1)?.id as string;
    expect(v1Id).toBeTruthy();

    // 修改草稿标题并发布版本 2。
    const draft1 = (
      body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
        version: number;
      }
    ).version;
    await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
      payload: { title: "指针课程 v2", draftVersion: draft1 },
    });
    const draft2 = (
      body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
        version: number;
      }
    ).version;
    const v2 = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("p4p2") },
      payload: { draftVersion: draft2, releaseNote: "版本二" },
    });
    const v2Id = (body(v2) as { releaseId?: string }).releaseId as string;
    expect(v2Id).not.toBe(v1Id);

    const pool = createPool({ ...config, max: 1 });
    try {
      const snap1Before = await pool.query<{ title: string }>(
        "SELECT title FROM course_releases WHERE id = $1",
        [v1Id],
      );
      const snap2Before = await pool.query<{ title: string }>(
        "SELECT title FROM course_releases WHERE id = $1",
        [v2Id],
      );
      expect(snap1Before.rows[0]?.title).toBe("指针课程");
      expect(snap2Before.rows[0]?.title).toBe("指针课程 v2");

      // 切回版本 1。
      const move = await admin.req("PUT", `/api/v1/admin/courses/${courseId}/current-release`, {
        payload: { releaseId: v1Id },
      });
      expect(move.statusCode).toBe(200);
      const course = await pool.query<{ current_release_id: string | null }>(
        "SELECT current_release_id FROM courses WHERE id = $1",
        [courseId],
      );
      expect(course.rows[0]?.current_release_id).toBe(v1Id);

      // 快照未被改写。
      const snap1After = await pool.query<{ title: string }>(
        "SELECT title FROM course_releases WHERE id = $1",
        [v1Id],
      );
      const snap2After = await pool.query<{ title: string }>(
        "SELECT title FROM course_releases WHERE id = $1",
        [v2Id],
      );
      expect(snap1After.rows[0]?.title).toBe(snap1Before.rows[0]?.title);
      expect(snap2After.rows[0]?.title).toBe(snap2Before.rows[0]?.title);

      // 行数仍为 2。
      const count = await pool.query("SELECT 1 FROM course_releases WHERE course_id = $1", [
        courseId,
      ]);
      expect(count.rowCount).toBe(2);
    } finally {
      await pool.end();
    }

    // 切回版本 2，让后续测试看到的是最新内容。
    await admin.req("PUT", `/api/v1/admin/courses/${courseId}/current-release`, {
      payload: { releaseId: v2Id },
    });
  });

  it("草稿修改不影响已发布内容；重新发布为版本 2", async () => {
    const { courseId, itemId, releaseNumber } = await createPublishedCourse("草稿隔离课程");
    expect(releaseNumber).toBe(1);

    // 修改词项释义 → 草稿版本递增。
    const draft1 = (
      body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
        version: number;
      }
    ).version;
    const patch = await admin.req(
      "PATCH",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      {
        payload: { meaning: "坚持", draftVersion: draft1 },
      },
    );
    expect(patch.statusCode).toBe(200);

    const pool = createPool({ ...config, max: 1 });
    try {
      // 已发布快照仍是旧释义。
      const released = await pool.query<{ meaning: string }>(
        `SELECT meaning FROM released_course_items
         WHERE release_id = (SELECT id FROM course_releases WHERE course_id = $1 AND release_number = 1)
           AND course_item_id = $2`,
        [courseId, itemId],
      );
      expect(released.rows[0]?.meaning).toBe("放弃");
    } finally {
      await pool.end();
    }

    // 重新发布 → 版本 2，内容为修改后释义。
    const draft2 = (
      body(await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {})) as {
        version: number;
      }
    ).version;
    const repub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": uniq("p4v2") },
      payload: { draftVersion: draft2, releaseNote: "版本二" },
    });
    expect(repub.statusCode).toBe(201);
    expect((body(repub) as { releaseNumber?: number }).releaseNumber).toBe(2);
  });

  it("每用户最多一个 active primary enrollment：partial unique index 拒绝第二个", async () => {
    const a = await createPublishedCourse("索引课程A");
    const b = await createPublishedCourse("索引课程B");
    const pool = createPool({ ...config, max: 1 });
    try {
      const user = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
        learnerUsername,
      ]);
      const userId = user.rows[0]?.id as string;
      await pool.query(`DELETE FROM course_enrollments WHERE user_id = $1`, [userId]);
      await pool.query(
        `INSERT INTO course_enrollments (user_id, course_id, active, is_primary)
         VALUES ($1, $2, true, true)`,
        [userId, a.courseId],
      );
      await expect(
        pool.query(
          `INSERT INTO course_enrollments (user_id, course_id, active, is_primary)
           VALUES ($1, $2, true, true)`,
          [userId, b.courseId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pool.end();
    }
  });

  it("并发主课程切换最终恰好一个 primary；重复报名幂等", async () => {
    const courses: { courseId: string }[] = [];
    for (let n = 0; n < 3; n++) {
      courses.push(await createPublishedCourse(`并发课程 ${n}`));
    }

    const results = await Promise.all(
      courses.map((c) =>
        learner.req("PUT", "/api/v1/catalog/primary-course", {
          payload: { courseId: c.courseId },
        }),
      ),
    );
    // 未报名课程设主 → 409；先报名再并发切换。
    expect(results.every((r) => r.statusCode === 409)).toBe(true);

    await Promise.all(
      courses.map((c) =>
        learner.req("POST", `/api/v1/catalog/courses/${c.courseId}/enroll`, {
          payload: { makePrimary: true },
        }),
      ),
    );

    const switches = await Promise.all(
      courses.map((c) =>
        learner.req("PUT", "/api/v1/catalog/primary-course", {
          payload: { courseId: c.courseId },
        }),
      ),
    );
    expect(switches.every((r) => r.statusCode === 200)).toBe(true);

    // 主课程的“恰好一个 primary”不变量由下方 DB 断言权威证明（针对本学习者报名表）；
    // API 列表因分页首屏可能不包含该课程（共享库已累积海量数据），故不再用列表推断，
    // 只确认列表响应仍带分页字段。
    const firstList = await learner.req("GET", "/api/v1/catalog/courses", {});
    const firstData = body(firstList) as { items: unknown[]; hasMore: boolean | undefined };
    expect(Array.isArray(firstData.items)).toBe(true);

    const pool = createPool({ ...config, max: 1 });
    try {
      const user = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
        learnerUsername,
      ]);
      const count = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM course_enrollments
         WHERE user_id = $1 AND active = true AND is_primary = true`,
        [user.rows[0]?.id],
      );
      expect(Number(count.rows[0]?.n ?? 0)).toBe(1);

      // 重复报名幂等：同一课程再次报名不新增行。
      const rowsBefore = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM course_enrollments WHERE user_id = $1",
        [user.rows[0]?.id],
      );
      await learner.req("POST", `/api/v1/catalog/courses/${courses[0]?.courseId}/enroll`, {
        payload: { makePrimary: false },
      });
      const rowsAfter = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM course_enrollments WHERE user_id = $1",
        [user.rows[0]?.id],
      );
      expect(rowsAfter.rows[0]?.n).toBe(rowsBefore.rows[0]?.n);
    } finally {
      await pool.end();
    }
  });

  it("learner 无法访问草稿/管理接口；学习者目录只含已发布课程", async () => {
    // 有草稿但未发布（无 current release）→ 学习者目录不可见、报名 404。
    const slug = uniq("p4unpublished");
    const created = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "未发布课程" },
    });
    const draftCourseId = (body(created) as { courseId?: string }).courseId as string;

    const list = await learner.req("GET", "/api/v1/catalog/courses", {});
    const items = (body(list) as { items: { courseId: string }[] }).items;
    expect(items.some((c) => c.courseId === draftCourseId)).toBe(false);
    const hidden = await learner.req("POST", `/api/v1/catalog/courses/${draftCourseId}/enroll`, {
      payload: { makePrimary: false },
    });
    expect(hidden.statusCode).toBe(404);

    // learner 调用管理接口 → 403。
    const denied = await learner.req("GET", `/api/v1/admin/courses/${draftCourseId}/draft`, {});
    expect(denied.statusCode).toBe(403);
    const deniedCreate = await learner.req("POST", "/api/v1/admin/courses", {
      payload: { slug: uniq("p4deny"), title: "越权课程" },
    });
    expect(deniedCreate.statusCode).toBe(403);
    const deniedEntry = await learner.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: uniq("p4denyword"), confirmDuplicate: false },
    });
    expect(deniedEntry.statusCode).toBe(403);
  });

  it("P1 修复：同一单元多个词项发布复制全部词项；草稿修改后快照不变；历史/幂等仍通过", async () => {
    // 旧 doPublishRelease 在同一单元多词项时只复制第一个词项到 released_course_items（P1 缺陷）。
    // 手工构造「1 单元 2 词项」并发布，验证全部词项进入快照。
    const entryA = await admin.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: uniq("p1worda"), confirmDuplicate: false },
    });
    expect(entryA.statusCode).toBe(201);
    const entryAId = (body(entryA) as { id?: string }).id as string;
    const entryB = await admin.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: uniq("p1wordb"), confirmDuplicate: false },
    });
    expect(entryB.statusCode).toBe(201);
    const entryBId = (body(entryB) as { id?: string }).id as string;

    const slug = uniq("p1course");
    const created = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "同单元多词项课程", level: "a1", description: "" },
    });
    expect(created.statusCode).toBe(201);
    const courseId = (body(created) as { courseId?: string }).courseId as string;
    let version = (body(created) as { draftVersion?: number }).draftVersion ?? 1;

    const unitId = randomUUID();
    const u = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
      payload: { title: "单单元", description: "", draftVersion: version },
    });
    expect(u.statusCode).toBe(201);
    version = (body(u) as { version?: number }).version ?? version;

    const itemA = randomUUID();
    const ia = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${itemA}`, {
      payload: { unitId, lexicalEntryId: entryAId, meaning: "放弃", draftVersion: version },
    });
    expect(ia.statusCode).toBe(201);
    version = (body(ia) as { version?: number }).version ?? version;
    const itemB = randomUUID();
    const ib = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${itemB}`, {
      payload: { unitId, lexicalEntryId: entryBId, meaning: "坚持", draftVersion: version },
    });
    expect(ib.statusCode).toBe(201);
    version = (body(ib) as { version?: number }).version ?? version;

    const pubKey = uniq("p1pub");
    const pub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": pubKey },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect(pub.statusCode).toBe(201);

    // 版本历史与幂等重试继续通过。
    const history = body(
      await admin.req("GET", `/api/v1/admin/courses/${courseId}/releases`, {}),
    ) as { items: { id: string; releaseNumber: number }[] };
    expect(history.items).toHaveLength(1);
    expect(history.items[0]?.releaseNumber).toBe(1);
    const replayPub = await admin.req("POST", `/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "idempotency-key": pubKey },
      payload: { draftVersion: version, releaseNote: "发布" },
    });
    expect([200, 201]).toContain(replayPub.statusCode);
    expect((body(replayPub) as { releaseId?: string }).releaseId).toBe(history.items[0]?.id);

    const pool = createPool({ ...config, max: 1 });
    try {
      // 快照必须包含两个词项，且稳定 course_item_id、英文、中文释义、顺序都存在。
      const released = await pool.query<{
        course_item_id: string;
        english_spelling: string;
        meaning: string;
        position: number;
      }>(
        `SELECT rci.course_item_id, rci.english_spelling, rci.meaning, rci.position
         FROM released_course_items rci
         WHERE rci.release_id = $1
         ORDER BY rci.position ASC, rci.course_item_id ASC`,
        [history.items[0]?.id],
      );
      expect(released.rows).toHaveLength(2);
      const byId = new Map(released.rows.map((r) => [r.course_item_id, r]));
      const rowA = byId.get(itemA);
      const rowB = byId.get(itemB);
      expect(rowA).toBeTruthy();
      expect(rowB).toBeTruthy();
      expect(rowA!.english_spelling.length).toBeGreaterThan(0);
      expect(rowB!.english_spelling.length).toBeGreaterThan(0);
      expect(rowA!.meaning).toBe("放弃");
      expect(rowB!.meaning).toBe("坚持");
      expect(rowA!.position).toBeGreaterThanOrEqual(1);
      expect(rowB!.position).toBeGreaterThanOrEqual(1);
      // 同单元发布应只有一条 released_units。
      const units = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM released_units WHERE release_id = $1",
        [history.items[0]?.id],
      );
      expect(units.rows[0]?.n).toBe(1);
    } finally {
      await pool.end();
    }

    // 草稿修改后已发布快照仍不变。
    await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft/items/${itemA}`, {
      payload: { meaning: "修订后的释义", draftVersion: version },
    });
    const pool2 = createPool({ ...config, max: 1 });
    try {
      const still = await pool2.query<{ meaning: string }>(
        "SELECT meaning FROM released_course_items WHERE course_item_id = $1",
        [itemA],
      );
      expect(still.rows[0]?.meaning).toBe("放弃");
    } finally {
      await pool2.end();
    }
  });

  it("没有学习核心业务数据表（学习卡/展示/会话表存在；review_events / FSRS / XP / 挑战表不存在）", async () => {
    const pool = createPool({ ...config, max: 1 });
    try {
      // 阶段 5 工单 01/02 已引入 learning_cards / learning_exposures；工单 03 引入 study_sessions；
      // 工单 04 引入 review_events（不可变评分事件）。其余学习分（FSRS 状态、XP、挑战）仍不存在。
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename IN (
             'card_reviews','memory_states','fsrs_states',
             'xp_ledger','daily_plans',
             'challenge_quizzes','quiz_questions','quiz_responses','challenge_points',
             'weekly_challenge_boards','badges','user_levels'
           )`,
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await pool.end();
    }

    // 报名/设主响应不含学习进度/会话/XP 字段。
    const { courseId } = await createPublishedCourse("无学习产物课程");
    const enroll = await learner.req("POST", `/api/v1/catalog/courses/${courseId}/enroll`, {
      payload: { makePrimary: true },
    });
    const d = body(enroll) as Record<string, unknown>;
    expect(d).not.toHaveProperty("sessionId");
    expect(d).not.toHaveProperty("learningCardCount");
    expect(d).not.toHaveProperty("xp");
    expect(d).not.toHaveProperty("dueReviews");
  });
});
