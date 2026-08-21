// 课程草稿与单元集成测试：原子创建、唯一 active draft、单元排序、版本并发、权限与审计。
// 需要运行中的 PostgreSQL（compose 的 db 服务）。连接不可用时整个 describe 跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { createApp } from "../../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../../apps/api/src/auth/password.service.js";

type App = Awaited<ReturnType<typeof createApp>>;

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

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")("admin course drafts", () => {
  let app: App;
  let admin: Client;

  beforeAll(async () => {
    await migrate(config, MIGRATIONS_DIR);
    const adminPool = createPool({ ...config, max: 1 });
    const ps = new PasswordService();
    const hash = await ps.hashPassword("course-itest-admin-pass-123");
    await adminPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
         VALUES ('course-itest-admin', 'Course ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)
         ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'`,
      [hash],
    );
    await adminPool.end();

    app = await createApp();
    await app.init();
    admin = makeClient(app);
    const login = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: "course-itest-admin", password: "course-itest-admin-pass-123" },
    });
    expect(login.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }

  function uniq(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}`;
  }

  async function createCourse(opts?: { slug?: string; title?: string }): Promise<{
    res: Res;
    courseId: string;
    draftVersion: number;
  }> {
    const slug = opts?.slug ?? uniq("course");
    const title = opts?.title ?? `课程 ${slug}`;
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title, level: "a1", description: "测试课程" },
    });
    expect(res.statusCode).toBe(201);
    const created = body(res) as { courseId?: string; draftVersion?: number };
    expect(created.courseId).toBeTruthy();
    return { res, courseId: created.courseId as string, draftVersion: created.draftVersion ?? 1 };
  }

  async function learnerClient(): Promise<Client> {
    const username = `course-learner-${randomBytes(3).toString("hex")}`;
    const res = await admin.req("POST", "/api/v1/admin/users", {
      headers: { "idempotency-key": `course-create-${username}` },
      payload: {
        username,
        displayName: "课程测试学习者",
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    const otp = (res.json() as { oneTimePassword?: string }).oneTimePassword;
    const client = makeClient(app);
    await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
    await client.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "course-learner-pass-12345" },
    });
    return client;
  }

  it("创建课程：课程与初始草稿原子创建，draftVersion=1，唯一 active draft", async () => {
    const slug = uniq("atomic");
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "原子创建课程", level: "b1" },
    });
    expect(res.statusCode).toBe(201);
    const created = body(res) as { courseId?: string; draftId?: string; draftVersion?: number };
    expect(created.draftVersion).toBe(1);
    expect(created.draftId).toBeTruthy();

    const pool = createPool({ ...config, max: 1 });
    try {
      const courseRows = await pool.query("SELECT 1 FROM courses WHERE id = $1", [
        created.courseId,
      ]);
      expect(courseRows.rowCount).toBe(1);
      const draftRows = await pool.query("SELECT 1 FROM course_drafts WHERE course_id = $1", [
        created.courseId,
      ]);
      expect(draftRows.rowCount).toBe(1);

      // 课程创建与初始草稿创建各有一条独立审计事件，同一事务内写入。
      const courseAudits = await pool.query<{ action: string; after_summary: unknown }>(
        `SELECT action, after_summary FROM audit_events
         WHERE target_type = 'course' AND target_id = $1`,
        [created.courseId],
      );
      expect(courseAudits.rows.map((r) => r.action)).toContain("admin.course.create");
      const draftAudits = await pool.query<{ action: string; after_summary: unknown }>(
        `SELECT action, after_summary FROM audit_events
         WHERE target_type = 'course_draft' AND target_id = $1`,
        [created.draftId],
      );
      expect(draftAudits.rows.map((r) => r.action)).toContain("admin.course.draft.create");
      const draftSummary = draftAudits.rows[0]?.after_summary as
        { courseId?: string; draftVersion?: number; status?: string } | undefined;
      expect(draftSummary?.courseId).toBe(created.courseId);
      expect(draftSummary?.draftVersion).toBe(1);
      expect(draftSummary?.status).toBe("active");

      // 尝试插入第二个 active draft → 唯一约束拒绝。
      await expect(
        pool.query(
          `INSERT INTO course_drafts (course_id, version, title, level, description, status)
             VALUES ($1, 2, '第二个草稿', 'a1', '', 'active')`,
          [created.courseId],
        ),
      ).rejects.toThrow(/course_drafts_one_active_per_course_unique/);

      // archived 草稿不被 active 唯一约束阻止（部分唯一索引只覆盖 status='active'）。
      await pool.query(
        `INSERT INTO course_drafts (course_id, version, title, level, description, status)
         VALUES ($1, 3, '归档草稿', 'a1', '', 'archived')`,
        [created.courseId],
      );
      const archivedRows = await pool.query(
        "SELECT 1 FROM course_drafts WHERE course_id = $1 AND status = 'archived'",
        [created.courseId],
      );
      expect(archivedRows.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("slug 冲突返回 409，空标题与非法 slug 返回 422", async () => {
    const slug = uniq("slugdup");
    await createCourse({ slug });

    const dup = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "重复 slug" },
    });
    expect(dup.statusCode).toBe(409);

    const emptyTitle = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug: uniq("notitle"), title: "  " },
    });
    expect(emptyTitle.statusCode).toBe(422);

    const badSlug = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug: "Bad Slug!", title: "非法 slug" },
    });
    expect(badSlug.statusCode).toBe(422);
    const err = body(badSlug) as { error: { fieldErrors?: { path: string }[] } };
    expect(err.error.fieldErrors?.some((f) => f.path === "slug")).toBe(true);
  });

  it("列表返回课程、草稿版本与可见状态", async () => {
    const { courseId } = await createCourse();
    const res = await admin.req("GET", "/api/v1/admin/courses", {});
    expect(res.statusCode).toBe(200);
    const list = body(res) as {
      items: { id: string; draftVersion: number | null }[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    const item = list.items.find((c) => c.id === courseId);
    expect(item).toBeTruthy();
    expect(item?.draftVersion).toBe(1);
    expect(typeof list.hasMore).toBe("boolean");
    expect(list.nextCursor === null || typeof list.nextCursor === "string").toBe(true);
  });

  it("管理员课程列表支持稳定游标分页、标题/slug 搜索与参数校验", async () => {
    const marker = uniq("paged");
    const created = await Promise.all(
      ["alpha", "bravo", "charlie"].map((suffix) =>
        createCourse({
          slug: `${marker}-${suffix}`,
          title: `${marker} ${suffix}`,
        }),
      ),
    );

    const first = await admin.req("GET", `/api/v1/admin/courses?limit=2&q=${marker}`, {});
    expect(first.statusCode).toBe(200);
    const firstBody = body(first) as {
      items: { id: string; slug: string }[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();
    expect(firstBody.items.every((item) => item.slug.startsWith(marker))).toBe(true);

    const second = await admin.req(
      "GET",
      `/api/v1/admin/courses?limit=2&q=${marker.toUpperCase()}&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      {},
    );
    // 游标绑定规范化后的搜索词，大小写变化仍属于同一个搜索条件。
    expect(second.statusCode).toBe(200);
    const secondBody = body(second) as {
      items: { id: string; slug: string }[];
      hasMore: boolean;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.hasMore).toBe(false);
    const firstIds = new Set(firstBody.items.map((item) => item.id));
    expect(secondBody.items.some((item) => firstIds.has(item.id))).toBe(false);
    expect(created.map(({ courseId }) => courseId)).toEqual(
      expect.arrayContaining([...firstBody.items, ...secondBody.items].map((item) => item.id)),
    );

    const invalidLimit = await admin.req("GET", "/api/v1/admin/courses?limit=51", {});
    expect(invalidLimit.statusCode).toBe(422);
  });

  it("单元新增、编辑、删除与版本递增；删除后重排连续", async () => {
    const { courseId, draftVersion } = await createCourse();

    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();

    const c1 = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${u1}`, {
      payload: { title: "单元一", draftVersion },
    });
    expect(c1.statusCode).toBe(201);
    const v2 = (body(c1) as { version?: number }).version;
    expect(v2).toBe(2);

    const c2 = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${u2}`, {
      payload: { title: "单元二", draftVersion: v2 },
    });
    expect(c2.statusCode).toBe(201);
    const v3 = (body(c2) as { version?: number }).version;
    expect(v3).toBe(3);

    const c3 = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${u3}`, {
      payload: { title: "单元三", draftVersion: v3 },
    });
    expect(c3.statusCode).toBe(201);
    const v4 = (body(c3) as { version?: number }).version;
    expect(v4).toBe(4);

    // 编辑单元二标题。
    const edit = await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft/units/${u2}`, {
      payload: { title: "单元二（改）", draftVersion: v4 },
    });
    expect(edit.statusCode).toBe(200);
    expect((body(edit) as { version?: number }).version).toBe(5);

    // 删除单元二 → 剩余重排为 1..n（单元一、单元三）。
    const del = await admin.req("DELETE", `/api/v1/admin/courses/${courseId}/draft/units/${u2}`, {
      payload: { draftVersion: 5 },
    });
    expect(del.statusCode).toBe(200);
    const afterDelete = body(del) as {
      version?: number;
      units?: { id: string; position: number }[];
    };
    expect(afterDelete.version).toBe(6);
    expect(afterDelete.units?.map((u) => u.id)).toEqual([u1, u3]);
    expect(afterDelete.units?.map((u) => u.position)).toEqual([1, 2]);
  });

  it("重排：提交完整顺序生效，缺少单元返回 422，重复顺序请求两次都成功", async () => {
    const { courseId, draftVersion } = await createCourse();
    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();
    let version = draftVersion;
    for (const [id, title] of [
      [u1, "甲"],
      [u2, "乙"],
      [u3, "丙"],
    ] as const) {
      const r = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${id}`, {
        payload: { title, draftVersion: version },
      });
      expect(r.statusCode).toBe(201);
      version = (body(r) as { version?: number }).version ?? version;
    }

    // 逆序重排。
    const reorder = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/reorder`, {
      payload: { unitIds: [u3, u1, u2], draftVersion: version },
    });
    expect(reorder.statusCode).toBe(201);
    const reordered = body(reorder) as {
      version?: number;
      units?: { id: string; position: number }[];
    };
    expect(reordered.units?.map((u) => u.id)).toEqual([u3, u1, u2]);
    const vAfter = reordered.version ?? 0;

    // 重复排序请求（同一顺序，新版本）→ 仍成功并递增版本。
    const repeat = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/reorder`, {
      payload: { unitIds: [u3, u1, u2], draftVersion: vAfter },
    });
    expect(repeat.statusCode).toBe(201);
    expect((body(repeat) as { version?: number }).version).toBe(vAfter + 1);

    // 缺少单元 → 422。
    const missing = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/reorder`, {
      payload: { unitIds: [u1, u2], draftVersion: vAfter + 1 },
    });
    expect(missing.statusCode).toBe(422);
    const err = body(missing) as { error: { fieldErrors?: { path: string }[] } };
    expect(err.error.fieldErrors?.some((f) => f.path === "unitIds")).toBe(true);
  });

  it("旧版本保存返回 409 DRAFT_VERSION_CONFLICT 并携带服务端当前版本", async () => {
    const { courseId, draftVersion } = await createCourse();
    const r1 = await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
      payload: { title: "第一版", draftVersion },
    });
    expect(r1.statusCode).toBe(200);
    const v2 = (body(r1) as { version?: number }).version ?? 0;

    // 用旧版本 v1 保存 → 冲突。
    const stale = await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
      payload: { title: "过期覆盖", draftVersion },
    });
    expect(stale.statusCode).toBe(409);
    const err = body(stale) as {
      error: { code?: string; currentDraftVersion?: number };
    };
    expect(err.error.code).toBe("DRAFT_VERSION_CONFLICT");
    expect(err.error.currentDraftVersion).toBe(v2);

    // 服务端未被覆盖。
    const draft = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
    expect((body(draft) as { title?: string }).title).toBe("第一版");
  });

  it("If-Match 头同样生效；缺少版本返回 400", async () => {
    const { courseId, draftVersion } = await createCourse();
    const ok = await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
      headers: { "if-match": String(draftVersion) },
      payload: { title: "If-Match 保存" },
    });
    expect(ok.statusCode).toBe(200);

    const missing = await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
      payload: { title: "无版本" },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("并发更新同一草稿：至多一个成功，另一个得到冲突", async () => {
    const { courseId, draftVersion } = await createCourse();
    const [r1, r2] = await Promise.all([
      admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
        payload: { title: "并发甲", draftVersion },
      }),
      admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
        payload: { title: "并发乙", draftVersion },
      }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
  });

  it("学习者无权访问课程管理接口，看不到草稿", async () => {
    const learner = await learnerClient();
    const list = await learner.req("GET", "/api/v1/admin/courses", {});
    expect(list.statusCode).toBe(403);
    const create = await learner.req("POST", "/api/v1/admin/courses", {
      payload: { slug: "learner-course", title: "越权" },
    });
    expect(create.statusCode).toBe(403);
    const draft = await learner.req(
      "GET",
      "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/draft",
      {},
    );
    expect(draft.statusCode).toBe(403);
  });

  it("不存在课程草稿返回 404", async () => {
    const res = await admin.req(
      "GET",
      "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/draft",
      {},
    );
    expect(res.statusCode).toBe(404);
  });

  it("所有写操作写入管理员审计事件且不含敏感信息", async () => {
    const { courseId, draftVersion } = await createCourse();
    const u1 = randomUUID();
    await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${u1}`, {
      payload: { title: "审计单元", draftVersion },
    });
    const v2 = 2;
    await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/reorder`, {
      payload: { unitIds: [u1], draftVersion: v2 },
    });

    const pool = createPool({ ...config, max: 1 });
    try {
      const rows = await pool.query<{ action: string; after_summary: unknown }>(
        `SELECT action, after_summary FROM audit_events
           WHERE target_type = 'course' AND target_id = $1
           ORDER BY created_at ASC, id ASC`,
        [courseId],
      );
      const actions = rows.rows.map((r) => r.action);
      expect(actions).toContain("admin.course.create");
      expect(actions).toContain("admin.course.unit.create");
      expect(actions).toContain("admin.course.units.reorder");
      const text = JSON.stringify(rows.rows.map((r) => r.after_summary));
      expect(text.toLowerCase()).not.toMatch(/password|secret|token/);
    } finally {
      await pool.end();
    }
  });

  it("数据库约束：position 必须正整数且草稿内唯一", async () => {
    const { courseId } = await createCourse();
    const pool = createPool({ ...config, max: 1 });
    try {
      const draft = await pool.query<{ id: string }>(
        "SELECT id FROM course_drafts WHERE course_id = $1 AND status = 'active'",
        [courseId],
      );
      const draftId = draft.rows[0]?.id;
      expect(draftId).toBeTruthy();
      await pool.query(
        "INSERT INTO draft_units (draft_id, position, title) VALUES ($1, 1, '合法')",
        [draftId],
      );
      await expect(
        pool.query("INSERT INTO draft_units (draft_id, position, title) VALUES ($1, 0, '非法')", [
          draftId,
        ]),
      ).rejects.toThrow(/check/);
      await expect(
        pool.query("INSERT INTO draft_units (draft_id, position, title) VALUES ($1, 1, '重复')", [
          draftId,
        ]),
      ).rejects.toThrow(/draft_units_draft_position_unique/);
    } finally {
      await pool.end();
    }
  });
});
