// 课程词项集成测试：引用已有词条、必填中文释义、手工 provenance、跨单元移动、排序、
// 版本冲突、外键约束、稳定 item ID、多课程独立引用、权限与审计。
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

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")("admin course items", () => {
  let app: App;
  let admin: Client;

  beforeAll(async () => {
    await migrate(config, MIGRATIONS_DIR);
    const adminPool = createPool({ ...config, max: 1 });
    const ps = new PasswordService();
    const hash = await ps.hashPassword("item-itest-admin-pass-123");
    await adminPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('item-itest-admin', 'Item ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'`,
      [hash],
    );
    await adminPool.end();

    app = await createApp();
    await app.init();
    admin = makeClient(app);
    const login = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: "item-itest-admin", password: "item-itest-admin-pass-123" },
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

  /** 创建词条，返回词条 ID；固定拼写在共享库上已存在时复用既有词条（可重复执行）。 */
  async function createEntry(spelling?: string): Promise<string> {
    const res = await admin.req("POST", "/api/v1/admin/lexical-entries", {
      payload: { canonicalSpelling: spelling ?? uniq("itemword"), confirmDuplicate: false },
    });
    if (res.statusCode === 409) {
      const err = body(res) as { error?: { duplicateCandidates?: { id?: string }[] } };
      const existing = err.error?.duplicateCandidates?.[0]?.id;
      if (existing) return existing;
    }
    expect(res.statusCode).toBe(201);
    return (body(res) as { id?: string }).id as string;
  }

  /** 创建课程 + 两个单元，返回 courseId、unitA、unitB。 */
  async function createCourseWithUnits(): Promise<{
    courseId: string;
    draftVersion: number;
    unitA: string;
    unitB: string;
  }> {
    const slug = uniq("itemcourse");
    const res = await admin.req("POST", "/api/v1/admin/courses", {
      payload: { slug, title: "词项课程", level: "a1" },
    });
    expect(res.statusCode).toBe(201);
    const created = body(res) as { courseId?: string; draftVersion?: number };
    const courseId = created.courseId as string;
    let version = created.draftVersion ?? 1;

    const unitA = randomUUID();
    const rA = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitA}`, {
      payload: { title: "基础词汇", draftVersion: version },
    });
    expect(rA.statusCode).toBe(201);
    version = (body(rA) as { version?: number }).version ?? version;

    const unitB = randomUUID();
    const rB = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitB}`, {
      payload: { title: "日常表达", draftVersion: version },
    });
    expect(rB.statusCode).toBe(201);
    version = (body(rB) as { version?: number }).version ?? version;

    return { courseId, draftVersion: version, unitA, unitB };
  }

  async function learnerClient(): Promise<Client> {
    const username = `item-learner-${randomBytes(3).toString("hex")}`;
    const res = await admin.req("POST", "/api/v1/admin/users", {
      headers: { "idempotency-key": `item-create-${username}` },
      payload: {
        username,
        displayName: "词项测试学习者",
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    const otp = (res.json() as { oneTimePassword?: string }).oneTimePassword;
    const client = makeClient(app);
    await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
    await client.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "item-learner-pass-12345" },
    });
    return client;
  }

  it("创建课程词项：引用已有词条、必填中文释义、手工 provenance 关联审计", async () => {
    const entryId = await createEntry("abandon");
    const { courseId, draftVersion, unitA } = await createCourseWithUnits();
    const itemId = randomUUID();

    const res = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
      payload: {
        unitId: unitA,
        lexicalEntryId: entryId,
        meaning: "放弃",
        hint: "Don't abandon your plan",
        draftVersion,
      },
    });
    expect(res.statusCode).toBe(201);
    const draft = body(res) as {
      version?: number;
      units?: {
        id: string;
        items: {
          id: string;
          meaning: string;
          hint: string | null;
          contentReviewReference: string;
          lexicalEntry: { canonicalSpelling: string; sourceStatus: string };
        }[];
      }[];
    };
    expect(draft.version).toBe(draftVersion + 1);
    const unit = draft.units?.find((u) => u.id === unitA);
    expect(unit?.items.length).toBe(1);
    expect(unit?.items[0]?.id).toBe(itemId);
    expect(unit?.items[0]?.meaning).toBe("放弃");
    expect(unit?.items[0]?.hint).toBe("Don't abandon your plan");
    expect(unit?.items[0]?.lexicalEntry.canonicalSpelling).toBe("abandon");
    expect(unit?.items[0]?.lexicalEntry.sourceStatus).toBe("manual");

    // 手工内容 provenance：content_review_reference 指向一条 admin.course.item.create 审计。
    const ref = unit?.items[0]?.contentReviewReference;
    expect(ref).toBeTruthy();
    const pool = createPool({ ...config, max: 1 });
    try {
      const audit = await pool.query<{ action: string; after_summary: unknown }>(
        `SELECT action, after_summary FROM audit_events WHERE id = $1`,
        [ref],
      );
      expect(audit.rows[0]?.action).toBe("admin.course.item.create");
      const summary = JSON.stringify(audit.rows[0]?.after_summary ?? {});
      expect(summary).toContain(itemId);
      // 审计摘要不含明文中文释义（大段用户输入），只含哈希。
      expect(summary).not.toContain("放弃");
    } finally {
      await pool.end();
    }
  });

  it("中文释义必填、提示可选", async () => {
    const entryId = await createEntry();
    const { courseId, draftVersion, unitA } = await createCourseWithUnits();

    const emptyMeaning = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${randomUUID()}`,
      {
        payload: { unitId: unitA, lexicalEntryId: entryId, meaning: "  ", draftVersion },
      },
    );
    expect(emptyMeaning.statusCode).toBe(422);
    const err = body(emptyMeaning) as { error: { fieldErrors?: { path: string }[] } };
    expect(err.error.fieldErrors?.some((f) => f.path === "meaning")).toBe(true);

    const noHint = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${randomUUID()}`,
      { payload: { unitId: unitA, lexicalEntryId: entryId, meaning: "只填释义", draftVersion } },
    );
    expect(noHint.statusCode).toBe(201);
    const draft = body(noHint) as {
      units?: { id: string; items: { hint: string | null }[] }[];
    };
    expect(draft.units?.find((u) => u.id === unitA)?.items[0]?.hint).toBeNull();
  });

  it("词条不存在、单元不属于课程返回结构化 422", async () => {
    const entryId = await createEntry();
    const { courseId, draftVersion, unitA } = await createCourseWithUnits();

    const badEntry = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${randomUUID()}`,
      {
        payload: {
          unitId: unitA,
          lexicalEntryId: "00000000-0000-0000-0000-000000000000",
          meaning: "词条不存在",
          draftVersion,
        },
      },
    );
    expect(badEntry.statusCode).toBe(422);
    const entryErr = body(badEntry) as { error: { fieldErrors?: { path: string }[] } };
    expect(entryErr.error.fieldErrors?.some((f) => f.path === "lexicalEntryId")).toBe(true);

    const foreignUnit = randomUUID();
    const badUnit = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${randomUUID()}`,
      {
        payload: {
          unitId: foreignUnit,
          lexicalEntryId: entryId,
          meaning: "跨课程单元",
          draftVersion,
        },
      },
    );
    expect(badUnit.statusCode).toBe(422);
    const unitErr = body(badUnit) as { error: { fieldErrors?: { path: string }[] } };
    expect(unitErr.error.fieldErrors?.some((f) => f.path === "unitId")).toBe(true);
  });

  it("跨单元移动：从源单元移除并追加到目标单元末尾", async () => {
    const entryId = await createEntry();
    const { courseId, draftVersion, unitA, unitB } = await createCourseWithUnits();
    const itemId = randomUUID();
    let version = draftVersion;

    const created = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      {
        payload: {
          unitId: unitA,
          lexicalEntryId: entryId,
          meaning: "移动我",
          draftVersion: version,
        },
      },
    );
    expect(created.statusCode).toBe(201);
    version = (body(created) as { version?: number }).version ?? version;

    // 移动到单元 B。
    const moved = await admin.req(
      "PATCH",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      { payload: { unitId: unitB, draftVersion: version } },
    );
    expect(moved.statusCode).toBe(200);
    const draft = body(moved) as { units?: { id: string; items: { id: string }[] }[] };
    expect(draft.units?.find((u) => u.id === unitB)?.items.map((i) => i.id)).toEqual([itemId]);
    expect(draft.units?.find((u) => u.id === unitA)?.items.length).toBe(0);
  });

  it("词项排序：完整顺序生效，拒绝重复/遗漏/陌生 ID", async () => {
    const entryId = await createEntry();
    const { courseId, draftVersion, unitA } = await createCourseWithUnits();
    const i1 = randomUUID();
    const i2 = randomUUID();
    let version = draftVersion;
    for (const id of [i1, i2]) {
      const r = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/${id}`, {
        payload: {
          unitId: unitA,
          lexicalEntryId: entryId,
          meaning: `释义 ${id.slice(0, 4)}`,
          draftVersion: version,
        },
      });
      expect(r.statusCode).toBe(201);
      version = (body(r) as { version?: number }).version ?? version;
    }

    const reorder = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/reorder`,
      { payload: { unitId: unitA, itemIds: [i2, i1], draftVersion: version } },
    );
    expect(reorder.statusCode).toBe(201);
    const reordered = body(reorder) as { units?: { id: string; items: { id: string }[] }[] };
    expect(reordered.units?.find((u) => u.id === unitA)?.items.map((i) => i.id)).toEqual([i2, i1]);

    // 遗漏 → 422
    const missing = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/reorder`,
      {
        payload: {
          unitId: unitA,
          itemIds: [i1],
          draftVersion: (reordered as { version?: number }).version,
        },
      },
    );
    expect(missing.statusCode).toBe(422);
    // 重复 → 422
    const dup = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/items/reorder`, {
      payload: {
        unitId: unitA,
        itemIds: [i1, i1],
        draftVersion: (reordered as { version?: number }).version,
      },
    });
    expect(dup.statusCode).toBe(422);
    // 陌生 ID → 422
    const foreign = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/reorder`,
      {
        payload: {
          unitId: unitA,
          itemIds: [i1, randomUUID()],
          draftVersion: (reordered as { version?: number }).version,
        },
      },
    );
    expect(foreign.statusCode).toBe(422);
  });

  it("旧版本返回 409 DRAFT_VERSION_CONFLICT；编辑后稳定 item ID 不变；删除重排", async () => {
    const entryId = await createEntry();
    const { courseId, draftVersion, unitA } = await createCourseWithUnits();
    const itemId = randomUUID();
    let version = draftVersion;

    const created = await admin.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      {
        payload: { unitId: unitA, lexicalEntryId: entryId, meaning: "初始", draftVersion: version },
      },
    );
    expect(created.statusCode).toBe(201);
    version = (body(created) as { version?: number }).version ?? version;

    // 旧版本编辑 → 冲突。
    const stale = await admin.req(
      "PATCH",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      { payload: { meaning: "旧版本", draftVersion } },
    );
    expect(stale.statusCode).toBe(409);
    const err = body(stale) as { error: { code?: string; currentDraftVersion?: number } };
    expect(err.error.code).toBe("DRAFT_VERSION_CONFLICT");
    expect(err.error.currentDraftVersion).toBe(version);

    // 编辑后 item ID 稳定。
    const edited = await admin.req(
      "PATCH",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      { payload: { meaning: "更新释义", draftVersion: version } },
    );
    expect(edited.statusCode).toBe(200);
    const editedDraft = body(edited) as {
      units?: { id: string; items: { id: string; meaning: string }[] }[];
    };
    const item = editedDraft.units?.find((u) => u.id === unitA)?.items[0];
    expect(item?.id).toBe(itemId);
    expect(item?.meaning).toBe("更新释义");

    // 删除未发布词项 → 单元内重排。
    const deleted = await admin.req(
      "DELETE",
      `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
      { payload: { draftVersion: (editedDraft as { version?: number }).version } },
    );
    expect(deleted.statusCode).toBe(200);
    const after = body(deleted) as { units?: { id: string; items: unknown[] }[] };
    expect(after.units?.find((u) => u.id === unitA)?.items.length).toBe(0);
  });

  it("同一词条在不同课程中独立引用；审计事件写入且不含明文释义", async () => {
    const entryId = await createEntry("indep-word");
    const c1 = await createCourseWithUnits();
    const c2 = await createCourseWithUnits();
    const item1 = randomUUID();
    const item2 = randomUUID();

    const r1 = await admin.req(
      "POST",
      `/api/v1/admin/courses/${c1.courseId}/draft/items/${item1}`,
      {
        payload: {
          unitId: c1.unitA,
          lexicalEntryId: entryId,
          meaning: "课程一释义",
          draftVersion: c1.draftVersion,
        },
      },
    );
    expect(r1.statusCode).toBe(201);
    const r2 = await admin.req(
      "POST",
      `/api/v1/admin/courses/${c2.courseId}/draft/items/${item2}`,
      {
        payload: {
          unitId: c2.unitA,
          lexicalEntryId: entryId,
          meaning: "课程二释义",
          draftVersion: c2.draftVersion,
        },
      },
    );
    expect(r2.statusCode).toBe(201);

    const d1 = body(r1) as {
      units?: { items: { meaning: string; lexicalEntry: { id: string } }[] }[];
    };
    const d2 = body(r2) as {
      units?: { items: { meaning: string; lexicalEntry: { id: string } }[] }[];
    };
    expect(d1.units?.[0]?.items[0]?.meaning).toBe("课程一释义");
    expect(d2.units?.[0]?.items[0]?.meaning).toBe("课程二释义");
    expect(d1.units?.[0]?.items[0]?.lexicalEntry.id).toBe(entryId);
    expect(d2.units?.[0]?.items[0]?.lexicalEntry.id).toBe(entryId);

    const pool = createPool({ ...config, max: 1 });
    try {
      const audits = await pool.query<{ action: string; after_summary: unknown }>(
        `SELECT action, after_summary FROM audit_events
         WHERE action LIKE 'admin.course.item.%'`,
      );
      const actions = audits.rows.map((r) => r.action);
      expect(actions).toContain("admin.course.item.create");
      const text = JSON.stringify(audits.rows.map((r) => r.after_summary));
      // 审计摘要不含明文中文释义。
      expect(text).not.toContain("课程一释义");
      expect(text.toLowerCase()).not.toMatch(/password|secret|token/);
    } finally {
      await pool.end();
    }
  });

  it("learner 拒绝访问词项接口；数据库外键与 position 唯一约束生效", async () => {
    const learner = await learnerClient();
    const { courseId, draftVersion, unitA } = await createCourseWithUnits();
    const entryId = await createEntry();

    const list = await learner.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
    expect(list.statusCode).toBe(403);
    const create = await learner.req(
      "POST",
      `/api/v1/admin/courses/${courseId}/draft/items/${randomUUID()}`,
      { payload: { unitId: unitA, lexicalEntryId: entryId, meaning: "越权", draftVersion } },
    );
    expect(create.statusCode).toBe(403);

    const pool = createPool({ ...config, max: 1 });
    try {
      const unitRows = await pool.query<{ id: string }>(
        "SELECT id FROM draft_units WHERE id = $1",
        [unitA],
      );
      expect(unitRows.rowCount).toBe(1);

      // content_review_reference 外键需要一条真实审计事件作为种子。
      const auditId = randomUUID();
      await pool.query(
        `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, after_summary)
         VALUES ($1, NULL, 'test.item.seed', 'course', 'seed', '{}')`,
        [auditId],
      );

      // position 唯一约束。
      await pool.query(
        `INSERT INTO draft_course_items (id, draft_unit_id, lexical_entry_id, position, meaning, content_review_reference)
         VALUES ($1, $2, $3, 99, '位置 99', $4)`,
        [randomUUID(), unitA, entryId, auditId],
      );
      await expect(
        pool.query(
          `INSERT INTO draft_course_items (id, draft_unit_id, lexical_entry_id, position, meaning, content_review_reference)
           VALUES ($1, $2, $3, 99, '重复位置', $4)`,
          [randomUUID(), unitA, entryId, auditId],
        ),
      ).rejects.toThrow(/draft_course_items_unit_position_unique/);

      // 词条外键。
      await expect(
        pool.query(
          `INSERT INTO draft_course_items (id, draft_unit_id, lexical_entry_id, position, meaning, content_review_reference)
           VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 1, '坏词条', $3)`,
          [randomUUID(), unitA, auditId],
        ),
      ).rejects.toThrow(/foreign key|lexical_entry_id/);
    } finally {
      await pool.end();
    }
  });
});
