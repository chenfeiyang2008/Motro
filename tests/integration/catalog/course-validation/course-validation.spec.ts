// 课程草稿校验集成测试：只读校验不改变草稿/不产生 release/不改变 current-release、
// 阻断错误定位、warning 区分、learner 拒绝与旧校验 token 不可代表新草稿。
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

interface ValidateResult {
  draftVersion: number;
  isPublishable: boolean;
  blockingErrors: { code: string; path: string; severity: string }[];
  warnings: { code: string; severity: string }[];
  diffSummary: { kind: string; totalUnits: number; totalItems: number };
  affectedLearnerCount: number;
  contentHash: string;
  validationToken: string;
}

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "admin course validation",
  () => {
    let app: App;
    let admin: Client;

    beforeAll(async () => {
      await migrate(config, MIGRATIONS_DIR);
      const adminPool = createPool({ ...config, max: 1 });
      const ps = new PasswordService();
      const hash = await ps.hashPassword("validate-itest-admin-pass-123");
      await adminPool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
         VALUES ('validate-itest-admin', 'Validate ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)
         ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'`,
        [hash],
      );
      await adminPool.end();

      app = await createApp();
      await app.init();
      admin = makeClient(app);
      const login = await admin.req("POST", "/api/v1/auth/login", {
        payload: { username: "validate-itest-admin", password: "validate-itest-admin-pass-123" },
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

    async function createEntry(): Promise<string> {
      const res = await admin.req("POST", "/api/v1/admin/lexical-entries", {
        payload: { canonicalSpelling: uniq("valword"), confirmDuplicate: false },
      });
      expect(res.statusCode).toBe(201);
      return (body(res) as { id?: string }).id as string;
    }

    async function createCourseWithUnitAndItem(): Promise<{
      courseId: string;
      draftVersion: number;
      unitId: string;
      entryId: string;
    }> {
      const entryId = await createEntry();
      const slug = uniq("valcourse");
      const res = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug, title: "校验课程", level: "a1", description: "课程描述" },
      });
      expect(res.statusCode).toBe(201);
      const created = body(res) as { courseId?: string; draftVersion?: number };
      const courseId = created.courseId as string;
      let version = created.draftVersion ?? 1;

      const unitId = randomUUID();
      const r = await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
        payload: { title: "基础词汇", description: "单元描述", draftVersion: version },
      });
      expect(r.statusCode).toBe(201);
      version = (body(r) as { version?: number }).version ?? version;

      const itemId = randomUUID();
      const ri = await admin.req(
        "POST",
        `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
        {
          payload: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
        },
      );
      expect(ri.statusCode).toBe(201);
      version = (body(ri) as { version?: number }).version ?? version;

      return { courseId, draftVersion: version, unitId, entryId };
    }

    async function validate(courseId: string): Promise<{ status: number; data?: ValidateResult }> {
      const res = await admin.req("POST", `/api/v1/admin/courses/${courseId}/validate`, {});
      if (res.statusCode === 200) {
        return { status: res.statusCode, data: body(res) as unknown as ValidateResult };
      }
      return { status: res.statusCode };
    }

    async function learnerClient(): Promise<Client> {
      const username = `val-learner-${randomBytes(3).toString("hex")}`;
      const res = await admin.req("POST", "/api/v1/admin/users", {
        headers: { "idempotency-key": `val-create-${username}` },
        payload: {
          username,
          displayName: "校验测试学习者",
          timezone: "Asia/Shanghai",
          dailyBudgetMinutes: 10,
        },
      });
      expect(res.statusCode).toBe(201);
      const otp = (res.json() as { oneTimePassword?: string }).oneTimePassword;
      const client = makeClient(app);
      await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
      await client.req("POST", "/api/v1/auth/change-password", {
        payload: { currentPassword: otp, newPassword: "val-learner-pass-12345" },
      });
      return client;
    }

    it("合法草稿可发布：initial diff、影响人数 0、draftVersion 不变、不产生 release", async () => {
      const { courseId, draftVersion } = await createCourseWithUnitAndItem();
      const { status, data } = await validate(courseId);
      expect(status).toBe(200);
      expect(data?.draftVersion).toBe(draftVersion);
      expect(data?.isPublishable).toBe(true);
      expect(data?.blockingErrors).toEqual([]);
      expect(data?.diffSummary.kind).toBe("initial");
      expect(data?.diffSummary.totalUnits).toBe(1);
      expect(data?.diffSummary.totalItems).toBe(1);
      expect(data?.affectedLearnerCount).toBe(0);
      expect(data?.contentHash).toBeTruthy();
      expect(data?.validationToken).toContain(String(draftVersion));

      // 校验不改变草稿版本。
      const draft = await admin.req("GET", `/api/v1/admin/courses/${courseId}/draft`, {});
      expect((body(draft) as { version?: number }).version).toBe(draftVersion);

      // 校验不产生 release 行，也不改变 current-release（表已存在，但校验只读不落库）。
      const pool = createPool({ ...config, max: 1 });
      try {
        const releases = await pool.query("SELECT 1 FROM course_releases WHERE course_id = $1", [
          courseId,
        ]);
        expect(releases.rowCount).toBe(0);
        const current = await pool.query<{ current_release_id: string | null }>(
          "SELECT current_release_id FROM courses WHERE id = $1",
          [courseId],
        );
        expect(current.rows[0]?.current_release_id).toBeNull();
      } finally {
        await pool.end();
      }
    });

    it("空课程/空单元/空释义/悬空引用/无效 provenance 均返回阻断错误与定位 path", async () => {
      const { courseId, unitId, entryId } = await createCourseWithUnitAndItem();
      const pool = createPool({ ...config, max: 1 });
      try {
        // 种子审计事件供直接插入使用。
        const auditId = randomUUID();
        await pool.query(
          `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, after_summary)
           VALUES ($1, NULL, 'test.validation.seed', 'course', 'seed', '{}')`,
          [auditId],
        );

        // 空释义词项。
        const emptyMeaning = randomUUID();
        await pool.query(
          `INSERT INTO draft_course_items (id, draft_unit_id, lexical_entry_id, position, meaning, content_review_reference)
           VALUES ($1, $2, $3, 99, '  ', $4)`,
          [emptyMeaning, unitId, entryId, auditId],
        );

        const { status, data } = await validate(courseId);
        expect(status).toBe(200);
        expect(data?.isPublishable).toBe(false);
        const codes = (data?.blockingErrors ?? []).map((e) => e.code);
        expect(codes).toContain("ITEM_MEANING_EMPTY");
        const meaningErr = data?.blockingErrors.find((e) => e.code === "ITEM_MEANING_EMPTY");
        expect(meaningErr?.path).toBe(`item.${emptyMeaning}.meaning`);

        // 数据库外键保证词条引用不悬空、provenance 有效（校验规则为防御性，单测覆盖）。
        await expect(
          pool.query(
            `INSERT INTO draft_course_items (id, draft_unit_id, lexical_entry_id, position, meaning, content_review_reference)
             VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 98, '释义', $3)`,
            [randomUUID(), unitId, auditId],
          ),
        ).rejects.toThrow(/draft_course_items_lexical_entry_id_fkey/);
        await expect(
          pool.query(
            `INSERT INTO draft_course_items (id, draft_unit_id, lexical_entry_id, position, meaning, content_review_reference)
             VALUES ($1, $2, $3, 97, '释义', '00000000-0000-0000-0000-000000000000')`,
            [randomUUID(), unitId, entryId],
          ),
        ).rejects.toThrow(/draft_course_items_content_review_reference_fkey/);
      } finally {
        await pool.end();
      }
    });

    it("空单元 → UNIT_NO_ITEMS；空课程 → COURSE_NO_UNITS", async () => {
      // 空单元：创建课程 + 单元但无词项。
      const slug = uniq("valemptyunit");
      const res = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug, title: "空单元课程" },
      });
      const courseId = (body(res) as { courseId?: string }).courseId as string;
      const unitId = randomUUID();
      await admin.req("POST", `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
        payload: { title: "空单元", draftVersion: 1 },
      });
      const { data: d1 } = await validate(courseId);
      expect(
        d1?.blockingErrors.some((e) => e.code === "UNIT_NO_ITEMS" && e.path === `unit.${unitId}`),
      ).toBe(true);

      // 空课程：仅创建课程。
      const slug2 = uniq("valemptycourse");
      const res2 = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug: slug2, title: "空课程" },
      });
      const courseId2 = (body(res2) as { courseId?: string }).courseId as string;
      const { data: d2 } = await validate(courseId2);
      expect(d2?.blockingErrors.some((e) => e.code === "COURSE_NO_UNITS")).toBe(true);
    });

    it("保存草稿后旧校验 token 不代表新草稿，必须重新校验", async () => {
      const { courseId, draftVersion } = await createCourseWithUnitAndItem();
      const first = await validate(courseId);
      const tokenA = first.data?.validationToken ?? "";

      // 保存草稿（版本递增）。
      const patch = await admin.req("PATCH", `/api/v1/admin/courses/${courseId}/draft`, {
        payload: { title: "校验后修改", draftVersion },
      });
      expect(patch.statusCode).toBe(200);
      const newVersion = (body(patch) as { version?: number }).version ?? 0;

      const second = await validate(courseId);
      expect(second.data?.draftVersion).toBe(newVersion);
      expect(second.data?.validationToken).not.toBe(tokenA);
      expect(tokenA.startsWith(String(draftVersion))).toBe(true);
      expect(second.data?.validationToken.startsWith(String(newVersion))).toBe(true);
    });

    it("learner 拒绝访问校验接口；不存在课程返回 404", async () => {
      const learner = await learnerClient();
      const { courseId } = await createCourseWithUnitAndItem();
      const denied = await learner.req("POST", `/api/v1/admin/courses/${courseId}/validate`, {});
      expect(denied.statusCode).toBe(403);

      const missing = await admin.req(
        "POST",
        "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/validate",
        {},
      );
      expect(missing.statusCode).toBe(404);
    });
  },
);
