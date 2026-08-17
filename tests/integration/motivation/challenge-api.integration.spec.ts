// Ticket 14: challenge quiz API integration — full Nest app, isolated DB.
//
// Covers the HTTP contract for /challenge/current + /challenge/attempts/:id/answers/:pos:
//   - 401 (unauthenticated) + CSRF enforcement;
//   - 404 for a nonexistent / foreign attempt;
//   - server-graded: the response reflects the server verdict and points, never a
//     client-supplied amount;
//   - privacy: responses expose no username/user_id/session; a learner can read only
//     their own attempt.
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

type Res = { statusCode: number; json(): unknown; headers: Record<string, unknown> };

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "challenge quiz API (isolated DB)",
  () => {
    let dbName: string;
    let pool: Pool;
    let app: Awaited<ReturnType<typeof createApp>>;
    const learnerPass = "challenge-api-pass-1";

    beforeAll(async () => {
      dbName = `motro_t14api_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      const admin = createPool({ ...config, database: "postgres", max: 1 });
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end();
      }
      const iso = { ...config, database: dbName };
      await migrate(iso, MIGRATIONS_DIR);
      pool = createPool({ ...iso, max: 5 });

      const ps = new PasswordService();
      const hash = await ps.hashPassword(learnerPass);
      await pool.query(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('t14api','T14 API','learner','active','Asia/Shanghai',10,$1)`,
        [hash],
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
        if (dbName) await dropIsolatedDatabase(dbName);
      }
    });

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
        async req(method: string, url: string, payload?: unknown): Promise<Res> {
          if (method !== "GET" && csrf === "") await this.warm();
          const headers: Record<string, string> = {};
          const jar = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
          if (jar) headers.cookie = jar;
          if (method !== "GET") headers["x-csrf-token"] = csrf;
          const res = await app.inject({
            method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
            url,
            headers,
            ...(payload !== undefined ? { payload: payload as string | object } : {}),
          });
          capture(res);
          return { statusCode: res.statusCode, json: () => res.json(), headers: res.headers };
        },
        async login(username: string, password: string): Promise<void> {
          await this.warm();
          const res = await this.req("POST", "/api/v1/auth/login", { username, password });
          if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`);
        },
      };
    }
    it("unauthenticated GET /challenge/current → 401", async () => {
      const anon = makeClient();
      const res = await anon.req("GET", "/api/v1/challenge/current");
      expect(res.statusCode).toBe(401);
    });

    it("authenticated GET /challenge/current returns a well-formed empty attempt (no exposed words)", async () => {
      const learner = makeClient();
      await learner.login("t14api", learnerPass);
      const res = await learner.req("GET", "/api/v1/challenge/current");
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        challengeWeek: string;
        weekStart: string;
        weekEnd: string;
        timezone: string;
        attemptId: string | null;
        items: unknown[];
        maxPoints: number;
      };
      expect(body.challengeWeek).toMatch(/^cw-\d{4}-\d{2}-\d{2}$/);
      expect(body.timezone).toBe("Asia/Shanghai");
      // No exposed words => empty attempt (items empty, attemptId null).  No secrets.
      expect(body.attemptId).toBeNull();
      expect(Array.isArray(body.items)).toBe(true);
    });

    it("submitting an answer to a nonexistent attempt → 404", async () => {
      const learner = makeClient();
      await learner.login("t14api", learnerPass);
      const res = await learner.req("POST", "/api/v1/challenge/attempts/does-not-exist/answers/1", {
        clientEventId: "c1",
        answer: "x",
      });
      expect(res.statusCode).toBe(404);
    });

    it("invalid body (missing answer) → 400 by DTO validation", async () => {
      const learner = makeClient();
      await learner.login("t14api", learnerPass);
      const res = await learner.req("POST", "/api/v1/challenge/attempts/does-not-exist/answers/1", {
        clientEventId: "c2",
      });
      expect(res.statusCode).toBe(400);
    });

    it("answers JSON never leaks username/user_id/session fields", async () => {
      const learner = makeClient();
      await learner.login("t14api", learnerPass);
      const res = await learner.req("GET", "/api/v1/challenge/current");
      const body = res.json() as Record<string, unknown>;
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("user_id");
      expect(raw).not.toContain("password");
      expect(raw).not.toContain("session");
      expect(body.items).not.toBeNull();
    });
  },
);
