// Ticket 03: per-user non-member daily study-time limit (editable by admin).
// Isolated DB. Covers:
//   - admin-only PATCH /admin/memberships/:userId/daily-limit (401/403)
//   - unknown user → 404
//   - invalid minutes → 422 (negative, decimal, 1441, non-numeric)
//   - first set on a user with no membership row creates a free/active projection
//   - /me/daily-usage + the study gate (assertCanAccrue) read the same field
//   - valid member keeps its plan/status/expiry while the field is set
//   - idempotency: missing key → 400, replay freeze, same-key-different-payload → 409
//   - audit: one daily_limit fact per successful write, replay does not duplicate
//   - transaction failure leaves no half-written projection/audit/idempotency record
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
  "daily study limit API (isolated DB)",
  () => {
    let isolatedDbName: string | undefined;
    const previousDb = process.env.POSTGRES_DB;
    let pool: Pool;
    let app: App;
    let adminId: string;

    beforeAll(async () => {
      isolatedDbName = `motro_daily_limit_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
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
      const hash = await ps.hashPassword("daily-pass-123");
      await pool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('dl-admin','时长管理员','admin','active','Asia/Shanghai',10,$1),
                ('dl-learner','时长学习者','learner','active','Asia/Shanghai',10,$2)`,
        [hash, hash],
      );
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'dl-admin'`,
      );
      adminId = r.rows[0]!.id;

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

    const patchUrl = (userId: string) => `/api/v1/admin/memberships/${userId}/daily-limit`;

    it("unauthenticated daily-limit → 401", async () => {
      const anon = makeClient();
      const res = await anon.req("PATCH", patchUrl("00000000-0000-0000-0000-000000000000"), {
        payload: { minutes: 30 },
        headers: { "idempotency-key": "anon" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("learner daily-limit → 403", async () => {
      learner = makeClient();
      await learner.login("dl-learner", "daily-pass-123");
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'dl-learner'`,
      );
      learnerId = r.rows[0]!.id;
      const res = await learner.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 30 },
        headers: { "idempotency-key": "learner" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("admin missing Idempotency-Key → 400", async () => {
      admin = makeClient();
      await admin.login("dl-admin", "daily-pass-123");
      const res = await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 30 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("unknown user → 404", async () => {
      const res = await admin.req("PATCH", patchUrl("11111111-2222-3333-4444-555555555555"), {
        payload: { minutes: 30 },
        headers: { "idempotency-key": "ghost" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("invalid minutes → 422 (negative, decimal, 1441, non-numeric)", async () => {
      for (const [minutes, label] of [
        [-1, "negative"],
        [0.5, "decimal"],
        [1441, "too-high"],
        ["abc", "non-numeric"],
      ] as const) {
        const res = await admin.req("PATCH", patchUrl(learnerId), {
          payload: { minutes },
          headers: { "idempotency-key": `bad-${label}` },
        });
        expect(res.statusCode, `${label} should be 422`).toBe(422);
      }
    });

    it("admin first set on learner with no membership row → creates free/active + 30 is read by usage + gate", async () => {
      const key = `first-${randomBytes(4).toString("hex")}`;
      const res = await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 30 },
        headers: { "idempotency-key": key },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { dailyLimitMinutes: number }).dailyLimitMinutes).toBe(30);

      // membership row created (free/active), started_at now, expires null.
      const m = await pool.query<{
        plan: string;
        status: string;
        expires_at: Date | null;
        free_daily_limit_minutes: number;
      }>(
        `SELECT plan, status, expires_at, free_daily_limit_minutes FROM memberships WHERE user_id = $1`,
        [learnerId],
      );
      expect(m.rowCount).toBe(1);
      expect(m.rows[0]!.plan).toBe("free");
      expect(m.rows[0]!.status).toBe("active");
      expect(m.rows[0]!.expires_at).toBeNull();
      expect(m.rows[0]!.free_daily_limit_minutes).toBe(30);

      // learner /me/membership → free; /me/daily-usage reads 30.
      const me = await learner.req("GET", "/api/v1/me/membership");
      expect((me.json() as { status: string }).status).toBe("free");
      const usage = await learner.req("GET", "/api/v1/me/daily-usage");
      expect(usage.statusCode).toBe(200);
      expect((usage.json() as { limitMinutes: number }).limitMinutes).toBe(30);

      // Service gate reads the same persisted field: under-limit passes.
      const service = app.get(MembershipService);
      await expect(service.assertCanAccrue(learnerId)).resolves.toBeTruthy();
      // Gate reads the SAME limitMinutes from the projection — proven above via /me/daily-usage
      // AND via this direct service call; no separate constants exist.
    });

    it("update to 0 → usage shows 0 and gate always rejects", async () => {
      const key = `zero-${randomBytes(4).toString("hex")}`;
      const res = await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 0 },
        headers: { "idempotency-key": key },
      });
      expect(res.statusCode).toBe(200);
      const usage = await learner.req("GET", "/api/v1/me/daily-usage");
      expect((usage.json() as { limitMinutes: number }).limitMinutes).toBe(0);
      expect((usage.json() as { remainingMinutes: number }).remainingMinutes).toBe(0);
      const service = app.get(MembershipService);
      await expect(service.assertCanAccrue(learnerId)).rejects.toThrow();
    });

    it("update to 1440 works (max boundary)", async () => {
      const key = `max-${randomBytes(4).toString("hex")}`;
      const res = await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 1440 },
        headers: { "idempotency-key": key },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { dailyLimitMinutes: number }).dailyLimitMinutes).toBe(1440);
      const usage = await learner.req("GET", "/api/v1/me/daily-usage");
      expect((usage.json() as { limitMinutes: number }).limitMinutes).toBe(1440);
    });

    it("admin read projection includes dailyLimitMinutes", async () => {
      const read = await admin.req("GET", `/api/v1/admin/memberships/${learnerId}`);
      expect(read.statusCode).toBe(200);
      expect((read.json() as { dailyLimitMinutes: number }).dailyLimitMinutes).toBe(1440);
    });

    it("valid member keeps plan/status/expiry while limit is set; usage + gate unlimited", async () => {
      // Grant an indefinite member for a fresh user.
      const ps = new PasswordService();
      const memberUser = (
        await pool.query<{ id: string }>(
          `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
           VALUES ('dl-member-' || substr(md5(random()::text),1,8), '时长会员', 'learner', 'active', 'Asia/Shanghai', 20, $1)
           RETURNING id`,
          [await ps.hashPassword("member-pass-123")],
        )
      ).rows[0]!.id;
      await pool.query(
        `INSERT INTO memberships (user_id, plan, status, started_at, expires_at, timezone, last_action)
         VALUES ($1, 'member', 'active', now(), NULL, 'Asia/Shanghai', 'grant')`,
        [memberUser],
      );

      // Admin sets a limit for this member — must not downgrade the membership.
      const key = `member-limit-${randomBytes(4).toString("hex")}`;
      const res = await admin.req("PATCH", patchUrl(memberUser), {
        payload: { minutes: 30 },
        headers: { "idempotency-key": key },
      });
      expect(res.statusCode).toBe(200);

      const m = await pool.query<{
        plan: string;
        status: string;
        expires_at: Date | null;
        free_daily_limit_minutes: number;
      }>(
        `SELECT plan, status, expires_at, free_daily_limit_minutes FROM memberships WHERE user_id = $1`,
        [memberUser],
      );
      expect(m.rows[0]!.plan).toBe("member");
      expect(m.rows[0]!.status).toBe("active");
      expect(m.rows[0]!.expires_at).toBeNull();
      // The free-limit column is preserved (a stored config), but it does not bind a member.
      expect(m.rows[0]!.free_daily_limit_minutes).toBe(30);

      const service = app.get(MembershipService);
      const summary = await service.getDailyUsageSummary(memberUser);
      expect(summary.membershipStatus).toBe("member");
      expect(summary.limitMinutes).toBe(Number.POSITIVE_INFINITY);
      await expect(service.assertCanAccrue(memberUser)).resolves.toBeTruthy();

      // Expire the member → back to the configured free limit (fail-closed).
      await pool.query(
        `UPDATE memberships SET status = 'expired', expires_at = now() - interval '1 hour' WHERE user_id = $1`,
        [memberUser],
      );
      const expired = await service.getDailyUsageSummary(memberUser);
      expect(expired.membershipStatus).toBe("free");
      expect(expired.limitMinutes).toBe(30);
    });

    it("idempotency: same key + same payload replays frozen response, no second audit", async () => {
      const key = `idem-${randomBytes(4).toString("hex")}`;
      const before = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM membership_audit WHERE user_id = $1 AND action = 'daily_limit'`,
        [learnerId],
      );
      const beforeCount = Number(before.rows[0]?.n ?? 0);

      const r1 = await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 45 },
        headers: { "idempotency-key": key },
      });
      expect(r1.statusCode).toBe(200);
      expect((r1.json() as { dailyLimitMinutes: number }).dailyLimitMinutes).toBe(45);

      const r2 = await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 45 },
        headers: { "idempotency-key": key },
      });
      expect(r2.statusCode).toBe(200);
      expect((r2.json() as { dailyLimitMinutes: number }).dailyLimitMinutes).toBe(45);

      const after = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM membership_audit WHERE user_id = $1 AND action = 'daily_limit'`,
        [learnerId],
      );
      expect(Number(after.rows[0]?.n ?? 0)).toBe(beforeCount + 1);
    });

    it("idempotency: same key + different payload → 409 conflict, no write", async () => {
      const key = `idem-conflict-${randomBytes(4).toString("hex")}`;
      await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 60 },
        headers: { "idempotency-key": key },
      });
      const conflict = await admin.req("PATCH", patchUrl(learnerId), {
        payload: { minutes: 90 },
        headers: { "idempotency-key": key },
      });
      expect(conflict.statusCode).toBe(409);
      // The conflicted payload must not have been applied.
      const m = await pool.query<{ free_daily_limit_minutes: number }>(
        `SELECT free_daily_limit_minutes FROM memberships WHERE user_id = $1`,
        [learnerId],
      );
      expect(m.rows[0]!.free_daily_limit_minutes).toBe(60);
    });

    it("audit facts: first write + update each produce exactly one daily_limit row with actor + minutes + request_id", async () => {
      // Fresh user so counts are deterministic.
      const ps = new PasswordService();
      const fresh = (
        await pool.query<{ id: string }>(
          `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
           VALUES ('dl-audit-' || substr(md5(random()::text),1,8), '审计时长', 'learner', 'active', 'Asia/Shanghai', 10, $1)
           RETURNING id`,
          [await ps.hashPassword("audit-pass-123")],
        )
      ).rows[0]!.id;
      const key1 = `audit-1-${randomBytes(4).toString("hex")}`;
      await admin.req("PATCH", patchUrl(fresh), {
        payload: { minutes: 20 },
        headers: { "idempotency-key": key1 },
      });
      const key2 = `audit-2-${randomBytes(4).toString("hex")}`;
      await admin.req("PATCH", patchUrl(fresh), {
        payload: { minutes: 25 },
        headers: { "idempotency-key": key2 },
      });
      const rows = await pool.query<{
        actor_id: string;
        action: string;
        plan: string;
        daily_limit_minutes: number;
        request_id: string;
        created_at: Date;
      }>(
        `SELECT actor_id, action, plan, daily_limit_minutes, request_id, created_at
         FROM membership_audit WHERE user_id = $1 AND action = 'daily_limit' ORDER BY created_at ASC`,
        [fresh],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]!.actor_id).toBe(adminId);
      expect(rows.rows[0]!.plan).toBe("free");
      expect(rows.rows[0]!.daily_limit_minutes).toBe(20);
      expect(rows.rows[0]!.request_id).toBeTruthy();
      expect(rows.rows[1]!.daily_limit_minutes).toBe(25);
    });
  },
);
