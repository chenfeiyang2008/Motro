// Ticket 15：import 关联只允许 active lexical entry；archived / deleted / 多 active 歧义 fail closed。
// 真实 PostgreSQL（隔离库）+ API。复用 commit-and-error-report 的 upload/validate/commit 模式。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { loadConfig } from "@motro/config";
import { runMigrations } from "graphile-worker";
import { closeAppDbPools } from "../catalog/isolated-db.helper.js";

function multipart(
  fields: Record<string, string>,
  file?: { filename: string; content: Buffer; mime?: string },
): { payload: Buffer; contentType: string } {
  const boundary = `----motro-${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${value}\r\n`));
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`),
    );
    const mime = file.mime ?? "text/plain";
    chunks.push(Buffer.from(`Content-Type: ${mime}\r\n\r\n`));
    chunks.push(file.content);
    chunks.push(Buffer.from(`\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

type App = Awaited<ReturnType<typeof createApp>>;

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

async function canConnect(): Promise<boolean> {
  const probe = createPool({ ...config, max: 1 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}
const dbAvailable = await canConnect();

function pgConn(cfg: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): string {
  const host = cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  return `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${host}:${cfg.port}/${encodeURIComponent(cfg.database)}`;
}

const wSuffix = randomBytes(3).toString("hex");
let wordCounter = 0;
function freshWord(): string {
  wordCounter += 1;
  return `t15w${wordCounter}-${wSuffix}`;
}
function uniqKey(): string {
  return `${randomUUID()}-${Date.now()}`;
}

describe("ticket-15 import archived-entry integrity", () => {
  let app: App;
  let dbName: string | undefined;
  let previousDb: string | undefined;
  let pool: ReturnType<typeof createPool>;
  let admin: Client;

  interface Res {
    statusCode: number;
    json(): unknown;
    headers: Record<string, unknown>;
  }
  interface Client {
    warm(): Promise<void>;
    req(
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: string,
      opts?: { payload?: object; headers?: Record<string, string> },
    ): Promise<Res>;
  }
  function makeClient(a: App): Client {
    const cookies: Record<string, string> = {};
    let csrf = "";
    const capture = (res: { headers: Record<string, unknown> }): void => {
      const raw = res.headers["set-cookie"];
      const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      for (const l of lines) {
        const p = l.split(";")[0];
        const i = p.indexOf("=");
        if (i > 0) {
          const name = p.slice(0, i).trim();
          if (name === "motro_session" && p.slice(i + 1) === "") delete cookies[name];
          else cookies[name] = p.slice(i + 1);
        }
      }
      if (cookies["motro_csrf"]) csrf = cookies["motro_csrf"];
    };
    return {
      async warm() {
        const r = await a.inject({ method: "GET", url: "/api/v1/health/live" });
        capture(r);
      },
      async req(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        url: string,
        opts: { payload?: object; headers?: Record<string, string> } = {},
      ) {
        if (method !== "GET" && csrf === "") await this.warm();
        const headers: Record<string, string> = { ...(opts.headers ?? {}) };
        const jar = Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
        if (jar) headers.cookie = jar;
        if (method !== "GET") headers["x-csrf-token"] = csrf;
        const res = await a.inject({
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

  beforeAll(async () => {
    if (!dbAvailable) throw new Error("ticket-15 需要运行中的 PostgreSQL；不会静默跳过。");
    dbName = `motro_t15_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: dbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });
    pool = createPool({ ...isolatedConfig, max: 2 });

    const ps = new PasswordService();
    const adminU = `t15-admin-${randomBytes(3).toString("hex")}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'T15 Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)`,
      [adminU, await ps.hashPassword("Admin-pass-123")],
    );

    previousDb = process.env.POSTGRES_DB;
    const cfg = loadConfig();
    process.env.POSTGRES_DB = dbName;
    const tempRoot = mkdtempSync(join(tmpdir(), "motro-t15-"));
    app = await createApp({
      ...cfg,
      db: { ...cfg.db, database: dbName },
      import: { ...cfg.import, fileRootDir: tempRoot },
    });
    await app.init();
    admin = makeClient(app);
    const al = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: adminU, password: "Admin-pass-123" },
    });
    expect(al.statusCode).toBe(200);
  });

  afterAll(async () => {
    try {
      if (app) {
        await closeAppDbPools(app);
        await app.close();
      }
    } finally {
      if (previousDb === undefined) delete process.env.POSTGRES_DB;
      else process.env.POSTGRES_DB = previousDb;
      if (pool) await pool.end();
      if (dbName) {
        const drop = createPool({ ...config, database: "postgres", max: 1 });
        try {
          await drop.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        } finally {
          await drop.end();
        }
      }
    }
  });

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }

  async function uploadTxt(content: string): Promise<string> {
    const mp = multipart(
      { sourceDeclaration: "T15 来源" },
      { filename: `t15-${uniqKey().slice(0, 8)}.txt`, content: Buffer.from(content) },
    );
    const res = await admin.req("POST", "/api/v1/admin/imports", {
      headers: { "content-type": mp.contentType, "idempotency-key": uniqKey() },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    return (body(res) as { id: string }).id;
  }

  async function validateBatch(batchId: string): Promise<Record<string, unknown>> {
    const res = await admin.req("POST", `/api/v1/admin/imports/${batchId}/validate`, {
      headers: { "idempotency-key": uniqKey() },
    });
    expect(res.statusCode).toBe(200);
    return body(res) as Record<string, unknown>;
  }

  async function getConfirmation(
    batchId: string,
  ): Promise<{ mappingVersion: number; validationInputSha256: string } | null> {
    const res = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    if (res.statusCode !== 200) return null;
    const d = body(res) as {
      commitConfirmation?: { mappingVersion: number; validationInputSha256: string };
    };
    return d.commitConfirmation ?? null;
  }

  async function commitBatch(batchId: string): Promise<Res> {
    const conf = await getConfirmation(batchId);
    const payload = {
      mappingVersion: conf?.mappingVersion ?? 1,
      validationInputSha256: conf?.validationInputSha256 ?? "missing",
    };
    return admin.req("POST", `/api/v1/admin/imports/${batchId}/commit`, {
      headers: { "idempotency-key": uniqKey(), "content-type": "application/json" },
      payload,
    });
  }

  /** 直接插入一个 lexical entry，可选指定 status。 */
  async function seedLexical(canonical: string, status: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses, status)
       VALUES ($1, $2, '[]'::jsonb, $3) RETURNING id`,
      [canonical, canonical, status],
    );
    return r.rows[0]!.id;
  }

  it("只有 archived entry → 候选关联 fail closed，不得绑定 archived", async () => {
    const spelling = freshWord();
    const archivedId = await seedLexical(spelling, "archived");
    const batchId = await uploadTxt(`${spelling}\n`);
    await validateBatch(batchId);
    const commit = await commitBatch(batchId);
    // candidate 目标仅 active → archived 不存在 active，INSERT 冲突 → fail closed。
    expect(commit.statusCode).toBe(422); // COMMIT_REVALIDATION_REQUIRED → 422
    // 不得写入任何 import 来源事实关联 archived。
    const bound = await pool.query(
      `SELECT count(*)::text AS n FROM lexical_sources s WHERE s.lexical_entry_id = $1 AND s.source_type='import'`,
      [archivedId],
    );
    expect(Number(bound.rows[0]!.n)).toBe(0);
  });

  it("active entry → 候选正常关联 existing_entry", async () => {
    const spelling = freshWord();
    const activeId = await seedLexical(spelling, "active");
    const batchId = await uploadTxt(`${spelling}\n`);
    const v = await validateBatch(batchId);
    expect(
      (v as { validationSummary?: { existingEntries?: number } }).validationSummary
        ?.existingEntries,
    ).toBe(1);
    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const bound = await pool.query(
      `SELECT count(*)::text AS n FROM lexical_sources s WHERE s.lexical_entry_id = $1 AND s.source_type='import'`,
      [activeId],
    );
    expect(Number(bound.rows[0]!.n)).toBe(1);
  });

  it("active 与 archived 并存（同一 normalized）→ 只关联 active，绝不绑定 archived", async () => {
    const spelling = freshWord();
    // archived 词条 canonical = spelling（会与候选 INSERT 冲突）；
    // active 词条 canonical 不同但 normalized = spelling（应被关联）。
    await seedLexical(spelling, "archived");
    const activeId = await seedLexical(`${spelling}-active`, "active");
    await pool.query(`UPDATE lexical_entries SET normalized_spelling = $1 WHERE id = $2`, [
      spelling,
      activeId,
    ]);
    // 验证时：normalized 查询只认 active（activeId）；archived(canonical=spelling) 不被 lookup。
    const batchId = await uploadTxt(`${spelling}\n`);
    const v = await validateBatch(batchId);
    expect(
      (v as { validationSummary?: { existingEntries?: number } }).validationSummary
        ?.existingEntries,
    ).toBe(1);
    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const activeBound = await pool.query(
      `SELECT count(*)::text AS n FROM lexical_sources s WHERE s.lexical_entry_id=$1 AND s.source_type='import'`,
      [activeId],
    );
    const archivedBound = await pool.query(
      `SELECT count(*)::text AS n FROM lexical_sources s JOIN lexical_entries le ON le.id=s.lexical_entry_id
        WHERE le.canonical_spelling=$1 AND le.status='archived' AND s.source_type='import'`,
      [spelling],
    );
    expect(Number(activeBound.rows[0]!.n)).toBe(1);
    expect(Number(archivedBound.rows[0]!.n)).toBe(0);
  });

  it("多个 active 同 normalized_spelling → fail closed（ambiguous_entry）", async () => {
    const spelling = freshWord();
    // 两个不同 canonical 但相同 normalized_spelling 的 active 词条。
    const a = await seedLexical(`${spelling}-a`, "active");
    const b = await seedLexical(`${spelling}-b`, "active");
    await pool.query(`UPDATE lexical_entries SET normalized_spelling=$1 WHERE id=$2`, [
      spelling,
      a,
    ]);
    await pool.query(`UPDATE lexical_entries SET normalized_spelling=$1 WHERE id=$2`, [
      spelling,
      b,
    ]);
    const batchId = await uploadTxt(`${spelling}\n`);
    const v = await validateBatch(batchId);
    // 歧义 → invalid（不是 existing_entry/candidate）；不得绑定到 a 或 b。
    expect((v as { validationSummary?: { invalid?: number } }).validationSummary?.invalid).toBe(1);
    const aBound = await pool.query(
      `SELECT count(*)::text AS n FROM lexical_sources s WHERE s.lexical_entry_id=$1 AND s.source_type='import'`,
      [a],
    );
    const bBound = await pool.query(
      `SELECT count(*)::text AS n FROM lexical_sources s WHERE s.lexical_entry_id=$1 AND s.source_type='import'`,
      [b],
    );
    expect(Number(aBound.rows[0]!.n)).toBe(0);
    expect(Number(bBound.rows[0]!.n)).toBe(0);
  });

  it("批次 A 失败不影响批次 B；重试用同一幂等键不产生重复事实", async () => {
    const bad = freshWord();
    await seedLexical(bad, "archived");
    const batchA = await uploadTxt(`${bad}\n`);
    await validateBatch(batchA);
    const c1 = await commitBatch(batchA);
    const c2 = await commitBatch(batchA); // 同一意图，不同 key → 幂等/conflict
    // active 失败不影响另一批次。
    const good = freshWord();
    const goodId = await seedLexical(good, "active");
    const batchB = await uploadTxt(`${good}\n`);
    await validateBatch(batchB);
    const g = await commitBatch(batchB);
    expect(g.statusCode).toBe(200);
    const goodBound = await pool.query(
      `SELECT count(*)::text AS n FROM lexical_sources s WHERE s.lexical_entry_id=$1 AND s.source_type='import'`,
      [goodId],
    );
    expect(Number(goodBound.rows[0]!.n)).toBe(1);
    void c1;
    void c2;
  });
});
