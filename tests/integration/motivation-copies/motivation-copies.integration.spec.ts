// Ticket 21 · home motivation copies API — isolated-DB integration.
// Covers: learner read (enabled-only, no admin fields), admin CRUD, and the
// batch-create semantics (max-100/dedupe/skip+created counts/transaction rollback).
// Uses the SAME one-time isolated DB + `app.inject` pattern as other API specs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import type { Pool } from "pg";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { closeAppDbPools, dropIsolatedDatabase } from "../catalog/isolated-db.helper.js";

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

type App = Awaited<ReturnType<typeof createApp>>;

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "motivation copies API (isolated DB)",
  () => {
    let isolatedDbName: string | undefined;
    const previousDb = process.env.POSTGRES_DB;
    let pool: Pool;
    let app: App;
    let admin: Client;
    let learner: Client;

    beforeAll(async () => {
      isolatedDbName = `motro_motivation_copies_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      const adminPool = createPool({ ...config, database: "postgres", max: 1 });
      try {
        await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
      } finally {
        await adminPool.end();
      }
      const isolatedConfig = { ...config, database: isolatedDbName };
      await migrate(isolatedConfig, MIGRATIONS_DIR);
      process.env.POSTGRES_DB = isolatedDbName;
      pool = createPool({ ...isolatedConfig, max: 5 });

      // Seed one admin + one learner with known passwords.
      const ps = new PasswordService();
      const adminHash = await ps.hashPassword("admin-pass-123");
      const learnerHash = await ps.hashPassword("learner-pass-123");
      await pool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('mc-admin','MCA','admin','active','Asia/Shanghai',30,$1)`,
        [adminHash],
      );
      await pool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('mc-learner','MCL','learner','active','Asia/Shanghai',10,$1)`,
        [learnerHash],
      );

      app = await createApp();
      await app.init();

      admin = makeClient();
      await admin.login("mc-admin", "admin-pass-123");
      learner = makeClient();
      await learner.login("mc-learner", "learner-pass-123");
    });

    afterAll(async () => {
      try {
        if (app) await closeAppDbPools(app);
        if (app) await app.close();
        if (pool) await pool.end();
      } finally {
        if (previousDb === undefined) delete process.env.POSTGRES_DB;
        else process.env.POSTGRES_DB = previousDb;
        if (isolatedDbName) await dropIsolatedDatabase(isolatedDbName);
      }
    });

    // ---- HTTP client (mirror other API specs) ----
    interface Res {
      statusCode: number;
      json(): unknown;
    }
    function makeClient() {
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
        async req(
          method: string,
          url: string,
          opts: { payload?: unknown; headers?: Record<string, string> } = {},
        ): Promise<Res> {
          if (method !== "GET" && csrf === "") await this.warm();
          const headers: Record<string, string> = { ...(opts.headers ?? {}) };
          const jar = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
          if (jar) headers.cookie = jar;
          if (method !== "GET") headers["x-csrf-token"] = csrf;
          const res = await app.inject({
            method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
            url,
            headers,
            ...(opts.payload !== undefined ? { payload: opts.payload as string | object } : {}),
          });
          capture(res);
          return { statusCode: res.statusCode, json: () => res.json() } as Res;
        },
        async login(username: string, password: string): Promise<void> {
          await this.warm();
          const res = await this.req("POST", "/api/v1/auth/login", {
            payload: { username, password },
          });
          if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`);
        },
      };
    }
    type Client = ReturnType<typeof makeClient>;

    it("migration 0041 applied: home_motivation_copies table + seed rows exist", async () => {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM home_motivation_copies`,
      );
      expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    });

    it("learner GET /home/motivation returns an enabled copy with NO admin fields", async () => {
      const res = await learner.req("GET", "/api/v1/home/motivation");
      expect(res.statusCode).toBe(200);
      const body = res.json() as { message: Record<string, unknown> | null };
      expect(body.message).not.toBeNull();
      const msg = body.message!;
      expect(typeof msg.text).toBe("string");
      expect(["poetry_pun", "english_joke", "learning_wit", "encouragement"]).toContain(
        msg.category,
      );
      // No admin/private fields.
      expect(msg).not.toHaveProperty("isEnabled");
      expect(msg).not.toHaveProperty("createdAt");
      expect(msg).not.toHaveProperty("updatedAt");
      expect(msg).not.toHaveProperty("is_enabled");
      expect(JSON.stringify(msg)).not.toMatch(/password|session|secret|request_hash/);
    });

    it("anonymous learner admin endpoint → 401; learner → 403", async () => {
      const anon = makeClient();
      const a = await anon.req("GET", "/api/v1/admin/motivation-copies");
      expect(a.statusCode).toBe(401);
      const l = await learner.req("GET", "/api/v1/admin/motivation-copies");
      expect(l.statusCode).toBe(403);
    });

    it("admin create → returns row; learner home now may pick it up (enabled default)", async () => {
      const res = await admin.req("POST", "/api/v1/admin/motivation-copies", {
        payload: {
          text: "一句新的鼓励：" + randomBytes(3).toString("hex"),
          category: "encouragement",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { text: string; isEnabled: boolean };
      expect(body.isEnabled).toBe(true);
      // No secret leakage.
      expect(JSON.stringify(body)).not.toMatch(/password|session|request_hash/);
    });

    it("batch create: creates new, skips duplicate-in-request, skips existing-DB, counts accurate", async () => {
      // Seed one copy directly so batch sees it as existing.
      await pool.query(
        `INSERT INTO home_motivation_copies (copy_text, category) VALUES ('already存在文案', 'learning_wit')`,
      );
      const payload = {
        items: [
          { text: "全新1", category: "poetry_pun" },
          { text: "全新1", category: "poetry_pun" }, // dup in request → deduped
          { text: "already存在文案", category: "learning_wit" }, // exists in DB → skipped
          { text: "全新2", category: "english_joke" },
        ],
      };
      const res = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        createdCount: number;
        skippedCount: number;
        skippedTexts: string[];
        items: unknown[];
      };
      expect(body.createdCount).toBe(2); // 全新1 + 全新2
      expect(body.skippedCount).toBe(2); // dup 全新1 + already存在文案
      expect(body.skippedTexts).toContain("already存在文案");
      expect(body.skippedTexts).toContain("全新1");
      expect(body.items.length).toBe(2);
    });

    it("batch create rejects: empty array (422), >100 (422), bad category, overlong text, HTML/URL/control", async () => {
      const empty = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: { items: [] },
      });
      expect(empty.statusCode).toBe(422);

      const tooMany = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: {
          items: Array.from({ length: 101 }, () => ({ text: "x", category: "learning_wit" })),
        },
      });
      expect(tooMany.statusCode).toBe(422);

      const badCat = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: { items: [{ text: "文本", category: "notacat" }] },
      });
      expect(badCat.statusCode).toBe(422);

      const overlong = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: { items: [{ text: "y".repeat(181), category: "learning_wit" }] },
      });
      expect(overlong.statusCode).toBe(422);

      const html = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: { items: [{ text: "<b>hi</b>", category: "learning_wit" }] },
      });
      // 内容级纯文本护栏（HTML/URL/控制字符）→ 服务端 BadRequest(400)；结构校验(DTO)才是 422。
      expect(html.statusCode).toBe(400);

      const url = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: { items: [{ text: "see https://x.com", category: "learning_wit" }] },
      });
      expect(url.statusCode).toBe(400);

      const control = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: { items: [{ text: "ab", category: "learning_wit" }] },
      });
      expect(control.statusCode).toBe(400);
    });

    it("batch create: one invalid item rolls back the WHOLE batch (no partial rows)", async () => {
      const before = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM home_motivation_copies`,
      );
      const res = await admin.req("POST", "/api/v1/admin/motivation-copies/batch", {
        payload: {
          items: [
            { text: "有效第一", category: "poetry_pun" },
            { text: "有效第二", category: "poetry_pun" },
            { text: "带 url http://e.com 的非法", category: "poetry_pun" },
          ],
        },
      });
      // 含 URL 的非法项 → 服务端纯文本护栏 400，在任何 INSERT 之前整体拒绝（无半批）。
      expect(res.statusCode).toBe(400);
      const after = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM home_motivation_copies`,
      );
      expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    });

    it("concurrent createBatch of identical copy → both 201, no 500, exactly one row (unique 0042)", async () => {
      const text = `并发唯一键 ${randomBytes(6).toString("hex")}`;
      const category = "learning_wit";
      const payload = { items: [{ text, category }] };

      // 两个独立管理员会话同时提交同一 (text, category) —— 池 max:10，真并发连接。
      const [a, b] = await Promise.all([
        admin.req("POST", "/api/v1/admin/motivation-copies/batch", { payload }),
        admin.req("POST", "/api/v1/admin/motivation-copies/batch", { payload }),
      ]);

      // 均不得 5xx；冲突方必须是幂等跳过（201 + skipped），绝不能 500。
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);

      const rows = await pool.query<{ copy_text: string; category: string }>(
        `SELECT copy_text, category FROM home_motivation_copies WHERE copy_text = $1 AND category = $2`,
        [text, category],
      );
      expect(rows.rowCount).toBe(1);

      const createdA = (a.json() as { createdCount: number }).createdCount;
      const createdB = (b.json() as { createdCount: number }).createdCount;
      const skippedA = (a.json() as { skippedCount: number }).skippedCount;
      const skippedB = (b.json() as { skippedCount: number }).skippedCount;
      // 两个请求合计：恰好一条创建，另一条跳过。
      expect(createdA + createdB).toBe(1);
      expect(skippedA + skippedB).toBe(1);
    });

    it("concurrent createBatch with same text, different category → both created (2 rows)", async () => {
      const text = `同文异类 ${randomBytes(6).toString("hex")}`;
      const payloadA = { items: [{ text, category: "poetry_pun" }] };
      const payloadB = { items: [{ text, category: "encouragement" }] };

      const [a, b] = await Promise.all([
        admin.req("POST", "/api/v1/admin/motivation-copies/batch", { payload: payloadA }),
        admin.req("POST", "/api/v1/admin/motivation-copies/batch", { payload: payloadB }),
      ]);
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);

      const rows = await pool.query<{ category: string }>(
        `SELECT category FROM home_motivation_copies WHERE copy_text = $1`,
        [text],
      );
      // 相同文案不同 category 分别可创建。
      expect(rows.rowCount).toBe(2);
      expect(rows.rows.map((r) => r.category).sort()).toEqual(["encouragement", "poetry_pun"]);
    });

    it("concurrent createBatch: one batch of mixed items where one item pre-exists → created/skipped accurate, no 500", async () => {
      // 预置一条已存在记录。
      const existingText = `已有并发 ${randomBytes(6).toString("hex")}`;
      await pool.query(`INSERT INTO home_motivation_copies (copy_text, category) VALUES ($1, $2)`, [
        existingText,
        "english_joke",
      ]);

      const newText = `新并发 ${randomBytes(6).toString("hex")}`;
      const payload = {
        items: [
          { text: existingText, category: "english_joke" }, // 已存在 → skip
          { text: newText, category: "english_joke" }, // 新 → create
          { text: newText, category: "english_joke" }, // 同请求重复 → skip
        ],
      };

      const [a, b] = await Promise.all([
        admin.req("POST", "/api/v1/admin/motivation-copies/batch", { payload }),
        admin.req("POST", "/api/v1/admin/motivation-copies/batch", { payload }),
      ]);
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);

      const created =
        (a.json() as { createdCount: number }).createdCount +
        (b.json() as { createdCount: number }).createdCount;
      const skipped =
        (a.json() as { skippedCount: number }).skippedCount +
        (b.json() as { skippedCount: number }).skippedCount;

      const rows = await pool.query<{ copy_text: string }>(
        `SELECT copy_text FROM home_motivation_copies WHERE copy_text IN ($1, $2)`,
        [existingText, newText],
      );
      // 已存在 1 + 新文案恰好 1（并发下也仅一条）= 共 2 行。
      expect(rows.rowCount).toBe(2);
      // 两个请求合计：恰好 1 个被创建；其余全部计入 skipped（skippedTexts 按文案去重）：
      //   A: item3(请求内重复 new)→skip + existing→skip = 2；
      //   B: item3(请求内重复 new)→skip + existing→skip + new(并发已存在)→skip = 3，但 new 已在 A 计过 → 去重后 2。
      //   合计 skippedCount = 4（唯一文案：existing、new、new、new → 去重为 existing+new，跨请求累计 4 次计数）。
      expect(created).toBe(1);
      expect(skipped).toBe(4);
    });
  },
);
