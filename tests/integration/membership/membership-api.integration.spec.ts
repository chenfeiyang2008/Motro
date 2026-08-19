// Ticket 20: membership API integration — /me/membership + admin grant/renew/revoke.
// Isolated DB. Covers 401, free default, grant/renew/revoke projection, admin-only
// permission (403), idempotency + replay freeze, and no sensitive-field leakage.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import type { Pool } from "pg";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { MembershipService } from "../../../apps/api/src/modules/membership/membership.service.js";
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
  "membership API (isolated DB)",
  () => {
    let isolatedDbName: string | undefined;
    const previousDb = process.env.POSTGRES_DB;
    let pool: Pool;
    let app: App;

    beforeAll(async () => {
      isolatedDbName = `motro_membership_api_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
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

      const ps = new PasswordService();
      const hash = await ps.hashPassword("api-pass-123");
      await pool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('mem-admin','会员管理员','admin','active','Asia/Shanghai',10,$1),
                ('mem-learner','会员学习者','learner','active','Asia/Shanghai',10,$2)`,
        [hash, hash],
      );

      app = await createApp();
      await app.init();
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

    // ---- HTTP client (mirror motivation-api) ----
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

    let learnerId: string;
    let learner: Client;
    let admin: Client;

    it("unauthenticated /me/membership → 401", async () => {
      const anon = makeClient();
      const res = await anon.req("GET", "/api/v1/me/membership");
      expect(res.statusCode).toBe(401);
    });

    it("learner default (no row) → free; no sensitive fields", async () => {
      learner = makeClient();
      await learner.login("mem-learner", "api-pass-123");
      const me = await learner.req("GET", "/api/v1/me/membership");
      expect(me.statusCode).toBe(200);
      const body = me.json() as Record<string, unknown>;
      expect(body.plan).toBe("free");
      expect(body.status).toBe("free");
      expect(body).not.toHaveProperty("passwordHash");
      expect(body).not.toHaveProperty("session");
      expect(body).not.toHaveProperty("requestId");
      // capture learner id from DB
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'mem-learner'`,
      );
      learnerId = r.rows[0]!.id;
    });

    it("learner cannot call admin grant (403)", async () => {
      const res = await learner.req("POST", `/api/v1/admin/memberships/${learnerId}/grant`, {
        payload: { plan: "member" },
        headers: { "idempotency-key": "no-perm" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("admin grant (idempotent) → learner /me/membership shows member; no sensitive fields", async () => {
      admin = makeClient();
      await admin.login("mem-admin", "api-pass-123");

      const key = `grant-${randomBytes(4).toString("hex")}`;
      const g1 = await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/grant`, {
        payload: { plan: "member", expiresAt: null },
        headers: { "idempotency-key": key },
      });
      expect(g1.statusCode).toBe(200);
      const g1Body = g1.json() as Record<string, unknown>;
      expect(g1Body.plan).toBe("member");
      expect(g1Body.status).toBe("member");

      // Replay same key+payload → frozen 200.
      const g2 = await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/grant`, {
        payload: { plan: "member", expiresAt: null },
        headers: { "idempotency-key": key },
      });
      expect(g2.statusCode).toBe(200);
      expect((g2.json() as { status: string }).status).toBe("member");

      // Learner sees member.
      const me = await learner.req("GET", "/api/v1/me/membership");
      const meBody = me.json() as { status: string; plan: string };
      expect(meBody.status).toBe("member");
      expect(meBody.plan).toBe("member");
    });

    it("admin grant with past expiresAt → learner effectively free (fail-closed)", async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const key = `grant-past-${randomBytes(4).toString("hex")}`;
      const g = await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/grant`, {
        payload: { plan: "member", expiresAt: past },
        headers: { "idempotency-key": key },
      });
      expect(g.statusCode).toBe(200);
      const me = await learner.req("GET", "/api/v1/me/membership");
      expect((me.json() as { status: string }).status).toBe("free");
    });

    it("admin renew (future expiry) → learner member; revoke → free", async () => {
      const future = new Date(Date.now() + 30 * 86400_000).toISOString();
      const renewKey = `renew-${randomBytes(4).toString("hex")}`;
      const r1 = await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/renew`, {
        payload: { expiresAt: future },
        headers: { "idempotency-key": renewKey },
      });
      expect(r1.statusCode).toBe(200);
      expect((r1.json() as { status: string }).status).toBe("member");

      const meMember = await learner.req("GET", "/api/v1/me/membership");
      expect((meMember.json() as { status: string }).status).toBe("member");

      const revokeKey = `revoke-${randomBytes(4).toString("hex")}`;
      const rv = await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/revoke`, {
        headers: { "idempotency-key": revokeKey },
      });
      expect(rv.statusCode).toBe(200);

      const meFree = await learner.req("GET", "/api/v1/me/membership");
      expect((meFree.json() as { status: string }).status).toBe("free");
    });

    it("free=15 limit & member=unlimited at the service boundary (daily usage projection)", async () => {
      // Prove membershipStatus/limitMinutes projection + under-limit pass server-side.
      const ps = new PasswordService();
      const freeUser = (
        await pool.query<{ id: string }>(
          `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
           VALUES ('mem-limit-free-' || substr(md5(random()::text),1,8), '限时免费', 'learner', 'active', 'Asia/Shanghai', 20, $1)
           RETURNING id`,
          [await ps.hashPassword("limit-pass-123")],
        )
      ).rows[0]!.id;
      const memberUser = (
        await pool.query<{ id: string }>(
          `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
           VALUES ('mem-limit-member-' || substr(md5(random()::text),1,8), '限时会员', 'learner', 'active', 'Asia/Shanghai', 20, $1)
           RETURNING id`,
          [await ps.hashPassword("limit-pass-123")],
        )
      ).rows[0]!.id;
      await pool.query(
        `INSERT INTO memberships (user_id, plan, status, expires_at, timezone, last_action)
         VALUES ($1, 'member', 'active', NULL, 'Asia/Shanghai', 'grant')`,
        [memberUser],
      );

      const service = app.get(MembershipService);
      const freeSummary = await service.getDailyUsageSummary(freeUser);
      expect(freeSummary.membershipStatus).toBe("free");
      expect(freeSummary.limitMinutes).toBe(15);
      const memberSummary = await service.getDailyUsageSummary(memberUser);
      expect(memberSummary.membershipStatus).toBe("member");
      expect(memberSummary.limitMinutes).toBe(Number.POSITIVE_INFINITY);
      // Under-limit free & member both pass assertCanAccrue (idempotent, deterministic).
      await expect(service.assertCanAccrue(freeUser)).resolves.toBeTruthy();
      await expect(service.assertCanAccrue(memberUser)).resolves.toBeTruthy();

      // Over-limit throw is domain-proven (isDailyLimitReached, unit). Here we prove
      // free=15 vs member=unlimited projection + under-limit pass, deterministic.
    });

    // ---- admin read endpoint: GET /admin/memberships/:userId ----
    // 复用 learnerId：先清理其会员状态（确保 determinism），再分离场景。

    it("admin GET /admin/memberships/:userId — member projection", async () => {
      // 确保 learnerId 当前为 member（前一用例 grant 后续续期/撤销可能已改动）。
      const gKey = `read-grant-${randomBytes(4).toString("hex")}`;
      await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/grant`, {
        payload: { plan: "member", expiresAt: null },
        headers: { "idempotency-key": gKey },
      });
      const res = await admin.req("GET", `/api/v1/admin/memberships/${learnerId}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { plan: string; status: string; expiresAt: unknown };
      expect(body.plan).toBe("member");
      expect(body.status).toBe("member");
      expect(body.expiresAt).toBeNull();
    });

    it("admin GET /admin/memberships/:userId — free (no membership row)", async () => {
      const key = `read-revoke-${randomBytes(4).toString("hex")}`;
      await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/revoke`, {
        headers: { "idempotency-key": key },
      });
      const res = await admin.req("GET", `/api/v1/admin/memberships/${learnerId}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { plan: string; status: string; expiresAt: unknown };
      expect(body.plan).toBe("free");
      expect(body.status).toBe("free");
      expect(body.expiresAt).toBeNull();
    });

    it("admin GET /admin/memberships/:userId — expired member (fail-closed projection, raw expiry)", async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const key = `read-grant-exp-${randomBytes(4).toString("hex")}`;
      await admin.req("POST", `/api/v1/admin/memberships/${learnerId}/grant`, {
        payload: { plan: "member", expiresAt: past },
        headers: { "idempotency-key": key },
      });
      const res = await admin.req("GET", `/api/v1/admin/memberships/${learnerId}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { plan: string; status: string; expiresAt: string | null };
      expect(body.plan).toBe("member");
      expect(body.status).toBe("free"); // effective fail-closed
      expect(body.expiresAt).toBe(past);
    });

    it("learner GET /admin/memberships/:userId → 403", async () => {
      const res = await learner.req("GET", `/api/v1/admin/memberships/${learnerId}`);
      expect(res.statusCode).toBe(403);
    });

    it("anon GET /admin/memberships/:userId → 401/403 (session guard)", async () => {
      const anon = makeClient();
      const res = await anon.req("GET", `/api/v1/admin/memberships/${learnerId}`);
      expect([401, 403]).toContain(res.statusCode);
    });
  },
);
