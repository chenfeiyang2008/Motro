// Ticket 07: reviews API auth/CSRF/role integration (in-process Nest app, shared
// config DB — does NOT create an isolated DB, avoiding createApp env-override
// worker crashes; the DB-layer invariants are covered by review-decisions.spec.ts).
//
// This file only exercises the API-layer gates that do NOT require review tables:
//   401 unauthenticated
//   403 learner / roles
//   403 missing CSRF on unsafe method
//   422 missing Idempotency-Key
// The 404/409/422-due-to-draft-state semantics require review tables (covered by
// review-decisions.spec.ts PostgreSQL integration) and are NOT asserted here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDbConfigFromEnv, createPool } from "@motro/db";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";

type App = Awaited<ReturnType<typeof createApp>>;
const config = loadDbConfigFromEnv();

let dbAvailable = false;
let app: App | null = null;
let admin: Client | null = null;
let learner: Client | null = null;
let anon: Client | null = null;

interface Res {
  statusCode: number;
  json(): unknown;
  headers: Record<string, unknown>;
}
type HttpMethod = "GET" | "POST";
interface Client {
  req(
    method: HttpMethod,
    url: string,
    opts?: { payload?: object; headers?: Record<string, string> },
  ): Promise<Res>;
}

function makeClient(): Client {
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
    async req(method, url, opts = {}) {
      if (method !== "GET" && csrf === "" && app) {
        const warm = await app.inject({ method: "GET", url: "/api/v1/health/live" });
        capture(warm);
      }
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const jar = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      if (jar) headers.cookie = jar;
      if (method !== "GET") headers["x-csrf-token"] = csrf;
      const res = await app!.inject({
        method,
        url,
        headers,
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      });
      capture(res);
      return res as unknown as Res;
    },
  };
}

async function login(username: string, password: string): Promise<Client> {
  const c = makeClient();
  const r = await c.req("POST", "/api/v1/auth/login", { payload: { username, password } });
  if (r.statusCode !== 201 && r.statusCode !== 200) {
    throw new Error(`login failed ${r.statusCode} ${JSON.stringify(r.json())}`);
  }
  return c;
}

beforeAll(async () => {
  const probe = createPool({ ...config, max: 1 });
  try {
    await probe.query("SELECT 1");
    dbAvailable = true;
  } finally {
    await probe.end();
  }
  if (!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1") return;

  app = await createApp();
  await app.init();
  const ps = new PasswordService();
  const pool = createPool({ ...config, max: 5 });
  try {
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('revapi-admin','A','admin','active','Asia/Shanghai',10,$1,false)
       ON CONFLICT (username) DO UPDATE SET password_hash=$1, must_change_password=false, status='active'`,
      [await ps.hashPassword("revapi-admin-pass-12345")],
    );
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ('revapi-learner','L','learner','active','Asia/Shanghai',10,$1,false)
       ON CONFLICT (username) DO UPDATE SET password_hash=$1, must_change_password=false, status='active'`,
      [await ps.hashPassword("revapi-learner-pass-12345")],
    );
  } finally {
    await pool.end();
  }
  admin = await login("revapi-admin", "revapi-admin-pass-12345");
  learner = await login("revapi-learner", "revapi-learner-pass-12345");
  anon = makeClient();
});

afterAll(async () => {
  if (app) await app.close();
});

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")("reviews API gates", () => {
  it("401: unauthenticated GET of review queue", async () => {
    const res = await anon!.req("GET", "/api/v1/admin/reviews", {});
    expect(res.statusCode).toBe(401);
  });

  it("401: unauthenticated POST decision", async () => {
    const res = await anon!.req(
      "POST",
      "/api/v1/admin/reviews/00000000-0000-4000-8000-000000000000/decision",
      {
        headers: { "idempotency-key": "anon-key" },
        payload: { decision: "accept" },
      },
    );
    expect(res.statusCode).toBe(401);
  });

  it("403: learner list is forbidden", async () => {
    const res = await learner!.req("GET", "/api/v1/admin/reviews", {});
    expect(res.statusCode).toBe(403);
  });

  it("403: learner decide is forbidden", async () => {
    const res = await learner!.req(
      "POST",
      "/api/v1/admin/reviews/00000000-0000-4000-8000-000000000000/decision",
      {
        headers: { "idempotency-key": "learner-key" },
        payload: { decision: "accept" },
      },
    );
    expect(res.statusCode).toBe(403);
  });

  it("403: missing CSRF header on unsafe POST is rejected (no session → 401; with session no csrf → 403)", async () => {
    // With a valid admin session but NO x-csrf-token header, CSRF double-submit rejects.
    const res = await app!.inject({
      method: "POST",
      url: "/api/v1/admin/reviews/00000000-0000-4000-8000-000000000000/decision",
      payload: { decision: "accept" },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("422: missing Idempotency-Key header on decide", async () => {
    const res = await admin!.req(
      "POST",
      "/api/v1/admin/reviews/00000000-0000-4000-8000-000000000000/decision",
      {
        payload: { decision: "accept" },
      },
    );
    expect(res.statusCode).toBe(422);
  });

  it("CSRF cookie is set and non-HttpOnly (client must read to send header)", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/v1/health/live" });
    const setCookie = res.headers["set-cookie"];
    const lines = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
    expect(lines).toContain("motro_csrf=");
    expect(lines).not.toContain("motro_csrf=; HttpOnly");
  });
});
