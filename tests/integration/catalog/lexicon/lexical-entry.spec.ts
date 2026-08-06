// 词条管理集成测试：管理员手工创建/搜索/详情、重复警告与冲突、角色拒绝、审计与来源幂等。
// 需要运行中的 PostgreSQL（compose 的 db 服务）。连接不可用时整个 describe 跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
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

interface CreatePayload {
  canonicalSpelling: string;
  partOfSpeech?: string;
  pronunciation?: string;
  senses?: { meaning: string; example?: string }[];
  sourceNote?: string;
  confirmDuplicate?: boolean;
}

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "admin lexical entries",
  () => {
    let app: App;
    let admin: Client;

    beforeAll(async () => {
      await migrate(config, MIGRATIONS_DIR);
      const adminPool = createPool({ ...config, max: 1 });
      const ps = new PasswordService();
      const hash = await ps.hashPassword("lex-admin-password-123");
      await adminPool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
         VALUES ('lex-itest-admin', 'Lex ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)
         ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'`,
        [hash],
      );
      await adminPool.end();

      app = await createApp();
      await app.init();
      admin = makeClient(app);
      const login = await admin.req("POST", "/api/v1/auth/login", {
        payload: { username: "lex-itest-admin", password: "lex-admin-password-123" },
      });
      expect(login.statusCode).toBe(200);
    });

    afterAll(async () => {
      await app.close();
    });

    async function createLearnerClient(): Promise<Client> {
      const username = `lex-learner-${randomBytes(3).toString("hex")}`;
      const res = await admin.req("POST", "/api/v1/admin/users", {
        headers: { "idempotency-key": `lex-create-${username}` },
        payload: {
          username,
          displayName: "词条测试学习者",
          timezone: "Asia/Shanghai",
          dailyBudgetMinutes: 10,
        },
      });
      expect(res.statusCode).toBe(201);
      const otp = (res.json() as { oneTimePassword?: string }).oneTimePassword;
      expect(otp).toBeTruthy();
      const client = makeClient(app);
      await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
      await client.req("POST", "/api/v1/auth/change-password", {
        payload: { currentPassword: otp, newPassword: "lex-learner-pass-12345" },
      });
      return client;
    }

    function createEntry(payload: CreatePayload): Promise<Res> {
      return admin.req("POST", "/api/v1/admin/lexical-entries", { payload });
    }

    function body(res: Res): Record<string, unknown> {
      return res.json() as Record<string, unknown>;
    }

    // 每次运行使用唯一拼写，保证测试在共享开发库上可重复执行。
    function uniq(prefix: string): string {
      return `${prefix}-${randomBytes(4).toString("hex")}`;
    }

    it("管理员创建手工词条：返回详情、写入来源与审计，且审计摘要不含大段输入", async () => {
      const spelling = uniq("abandon");
      const res = await createEntry({
        canonicalSpelling: spelling,
        partOfSpeech: "verb",
        pronunciation: "/əˈbændən/",
        senses: [{ meaning: "放弃", example: "Don't abandon your plan." }],
        sourceNote: "手工录入的测试来源说明，不应出现在审计摘要里",
      });
      expect(res.statusCode).toBe(201);
      const entry = body(res) as {
        id: string;
        canonicalSpelling: string;
        normalizedSpelling: string;
        sourceStatus: string;
        referenceCount: number;
        provenance: { sourceType: string; sourceNote: string | null }[];
      };
      expect(entry.canonicalSpelling).toBe(spelling);
      expect(entry.normalizedSpelling).toBe(spelling.toLowerCase());
      expect(entry.sourceStatus).toBe("manual");
      expect(entry.referenceCount).toBe(0);
      expect(entry.provenance[0]?.sourceType).toBe("manual");
      expect(entry.provenance[0]?.sourceNote).toBe("手工录入的测试来源说明，不应出现在审计摘要里");

      const pool = createPool({ ...config, max: 1 });
      try {
        const entryRows = await pool.query("SELECT 1 FROM lexical_entries WHERE id = $1", [
          entry.id,
        ]);
        expect(entryRows.rowCount).toBe(1);
        const sourceRows = await pool.query(
          "SELECT 1 FROM lexical_sources WHERE lexical_entry_id = $1 AND source_type = 'manual'",
          [entry.id],
        );
        expect(sourceRows.rowCount).toBe(1);
        const auditRows = await pool.query<{ after_summary: unknown }>(
          "SELECT after_summary FROM audit_events WHERE target_type = 'lexical_entry' AND target_id = $1",
          [entry.id],
        );
        expect(auditRows.rowCount).toBeGreaterThanOrEqual(1);
        const summaryText = JSON.stringify(auditRows.rows[0]?.after_summary ?? {});
        expect(summaryText).toContain(spelling);
        // 审计摘要不含来源说明或释义这类大段未脱敏输入。
        expect(summaryText).not.toContain("手工录入的测试来源说明");
        expect(summaryText).not.toContain("放弃");
      } finally {
        await pool.end();
      }
    });

    it("未登录与学习者访问管理词条接口被拒绝", async () => {
      const anon = await app.inject({ method: "GET", url: "/api/v1/admin/lexical-entries" });
      expect(anon.statusCode).toBe(401);

      const learner = await createLearnerClient();
      const list = await learner.req("GET", "/api/v1/admin/lexical-entries", {});
      expect(list.statusCode).toBe(403);
      const create = await learner.req("POST", "/api/v1/admin/lexical-entries", {
        payload: { canonicalSpelling: "hack", confirmDuplicate: false },
      });
      expect(create.statusCode).toBe(403);
    });

    it("字段校验失败返回 422 fieldErrors，非法词性/空拼写被拒绝", async () => {
      const empty = await createEntry({ canonicalSpelling: "   ", confirmDuplicate: false });
      expect(empty.statusCode).toBe(422);
      expect(body(empty).error).toBeDefined();

      const noLetter = await createEntry({ canonicalSpelling: "123", confirmDuplicate: false });
      expect(noLetter.statusCode).toBe(422);
      const noLetterErr = body(noLetter) as {
        error: { fieldErrors?: { path: string }[] };
      };
      expect(noLetterErr.error.fieldErrors?.some((f) => f.path === "canonicalSpelling")).toBe(true);

      const badPos = await createEntry({
        canonicalSpelling: "test",
        partOfSpeech: "not-a-pos",
        confirmDuplicate: false,
      });
      expect(badPos.statusCode).toBe(422);
    });

    it("完全相同词条返回 DUPLICATE_ENTRY 冲突，不落库", async () => {
      const spelling = uniq("dup-exact");
      const first = await createEntry({ canonicalSpelling: spelling, confirmDuplicate: false });
      expect(first.statusCode).toBe(201);

      const dup = await createEntry({
        canonicalSpelling: spelling,
        confirmDuplicate: true,
      });
      expect(dup.statusCode).toBe(409);
      const err = body(dup) as { error: { code?: string; duplicateCandidates?: { id: string }[] } };
      expect(err.error.code).toBe("DUPLICATE_ENTRY");
      expect(err.error.duplicateCandidates?.length).toBeGreaterThanOrEqual(1);

      const pool = createPool({ ...config, max: 1 });
      try {
        const rows = await pool.query(
          "SELECT 1 FROM lexical_entries WHERE normalized_spelling = $1",
          [spelling],
        );
        expect(rows.rowCount).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it("同形异义候选返回 DUPLICATE_WARNING，未确认不落库，确认后创建第二个稳定词条", async () => {
      const base = uniq("homo");
      const variant = base.charAt(0).toUpperCase() + base.slice(1);
      const first = await createEntry({
        canonicalSpelling: base,
        partOfSpeech: "noun",
        confirmDuplicate: false,
      });
      expect(first.statusCode).toBe(201);

      // 不同展示拼写（大小写不同）→ 重复警告，不静默落库。
      const warning = await createEntry({ canonicalSpelling: variant, confirmDuplicate: false });
      expect(warning.statusCode).toBe(409);
      const warnErr = body(warning) as {
        error: { code?: string; duplicateCandidates?: { canonicalSpelling: string }[] };
      };
      expect(warnErr.error.code).toBe("DUPLICATE_WARNING");
      expect(warnErr.error.duplicateCandidates?.some((c) => c.canonicalSpelling === base)).toBe(
        true,
      );

      const pool = createPool({ ...config, max: 1 });
      try {
        const before = await pool.query(
          "SELECT 1 FROM lexical_entries WHERE normalized_spelling = $1",
          [base.toLowerCase()],
        );
        expect(before.rowCount).toBe(1);

        // 显式确认后允许创建同形异义词条。
        const confirmed = await createEntry({
          canonicalSpelling: variant,
          confirmDuplicate: true,
        });
        expect(confirmed.statusCode).toBe(201);
        const confirmedId = (body(confirmed) as { id?: string }).id;
        expect(confirmedId).toBeTruthy();

        const after = await pool.query(
          "SELECT 1 FROM lexical_entries WHERE normalized_spelling = $1",
          [base.toLowerCase()],
        );
        expect(after.rowCount).toBe(2);
        const audit = await pool.query(
          "SELECT 1 FROM audit_events WHERE target_type = 'lexical_entry' AND target_id = $1 AND after_summary->>'duplicateConfirmed' = 'true'",
          [confirmedId],
        );
        expect(audit.rowCount).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it("列表搜索按拼写命中，键集分页游标稳定", async () => {
      // 清空既有测试数据影响：只按前缀命名避免与其它测试冲突。
      const prefix = `page-${randomBytes(3).toString("hex")}`;
      for (const i of [1, 2, 3]) {
        const res = await createEntry({
          canonicalSpelling: `${prefix}-word-${i}`,
          confirmDuplicate: false,
        });
        expect(res.statusCode).toBe(201);
      }

      const search = await admin.req(
        "GET",
        `/api/v1/admin/lexical-entries?q=${encodeURIComponent(prefix)}&limit=2`,
        {},
      );
      expect(search.statusCode).toBe(200);
      const page1 = body(search) as {
        items: { id: string; canonicalSpelling: string; sourceStatus: string }[];
        page: { cursor: string | null; hasMore: boolean };
      };
      expect(page1.items.length).toBe(2);
      expect(page1.items.every((i) => i.canonicalSpelling.startsWith(prefix))).toBe(true);
      expect(page1.items.every((i) => i.sourceStatus === "manual")).toBe(true);
      expect(page1.page.hasMore).toBe(true);
      expect(page1.page.cursor).toBeTruthy();

      const page2 = await admin.req(
        "GET",
        `/api/v1/admin/lexical-entries?q=${encodeURIComponent(prefix)}&limit=2&cursor=${encodeURIComponent(
          page1.page.cursor ?? "",
        )}`,
        {},
      );
      expect(page2.statusCode).toBe(200);
      const page2Body = body(page2) as {
        items: { id: string }[];
        page: { cursor: string | null; hasMore: boolean };
      };
      expect(page2Body.items.length).toBe(1);
      expect(page2Body.page.hasMore).toBe(false);
      expect(page2Body.page.cursor).toBeNull();

      // 两页无重叠。
      const ids = new Set([...page1.items.map((i) => i.id), ...page2Body.items.map((i) => i.id)]);
      expect(ids.size).toBe(3);
    });

    it("无效游标返回结构化 422：非法 base64/JSON、缺字段、非法 UUID", async () => {
      const encode = (value: unknown): string =>
        Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

      const cases = [
        { name: "非法 base64", cursor: "not-base64!!!" },
        { name: "JSON 解析失败", cursor: Buffer.from("{oops", "utf8").toString("base64url") },
        { name: "缺少 id 字段", cursor: encode({ normalizedSpelling: "abandon" }) },
        { name: "缺少拼写字段", cursor: encode({ id: "00000000-0000-0000-0000-000000000000" }) },
        {
          name: "id 非法 UUID",
          cursor: encode({ normalizedSpelling: "abandon", id: "not-a-uuid" }),
        },
      ];
      for (const c of cases) {
        const res = await admin.req(
          "GET",
          `/api/v1/admin/lexical-entries?cursor=${encodeURIComponent(c.cursor)}`,
          {},
        );
        expect(res.statusCode, c.name).toBe(422);
        const err = body(res) as {
          error: { fieldErrors?: { path: string }[]; code?: string };
        };
        expect(err.error.code).toBe("VALIDATION_FAILED");
        expect(err.error.fieldErrors?.some((f) => f.path === "cursor")).toBe(true);
      }
    });

    it("详情返回词条事实、来源摘要与最近操作", async () => {
      const created = await createEntry({
        canonicalSpelling: `detail-word-${randomBytes(3).toString("hex")}`,
        partOfSpeech: "noun",
        confirmDuplicate: false,
      });
      expect(created.statusCode).toBe(201);
      const id = (body(created) as { id?: string }).id;
      expect(id).toBeTruthy();

      const detail = await admin.req("GET", `/api/v1/admin/lexical-entries/${id}`, {});
      expect(detail.statusCode).toBe(200);
      const d = body(detail) as {
        id: string;
        canonicalSpelling: string;
        provenance: unknown[];
        recentOperations: { action: string }[];
        referenceCount: number;
      };
      expect(d.id).toBe(id);
      expect(d.provenance.length).toBe(1);
      expect(d.recentOperations.some((o) => o.action === "admin.lexical_entry.create")).toBe(true);
      expect(d.referenceCount).toBe(0);
    });

    it("不存在词条详情返回 404", async () => {
      const res = await admin.req(
        "GET",
        "/api/v1/admin/lexical-entries/00000000-0000-0000-0000-000000000000",
        {},
      );
      expect(res.statusCode).toBe(404);
    });

    it("manual 来源按 (词条, 类型, 内容哈希) 幂等：重复插入不产生新行", async () => {
      const created = await createEntry({
        canonicalSpelling: `idem-word-${randomBytes(3).toString("hex")}`,
        confirmDuplicate: false,
      });
      expect(created.statusCode).toBe(201);
      const id = (body(created) as { id?: string }).id;

      const pool = createPool({ ...config, max: 1 });
      try {
        // 模拟并发/重放：相同来源内容哈希只应有一条来源记录；created_by 非空从原行复制。
        await pool.query(
          `INSERT INTO lexical_sources (lexical_entry_id, source_type, source_note, content_hash, created_by)
           SELECT lexical_entry_id, 'manual', NULL, content_hash, created_by
           FROM lexical_sources WHERE lexical_entry_id = $1
           ON CONFLICT (lexical_entry_id, source_type, content_hash) DO NOTHING`,
          [id],
        );
        const rows = await pool.query("SELECT 1 FROM lexical_sources WHERE lexical_entry_id = $1", [
          id,
        ]);
        expect(rows.rowCount).toBe(1);
        // created_by 必须非空（manual 来源由管理员创建）。
        const creator = await pool.query(
          "SELECT created_by FROM lexical_sources WHERE lexical_entry_id = $1",
          [id],
        );
        expect(creator.rows[0]?.created_by).toBeTruthy();
      } finally {
        await pool.end();
      }
    });

    it("重复警告与完全重复冲突都写入安全审计记录，显式确认创建带 duplicateConfirmed", async () => {
      const base = uniq("audit-dup");
      const variant = base.charAt(0).toUpperCase() + base.slice(1);
      const first = await createEntry({ canonicalSpelling: base, confirmDuplicate: false });
      expect(first.statusCode).toBe(201);

      const warn = await createEntry({ canonicalSpelling: variant, confirmDuplicate: false });
      expect(warn.statusCode).toBe(409);
      const exact = await createEntry({ canonicalSpelling: base, confirmDuplicate: false });
      expect(exact.statusCode).toBe(409);
      const confirmed = await createEntry({ canonicalSpelling: variant, confirmDuplicate: true });
      expect(confirmed.statusCode).toBe(201);

      const pool = createPool({ ...config, max: 1 });
      try {
        const warningRows = await pool.query(
          `SELECT after_summary FROM audit_events
           WHERE action = 'admin.lexical_entry.duplicate_warning'`,
        );
        expect(warningRows.rowCount).toBeGreaterThanOrEqual(1);
        const exactRows = await pool.query(
          `SELECT after_summary FROM audit_events
           WHERE action = 'admin.lexical_entry.duplicate_exact'`,
        );
        expect(exactRows.rowCount).toBeGreaterThanOrEqual(1);
        const confirmedRows = await pool.query(
          `SELECT after_summary FROM audit_events
           WHERE action = 'admin.lexical_entry.create'
             AND after_summary->>'duplicateConfirmed' = 'true'`,
        );
        expect(confirmedRows.rowCount).toBeGreaterThanOrEqual(1);

        // 安全：审计摘要不含密码/secret/token 等敏感字样。
        const allText = JSON.stringify(warningRows.rows.concat(exactRows.rows, confirmedRows.rows));
        expect(allText.toLowerCase()).not.toMatch(/password|secret|token/);
      } finally {
        await pool.end();
      }
    });

    it("并发创建相同 canonicalSpelling：至多一个成功，不会产生两个完全相同词条", async () => {
      const spelling = uniq("race");
      const [r1, r2] = await Promise.all([
        createEntry({ canonicalSpelling: spelling, confirmDuplicate: false }),
        createEntry({ canonicalSpelling: spelling, confirmDuplicate: false }),
      ]);
      const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const conflict = r1.statusCode === 409 ? r1 : r2;
      const err = body(conflict) as { error: { code?: string } };
      expect(err.error.code).toBe("DUPLICATE_ENTRY");

      const pool = createPool({ ...config, max: 1 });
      try {
        const rows = await pool.query(
          "SELECT 1 FROM lexical_entries WHERE canonical_spelling = $1",
          [spelling],
        );
        expect(rows.rowCount).toBe(1);
      } finally {
        await pool.end();
      }
    });
  },
);
