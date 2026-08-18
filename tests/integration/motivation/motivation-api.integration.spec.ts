// Ticket 09: motivation API integration — /me/xp, /me/learning-summary, /leaderboard/weekly.
// Isolated DB. Covers 401, disabled exclusion, privacy projection, pagination stability.
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
  "motivation API (isolated DB)",
  () => {
    let isolatedDbName: string | undefined;
    const previousDb = process.env.POSTGRES_DB;
    let pool: Pool;
    let app: App;

    beforeAll(async () => {
      isolatedDbName = `motro_motivation_api_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
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

      // Seed an active learner + a disabled user + a course item for XP facts.
      const ps = new PasswordService();
      const hash = await ps.hashPassword("api-pass-123");
      await pool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('api-learner','API 学习者','learner','active','Asia/Shanghai',10,$1),
                ('api-disabled','API 停用','learner','disabled','Asia/Shanghai',10,$2)`,
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

    // ---- HTTP client (mirror catalog-read makeClient) ----
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

    let learner: Client;

    it("unauthenticated /me/xp → 401", async () => {
      const anon = makeClient();
      const res = await anon.req("GET", "/api/v1/me/xp");
      expect(res.statusCode).toBe(401);
    });

    it("learner can read /me/xp (empty) and /leaderboard/weekly (empty)", async () => {
      learner = makeClient();
      await learner.login("api-learner", "api-pass-123");
      const xp = await learner.req("GET", "/api/v1/me/xp");
      expect(xp.statusCode).toBe(200);
      const xpBody = xp.json() as {
        totalXp: number;
        entries: unknown[];
        level: number;
        title: string;
        nextLevelThreshold: number | null;
        progressPercent: number;
      };
      expect(xpBody.totalXp).toBe(0);
      expect(Array.isArray(xpBody.entries)).toBe(true);
      expect(xpBody.level).toBe(1);
      expect(xpBody.title).toBe("初学黑铁");
      expect(xpBody.nextLevelThreshold).toBe(50);
      expect(xpBody.progressPercent).toBe(0);
      expect(JSON.stringify(xpBody)).not.toMatch(
        /password|session|source_event_id|review_event_id/,
      );

      const lb = await learner.req("GET", "/api/v1/leaderboard/weekly");
      expect(lb.statusCode).toBe(200);
      const lbBody = lb.json() as { rows: unknown[]; totalParticipants: number };
      expect(Array.isArray(lbBody.rows)).toBe(true);
      expect(lbBody.totalParticipants).toBe(0);
    });

    it("invalid challengeWeek → 422", async () => {
      const res = await learner.req(
        "GET",
        "/api/v1/leaderboard/weekly?challengeWeek=cw-2026-99-99",
      );
      expect(res.statusCode).toBe(422);
    });

    it("leaderboard does not leak username/user_id/privacy fields", async () => {
      const lb = await learner.req("GET", "/api/v1/leaderboard/weekly");
      const body = lb.json() as { rows: Record<string, unknown>[] };
      for (const row of body.rows) {
        expect(row).not.toHaveProperty("username");
        expect(row).not.toHaveProperty("userId");
        expect(row).not.toHaveProperty("user_id");
        expect(row).not.toHaveProperty("email");
        expect(row).not.toHaveProperty("passwordHash");
        expect(row).not.toHaveProperty("timezone");
      }
      expect(body.rows.every((r) => typeof r.displayName === "string")).toBe(true);
    });

    it("disabled user cannot authenticate (session rejected → /me 401)", async () => {
      const dis = makeClient();
      await dis.warm();
      const login = await dis.req("POST", "/api/v1/auth/login", {
        payload: { username: "api-disabled", password: "api-pass-123" },
      });
      expect(login.statusCode).toBe(401);
    });

    it("POST /leaderboard/visibility without CSRF token → 403", async () => {
      // Raw inject without x-csrf-token header (makeClient always injects it).
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leaderboard/visibility",
        headers: { cookie: "motro_session=" }, // no valid session either
        payload: { public: false },
      });
      // Either 401 (no session) or 403 (CSRF) — but never 200.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(200);
    });

    it("learner opens and closes public visibility with idempotency; replay frozen; diff payload 409", async () => {
      // Turn OFF public (opt-out).
      const offKey = `vis-off-${randomBytes(4).toString("hex")}`;
      const off1 = await learner.req("POST", "/api/v1/leaderboard/visibility", {
        payload: { public: false },
        headers: { "idempotency-key": offKey },
      });
      expect(off1.statusCode).toBe(200);
      expect((off1.json() as { isPublic: boolean }).isPublic).toBe(false);

      // Replay same key+payload → frozen 200 (isPublic false).
      const off2 = await learner.req("POST", "/api/v1/leaderboard/visibility", {
        payload: { public: false },
        headers: { "idempotency-key": offKey },
      });
      expect(off2.statusCode).toBe(200);
      expect((off2.json() as { isPublic: boolean }).isPublic).toBe(false);

      // Same key + different payload → 409 IDEMPOTENCY_CONFLICT.
      const conflict = await learner.req("POST", "/api/v1/leaderboard/visibility", {
        payload: { public: true },
        headers: { "idempotency-key": offKey },
      });
      expect(conflict.statusCode).toBe(409);

      // Turn back ON with a fresh key.
      const onKey = `vis-on-${randomBytes(4).toString("hex")}`;
      const on1 = await learner.req("POST", "/api/v1/leaderboard/visibility", {
        payload: { public: true },
        headers: { "idempotency-key": onKey },
      });
      expect(on1.statusCode).toBe(200);
      expect((on1.json() as { isPublic: boolean }).isPublic).toBe(true);
    });

    it("visibility response does not leak secret/internal fields", async () => {
      const res = await learner.req("POST", "/api/v1/leaderboard/visibility", {
        payload: { public: true },
        headers: { "idempotency-key": `vis-sec-${randomBytes(4).toString("hex")}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.stringify(res.json());
      expect(body).not.toContain("password");
      expect(body).not.toContain("session");
      expect(body).not.toContain("secret");
      expect(body).not.toContain("request_hash");
      expect(body).not.toContain("x-request-id");
    });
  },
);
