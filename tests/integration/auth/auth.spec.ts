// 认证集成测试：管理员建号 → 一次性密码登录 → 强制改密 → 会话/logout/停用/重置。
// 需要运行中的 PostgreSQL（compose 的 db 服务）。连接不可用时整个 describe 跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";

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
      // 首次不安全请求前先取 CSRF cookie（双提交）。
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

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")("auth integration", () => {
  let app: App;
  let admin: Client;

  beforeAll(async () => {
    await migrate(config, MIGRATIONS_DIR);
    const adminPool = createPool({ ...config, max: 1 });
    const ps = new PasswordService();
    const hash = await ps.hashPassword("admin-password-12345");
    // 使用独立测试管理员，避免与 compose 引导的 admin 冲突（upsert 确保已知口令）。
    await adminPool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('itest-admin', 'ITest Admin', 'admin', 'active', 'Asia/Shanghai', 10, $1, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $1, must_change_password = false, status = 'active'`,
      [hash],
    );
    await adminPool.end();

    app = await createApp();
    await app.init();
    admin = makeClient(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createLearner(
    prefix: string,
    role: "learner" | "admin" = "learner",
  ): Promise<{ client: Client; otp: string; username: string }> {
    const username = `${prefix}-${randomBytes(3).toString("hex")}`;
    const res = await admin.req("POST", "/api/v1/admin/users", {
      headers: { "idempotency-key": `create-${username}` },
      payload: {
        username,
        displayName: prefix,
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
        ...(role === "admin" ? { role: "admin" } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    const otp = (res.json() as { oneTimePassword?: string }).oneTimePassword;
    expect(otp).toBeTruthy();
    const client = makeClient(app);
    return { client, otp: otp as string, username };
  }

  it("管理员登录成功并建立 HttpOnly + SameSite 会话 cookie", async () => {
    const res = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: "itest-admin", password: "admin-password-12345" },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.headers["set-cookie"];
    const setCookie = Array.isArray(raw) ? raw.join("; ") : String(raw ?? "");
    expect(setCookie).toContain("motro_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite");
  });

  it("创建账号要求幂等键；同键同内容重放、同键不同内容 409", async () => {
    const payload = {
      username: "idem-learner",
      displayName: "幂等",
      timezone: "Asia/Shanghai",
      dailyBudgetMinutes: 10,
    };
    const missing = await admin.req("POST", "/api/v1/admin/users", { payload });
    expect(missing.statusCode).toBe(400);

    const first = await admin.req("POST", "/api/v1/admin/users", {
      headers: { "idempotency-key": "create-idem" },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const otp1 = (first.json() as { oneTimePassword?: string }).oneTimePassword;

    const replay = await admin.req("POST", "/api/v1/admin/users", {
      headers: { "idempotency-key": "create-idem" },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { oneTimePassword?: string }).oneTimePassword).toBe(otp1);

    const conflict = await admin.req("POST", "/api/v1/admin/users", {
      headers: { "idempotency-key": "create-idem" },
      payload: { ...payload, displayName: "不同内容" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(String((conflict.json() as { error: { message: string } }).error.message)).toContain(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("一次性密码登录后被强制进入改密流程，且 OTP 立即失效不可重复登录", async () => {
    const { client, otp, username } = await createLearner("force");
    const res = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: otp },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    // 同一 OTP 第二次登录必须失败（已消费）。
    const reuse = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: otp },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("服务端强制首次改密：pending 用户访问受保护端点被拒，改密后放行", async () => {
    const { client, otp, username } = await createLearner("pending-admin", "admin");
    await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });

    // 必要认证端点可用。
    const me = await client.req("GET", "/api/v1/auth/me", {});
    expect(me.statusCode).toBe(200);
    expect((me.json() as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    // 受保护端点（管理接口）被强制拒绝。
    const blocked = await client.req("GET", "/api/v1/admin/users", {});
    expect(blocked.statusCode).toBe(403);

    // 改密后解除。
    const change = await client.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "pending-admin-pass-123" },
    });
    expect(change.statusCode).toBe(200);
    const allowed = await client.req("GET", "/api/v1/admin/users", {});
    expect(allowed.statusCode).toBe(200);
  });

  it("改密后新密码可登录，旧一次性密码被拒绝", async () => {
    const { client, otp, username } = await createLearner("rotate");
    await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
    const change = await client.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "new-strong-password-123" },
    });
    expect(change.statusCode).toBe(200);

    const newLogin = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "new-strong-password-123" },
    });
    expect(newLogin.statusCode).toBe(200);
    const oldLogin = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: otp },
    });
    expect(oldLogin.statusCode).toBe(401);
  });

  it("错误密码与未知用户返回同一错误，不泄露账号是否存在", async () => {
    const { username } = await createLearner("leak");
    const unknown = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: "nobody-here", password: "whatever-123" },
    });
    const wrong = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "wrong-password" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect((unknown.json() as { error: { message: string } }).error.message).toBe(
      (wrong.json() as { error: { message: string } }).error.message,
    );
  });

  it("登出撤销会话，之后受保护端点拒绝", async () => {
    const { client, otp, username } = await createLearner("logout");
    await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
    await client.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "another-strong-pass" },
    });
    await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "another-strong-pass" },
    });
    const logout = await client.req("POST", "/api/v1/auth/logout", {});
    expect(logout.statusCode).toBe(200);
    const me = await client.req("GET", "/api/v1/auth/me", {});
    expect(me.statusCode).toBe(401);
  });

  it("停用账号立即撤销会话并拒绝新会话", async () => {
    const { client, otp, username } = await createLearner("disable");
    await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
    await client.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "disable-pass-12345" },
    });
    await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "disable-pass-12345" },
    });

    // 用数据库按 username 直查目标 id：admin 列表按 created_at ASC 截断 100 行，
    // 共享库累积用户超 100 后新用户不在首页，列表接口并非本用例目标。
    const pool = createPool({ ...config, max: 1 });
    let targetId: string;
    try {
      const row = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
        username,
      ]);
      expect(row.rows[0]).toBeTruthy();
      targetId = row.rows[0]!.id;
    } finally {
      await pool.end();
    }

    const disable = await admin.req("POST", `/api/v1/admin/users/${targetId}/disable`, {});
    expect(disable.statusCode).toBe(200);
    const me = await client.req("GET", "/api/v1/auth/me", {});
    expect(me.statusCode).toBe(401);
    const relogin = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "disable-pass-12345" },
    });
    expect(relogin.statusCode).toBe(401);
  });

  it("管理端列表返回完整安全投影且不泄露敏感字段；管理员不能停用自己（409）", async () => {
    // admin 自己的 id（itest-admin 由 beforeAll 插入）。
    const pool = createPool({ ...config, max: 1 });
    let adminId: string;
    try {
      const row = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'itest-admin'`,
      );
      expect(row.rows[0]).toBeTruthy();
      adminId = row.rows[0]!.id;
    } finally {
      await pool.end();
    }

    // 列表必须包含状态/创建时间/预算等安全投影字段（管理端用户管理 IA 需要）。
    const list = await admin.req("GET", "/api/v1/admin/users", {});
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<Record<string, unknown>> }).items;
    expect(Array.isArray(items)).toBe(true);
    const shaped = items.find((u) => u.id === adminId);
    expect(shaped).toBeTruthy();

    // 必须存在完整的 whitelist 投影字段。
    const expectedFields = [
      "id",
      "username",
      "displayName",
      "role",
      "timezone",
      "dailyBudgetMinutes",
      "mustChangePassword",
      "status",
      "createdAt",
    ];
    for (const f of expectedFields) {
      expect(shaped, `列表投影应包含字段 ${f}`).toHaveProperty(f);
    }
    expect(shaped?.status).toBe("active");
    expect(typeof shaped?.createdAt).toBe("string");
    expect(new Date(shaped!.createdAt as string).getTime()).not.toBeNaN();
    expect(typeof shaped?.dailyBudgetMinutes).toBe("number");

    // 敏感字段绝不进入列表投影。
    const keys = Object.keys(shaped as Record<string, unknown>);
    for (const sensitive of [
      "password_hash",
      "passwordHash",
      "password_version",
      "sessionToken",
      "session_token",
      "oneTimePassword",
      "otp_consumed",
      "otpConsumed",
      "before_summary",
      "after_summary",
      "request_id",
    ]) {
      expect(keys, `列表不得泄露敏感字段 ${sensitive}`).not.toContain(sensitive);
    }
    // 列表绝不包含审计原始 payload（audit_events 相关字段）。
    const ser = JSON.stringify(list.json());
    expect(ser).not.toContain("password_hash");
    expect(ser).not.toContain("passwordHash");
    expect(ser).not.toContain("sessionToken");
    expect(ser).not.toContain("oneTimePassword");

    // 详情（GET /admin/users/:id）同样只返回安全投影，不泄露敏感字段。
    const detail = await admin.req("GET", `/api/v1/admin/users/${adminId}`, {});
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as Record<string, unknown>;
    for (const f of expectedFields) {
      expect(detailBody, `详情投影应包含字段 ${f}`).toHaveProperty(f);
    }
    const detailSer = JSON.stringify(detailBody);
    expect(detailSer).not.toContain("password_hash");
    expect(detailSer).not.toContain("sessionToken");
    expect(detailSer).not.toContain("oneTimePassword");

    // 当前登录管理员停用自己 → 409（不能停用自己）。
    const self = await admin.req("POST", `/api/v1/admin/users/${adminId}/disable`, {});
    expect(self.statusCode).toBe(409);
    expect(String((self.json() as { error: { message: string } }).error.message)).toContain(
      "不能停用自己的账号",
    );
  });

  it("重置密码后旧密码失效、新一次性密码可登录", async () => {
    const { client, otp, username } = await createLearner("reset");
    await client.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } });
    await client.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "reset-pass-12345" },
    });

    // 同停用用例：admin 列表截断 100 行，直查数据库取目标 id。
    const pool = createPool({ ...config, max: 1 });
    let targetId: string;
    try {
      const row = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
        username,
      ]);
      expect(row.rows[0]).toBeTruthy();
      targetId = row.rows[0]!.id;
    } finally {
      await pool.end();
    }

    const reset = await admin.req("POST", `/api/v1/admin/users/${targetId}/reset-password`, {
      headers: { "idempotency-key": `reset-${username}` },
    });
    expect(reset.statusCode).toBe(200);
    const newOtp = (reset.json() as { oneTimePassword?: string }).oneTimePassword;

    const old = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "reset-pass-12345" },
    });
    expect(old.statusCode).toBe(401);
    const fresh = makeClient(app);
    const freshLogin = await fresh.req("POST", "/api/v1/auth/login", {
      payload: { username, password: newOtp },
    });
    expect(freshLogin.statusCode).toBe(200);
  });

  it("管理员创建管理员有审计记录且不包含密码/OTP（v1 允许多管理员）", async () => {
    const { username } = await createLearner("audit-admin", "admin");
    const auditPool = createPool({ ...config, max: 1 });
    try {
      const rows = await auditPool.query<{ action: string; after_summary: { username?: string } }>(
        `SELECT action, after_summary FROM audit_events
         WHERE action = 'admin.user.create' AND after_summary->>'username' = $1`,
        [username],
      );
      expect(rows.rows.length).toBe(1);
      const text = JSON.stringify(rows.rows[0]?.after_summary ?? {});
      expect(text).toContain(username);
      expect(text.toLowerCase()).not.toMatch(/password|otp|secret/);
    } finally {
      await auditPool.end();
    }
  });

  it("并发使用同一一次性密码：最多只有一个登录成功", async () => {
    const { otp, username } = await createLearner("concurrent");
    const c1 = makeClient(app);
    const c2 = makeClient(app);
    const [r1, r2] = await Promise.all([
      c1.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } }),
      c2.req("POST", "/api/v1/auth/login", { payload: { username, password: otp } }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);

    // 失败的并发请求与普通错误密码返回同一公开错误，不泄露 OTP 是否已消费。
    const loser = r1.statusCode === 401 ? r1 : r2;
    const wrongPass = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "definitely-wrong" },
    });
    expect((loser.json() as { error: { message: string } }).error.message).toBe(
      (wrongPass.json() as { error: { message: string } }).error.message,
    );

    // 成功后原 OTP 不能再建立新会话。
    const c3 = makeClient(app);
    const again = await c3.req("POST", "/api/v1/auth/login", {
      payload: { username, password: otp },
    });
    expect(again.statusCode).toBe(401);
  });

  it("闲置过期后会话被拒绝", async () => {
    const { client, otp, username } = await createLearner("idle");
    const login = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: otp },
    });
    expect(login.statusCode).toBe(200);
    const userId = (login.json() as { id: string }).id;
    const c = createPool({ ...config, max: 1 });
    try {
      await c.query(
        `UPDATE auth_sessions SET idle_expires_at = now() - interval '1 minute'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    } finally {
      await c.end();
    }
    const me = await client.req("GET", "/api/v1/auth/me", {});
    expect(me.statusCode).toBe(401);
  });

  it("绝对过期后会话被拒绝", async () => {
    const { client, otp, username } = await createLearner("absolute");
    const login = await client.req("POST", "/api/v1/auth/login", {
      payload: { username, password: otp },
    });
    expect(login.statusCode).toBe(200);
    const userId = (login.json() as { id: string }).id;
    const c = createPool({ ...config, max: 1 });
    try {
      await c.query(
        `UPDATE auth_sessions SET absolute_expires_at = now() - interval '1 minute'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    } finally {
      await c.end();
    }
    const me = await client.req("GET", "/api/v1/auth/me", {});
    expect(me.statusCode).toBe(401);
  });

  it("撤销单条会话只影响被撤销的会话", async () => {
    // OTP 一次性消费，同一 OTP 不能二次登录；故首次 OTP 登录后改密，再用新密码建立第二个会话。
    const { otp, username } = await createLearner("revoke-one");
    const c1 = makeClient(app);
    const login1 = await c1.req("POST", "/api/v1/auth/login", {
      payload: { username, password: otp },
    });
    expect(login1.statusCode).toBe(200);
    const change = await c1.req("POST", "/api/v1/auth/change-password", {
      payload: { currentPassword: otp, newPassword: "new-pass-12345" },
    });
    expect(change.statusCode).toBe(200);

    const before = await c1.req("GET", "/api/v1/auth/sessions", {});
    const c1SessionId = (before.json() as { id: string }[])[0]?.id;
    expect(c1SessionId).toBeTruthy();

    const c2 = makeClient(app);
    const login2 = await c2.req("POST", "/api/v1/auth/login", {
      payload: { username, password: "new-pass-12345" },
    });
    expect(login2.statusCode).toBe(200);
    const after = await c1.req("GET", "/api/v1/auth/sessions", {});
    const items = after.json() as { id: string }[];
    const c2SessionId = items.find((s) => s.id !== c1SessionId)?.id;
    expect(c2SessionId).toBeTruthy();

    const revoke = await c2.req("DELETE", `/api/v1/auth/sessions/${c2SessionId}`, {});
    expect(revoke.statusCode).toBe(200);

    const c2me = await c2.req("GET", "/api/v1/auth/me", {});
    expect(c2me.statusCode).toBe(401);
    const c1me = await c1.req("GET", "/api/v1/auth/me", {});
    expect(c1me.statusCode).toBe(200);
  });

  it("CSRF 缺失被 403 拒绝；连续错误登录触发限速 429", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: {} });
    expect(res.statusCode).toBe(403);

    const brute = makeClient(app);
    let last = 0;
    for (let i = 0; i < 15; i++) {
      last = (
        await brute.req("POST", "/api/v1/auth/login", {
          payload: { username: "itest-admin", password: "definitely-wrong" },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });
});
