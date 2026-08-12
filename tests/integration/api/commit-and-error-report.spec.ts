// 阶段 6 工单 03 集成验收：提交有效行 + 错误报告（真实 PostgreSQL + multipart）。
// 覆盖：
//   1. 原子混合批次提交：有效候选提交；invalid/duplicate/existing 不产生重复词条
//   2. 新建词条与 lexical_sources(source_type=import) 来源事实
//   3. 系统已有词条确定性关联（不重建）
//   4. 同 key + 同语义重放：返回原始结果，无重复词条/来源/行事实/审计
//   5. 同 key + 不同语义 → 409 IDEMPOTENCY_CONFLICT
//   6. 并发不同 key：行/词条/来源/审计只提交一次
//   7. stale 映射 / 未校验 / 无候选 → 结构化错误，不产生提交事实
//   8. 提交失败回滚所有部分写入
//   9. 错误报告内容、CSV 引号、公式中和、无敏感字段泄漏
//   10. 学习者与未认证拒绝
//   11. 证明不创建 course/release/card/review/XP/challenge/worker 事实
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { loadConfig } from "@motro/config";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { AuthModule } from "../../../apps/api/src/auth/auth.module.js";
import { POOL, type Pool } from "../../../apps/api/src/auth/database.provider.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { CatalogModule } from "../../../apps/api/src/modules/catalog/catalog.module.js";
import { StudyModule } from "../../../apps/api/src/modules/study/study.module.js";
import { ImportModule } from "../../../apps/api/src/modules/admin/imports/import.module.js";

type App = Awaited<ReturnType<typeof createApp>>;

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const previousImportFileRootDir = process.env.IMPORT_FILE_ROOT_DIR;
const previousPostgresDb = process.env.POSTGRES_DB;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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

interface Res {
  statusCode: number;
  json(): unknown;
  headers: Record<string, unknown>;
  body?: unknown;
  rawPayload?: unknown;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface Client {
  warm(): Promise<void>;
  req(
    method: HttpMethod,
    url: string,
    opts?: { payload?: object | Buffer; headers?: Record<string, string> },
  ): Promise<Res>;
}

function makeClient(app: App): Client {
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
      capture(res);
      return res as unknown as Res;
    },
  };
}

/**
 * 当前模块各自装配数据库 provider；Nest 关闭应用不会自动 end 原生 pg Pool。
 * 隔离数据库销毁前显式关闭每个模块的池，避免用 FORCE/terminate 绕过正常生命周期。
 */
async function closeModulePools(app: App): Promise<void> {
  const modules = [AuthModule, CatalogModule, StudyModule, ImportModule];
  const pools = new Set<Pool>();
  for (const module of modules) {
    pools.add(app.select(module).get<Pool>(POOL, { strict: true }));
  }
  await Promise.all([...pools].map((modulePool) => modulePool.end()));
}

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

describe("import commit valid rows and error report", () => {
  let app: App;
  let admin: Client;
  let learner: Client;
  let anon: Client;
  let tempImportRoot: string;
  let adminUserId: string;
  let pool: ReturnType<typeof createPool>;
  let isolatedDbName: string | undefined;

  const wSuffix = randomBytes(4).toString("hex");
  // 每个测试用全新唯一单词，避免跨测试复用导致「已提交 → existing_entry」干扰断言。
  let wordCounter = 0;
  function freshWord(): string {
    wordCounter += 1;
    return `crw${wordCounter}-${wSuffix}`;
  }
  const EXISTING_WORD = `crexist${wSuffix}`;

  function uniqKey(): string {
    return `${randomUUID()}-${Date.now()}`;
  }

  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }

  async function uploadTxt(content: string): Promise<string> {
    const mp = multipart(
      { sourceDeclaration: "CR TXT 来源" },
      { filename: `cr-${uniqKey().slice(0, 8)}.txt`, content: Buffer.from(content) },
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

  /** 从批次详情读取提交确认身份（模拟 UI：GET 详情 → 回传 commitConfirmation）。 */
  async function getConfirmation(batchId: string): Promise<{
    mappingVersion: number;
    validationInputSha256: string;
  } | null> {
    const res = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    if (res.statusCode !== 200) return null;
    const d = body(res) as {
      commitConfirmation?: { mappingVersion: number; validationInputSha256: string };
    };
    return d.commitConfirmation ?? null;
  }

  async function commitBatch(
    batchId: string,
    opts: { mappingVersion?: number; validationInputSha256?: string; key?: string } = {},
  ): Promise<Res> {
    const key = opts.key ?? uniqKey();
    // P1-1：除非显式覆盖，否则总是从批次详情读取当前提交确认身份并原样回传。
    let mappingVersion = opts.mappingVersion;
    let validationInputSha256 = opts.validationInputSha256;
    if (mappingVersion === undefined || validationInputSha256 === undefined) {
      const conf = await getConfirmation(batchId);
      if (conf) {
        if (mappingVersion === undefined) mappingVersion = conf.mappingVersion;
        if (validationInputSha256 === undefined) {
          validationInputSha256 = conf.validationInputSha256;
        }
      }
    }
    if (mappingVersion === undefined) mappingVersion = 1;
    if (validationInputSha256 === undefined) validationInputSha256 = "missing";
    const payload: Record<string, unknown> = {
      mappingVersion,
      validationInputSha256,
    };
    return admin.req("POST", `/api/v1/admin/imports/${batchId}/commit`, {
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload,
    });
  }

  async function q1<T extends Record<string, unknown> = { n: string }>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const r = await pool.query<T>(sql, params);
    return r.rows[0] ?? null;
  }

  async function qcount(sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query<{ n: string }>(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "commit-and-error-report 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。",
      );
    }
    // 本套件会产生数据库层刻意禁止删除的 commit facts。为避免在共享开发库中
    // DISABLE TRIGGER 清理不可变事实，整套测试运行在一次性隔离数据库中；测试结束后
    // 关闭所有连接并销毁整个数据库。数据库名只由时间戳和随机十六进制组成，可安全
    // 作为受双引号保护的标识符使用。
    isolatedDbName = `motro_import_commit_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-import-cr-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.IMPORT_MAX_FILE_BYTES = String(6 * 1024 * 1024);

    const suffix = randomBytes(3).toString("hex");
    const ps = new PasswordService();
    pool = createPool({ ...isolatedConfig, max: 1 });
    const adminU = `cr-admin-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'CR Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminU, await ps.hashPassword("Admin-pass-123")],
    );
    const adminRow = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
      adminU,
    ]);
    adminUserId = adminRow.rows[0]!.id;
    const learnerU = `cr-learner-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'CR Learner', 'learner', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [learnerU, await ps.hashPassword("learner-pass-123")],
    );
    await pool.end();
    pool = createPool({ ...isolatedConfig, max: 2 });

    const cfg = loadConfig();
    // 当前数据库 provider 仍从环境读取配置；在装配 Nest 应用期间把进程指向隔离库，
    // 并在套件结束后恢复。这样所有模块共用同一隔离事实源，而非只有传入 createApp 的
    // health/config 表面切换到隔离库。
    process.env.POSTGRES_DB = isolatedDbName;
    app = await createApp({
      ...cfg,
      db: { ...cfg.db, database: isolatedDbName },
      import: { ...cfg.import, fileRootDir: tempImportRoot },
    });
    await app.init();
    admin = makeClient(app);
    learner = makeClient(app);
    anon = makeClient(app);
    const al = await admin.req("POST", "/api/v1/auth/login", {
      payload: { username: adminU, password: "Admin-pass-123" },
    });
    expect(al.statusCode).toBe(200);
    const ll = await learner.req("POST", "/api/v1/auth/login", {
      payload: { username: learnerU, password: "learner-pass-123" },
    });
    expect(ll.statusCode).toBe(200);
  });

  afterAll(async () => {
    try {
      if (app) {
        await closeModulePools(app);
        await app.close();
      }
      if (pool) await pool.end();
      if (isolatedDbName) {
        const dropPool = createPool({ ...config, database: "postgres", max: 1 });
        try {
          await dropPool.query(`DROP DATABASE IF EXISTS "${isolatedDbName}"`);
        } finally {
          await dropPool.end();
        }
      }
    } finally {
      try {
        rmSync(tempImportRoot, { recursive: true, force: true });
      } catch {
        // 忽略。
      }
      restoreEnv("IMPORT_FILE_ROOT_DIR", previousImportFileRootDir);
      restoreEnv("POSTGRES_DB", previousPostgresDb);
    }
  });

  it("1. 原子混合批次提交：有效候选提交；invalid/duplicate/existing 不产生重复词条", async () => {
    // 预置一个系统词条。
    await pool.query(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
       VALUES ($1, $1, '[]'::jsonb) ON CONFLICT (canonical_spelling) DO NOTHING`,
      [EXISTING_WORD],
    );
    const cw1 = freshWord();
    const cw2 = freshWord();
    const cw3 = freshWord();
    // 文件：EXISTING_WORD（已有）、cw1 重复两次、非法"1234"、cw2、cw3。
    const batchId = await uploadTxt(`${EXISTING_WORD}\n${cw1}\n${cw1}\n1234\n${cw2}\n${cw3}\n`);
    const v = await validateBatch(batchId);
    expect(v.validationStatus).toBe("validated");
    const vs = v.validationSummary as {
      candidates: number;
      duplicates: number;
      existingEntries: number;
      invalid: number;
    };
    // EXISTING_WORD 是 existing_entry（非 candidate）。cw1 第一条、cw2、cw3 = 3 candidates。
    expect(vs.candidates).toBe(3);
    expect(vs.existingEntries).toBe(1);
    expect(vs.duplicates).toBe(1);
    expect(vs.invalid).toBe(1);

    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const c = body(commit) as {
      createdEntryCount: number;
      associatedExistingEntryCount: number;
      skippedCountByDisposition: Record<string, number>;
      committedRowCount: number;
      isIdempotentReplay: boolean;
    };
    // EXISTING_WORD 行 existing_entry → 关联既有词条（P1-2，不再跳过）；
    // cw1 第 2 行 duplicate_in_file（跳过）；1234 invalid（跳过）；
    // cw1 第 1 行 + cw2 + cw3 = 3 个新词条。
    expect(c.createdEntryCount).toBe(3);
    expect(c.associatedExistingEntryCount).toBe(1);
    expect(c.skippedCountByDisposition).toEqual({
      invalid: 1,
      duplicate_in_file: 1,
    });
    expect(c.committedRowCount).toBe(4);
    expect(c.isIdempotentReplay).toBe(false);

    // 词条数量与规范化拼写正确（无重复创建）。
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw1],
      ),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw2],
      ),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw3],
      ),
    ).toBe(1);
    // EXISTING_WORD 未被重建（仍是 1 条）。
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [EXISTING_WORD],
      ),
    ).toBe(1);
  });

  it("2. 新建词条与 lexical_sources(source_type=import) 来源事实", async () => {
    const cw = freshWord();
    const batchId = await uploadTxt(`${cw}\n`);
    await validateBatch(batchId);
    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const c = body(commit) as { createdEntryCount: number; committedRowCount: number };
    expect(c.createdEntryCount).toBe(1);
    expect(c.committedRowCount).toBe(1);

    const src = await q1<{ n: string; source_type: string }>(
      `SELECT count(*)::text AS n, max(source_type) AS source_type
       FROM lexical_sources ls
       JOIN import_batch_commit_rows cr ON ls.lexical_entry_id = cr.created_entry_id
       WHERE cr.normalized_spelling = $1 AND ls.source_type = 'import'`,
      [cw],
    );
    expect(Number(src?.n ?? 0)).toBe(1);
    expect(src?.source_type).toBe("import");

    // 提交事实不可变（无法 UPDATE/DELETE）。
    const commitRows = await pool.query<{ id: string }>(
      `SELECT id FROM import_batch_commits WHERE batch_id = $1`,
      [batchId],
    );
    const commitId = commitRows.rows[0]?.id;
    expect(commitId).toBeTruthy();
    await expect(
      pool.query(`UPDATE import_batch_commits SET created_entry_count = 99 WHERE id = $1`, [
        commitId,
      ]),
    ).rejects.toThrow();
  });

  it("3. 系统已有词条确定性关联（不重建；并发创建竞态）", async () => {
    // 词条在「校验后、提交前」被并发创建：模拟另一进程/提交恰好创建了同拼写词条。
    const existingForAssoc = freshWord();
    const batchId = await uploadTxt(`${existingForAssoc}\n`);
    // 校验时该词条尚不存在 → candidate。
    await validateBatch(batchId);
    // 提交前并发插入同拼写词条（模拟竞态）。
    await pool.query(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
       VALUES ($1, $1, '[]'::jsonb) ON CONFLICT (canonical_spelling) DO NOTHING`,
      [existingForAssoc],
    );
    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const c = body(commit) as {
      createdEntryCount: number;
      associatedExistingEntryCount: number;
      skippedCountByDisposition: Record<string, number>;
    };
    // 提交时发现同拼写词条已存在 → 确定性关联（associated），不新建、不报错。
    expect(c.associatedExistingEntryCount).toBe(1);
    expect(c.createdEntryCount).toBe(0);
    expect(c.skippedCountByDisposition).toEqual({});

    // 关联来源存在且词条唯一。
    const link = await q1<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM lexical_sources ls
       JOIN import_batch_commit_rows cr ON ls.lexical_entry_id = cr.associated_entry_id
       WHERE cr.normalized_spelling = $1 AND ls.source_type = 'import'`,
      [existingForAssoc],
    );
    expect(Number(link?.n ?? 0)).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [existingForAssoc],
      ),
    ).toBe(1);
  });

  it("3b. 校验分类 existing_entry 行在提交时关联既有词条（P1-2），不重建、不静默忽略", async () => {
    // 词条在校验前已存在 → validate 把该行归类为 existing_entry（携带 lexical_entry_id）。
    const preExisting = freshWord();
    await pool.query(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
       VALUES ($1, $1, '[]'::jsonb) ON CONFLICT (canonical_spelling) DO NOTHING`,
      [preExisting],
    );
    const batchId = await uploadTxt(`${preExisting}\n${freshWord()}\n`);
    await validateBatch(batchId);
    // 确认校验分类仍是 existing_entry（原始 disposition 不可变）。
    const beforeRows = await admin.req("GET", `/api/v1/admin/imports/${batchId}/rows`, {});
    const bRows = body(beforeRows) as { items: { status: string }[] };
    expect(bRows.items.find((r) => r.status === "existing_entry")).toBeTruthy();

    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const c = body(commit) as {
      createdEntryCount: number;
      associatedExistingEntryCount: number;
      committedRowCount: number;
    };
    // existing_entry 行关联既有词条（associated），另一行 candidate 新建。
    expect(c.associatedExistingEntryCount).toBe(1);
    expect(c.createdEntryCount).toBe(1);
    expect(c.committedRowCount).toBe(2);

    // 不可变提交事实存在：associated_entry_id 指向预置词条，来源为 import。
    const fact = await q1<{ n: string; associated: string | null; src_type: string }>(
      `SELECT count(*)::text AS n,
              (array_agg(cr.associated_entry_id))[1] AS associated,
              (array_agg(ls.source_type))[1] AS src_type
       FROM import_batch_commit_rows cr
       JOIN lexical_sources ls ON ls.id = cr.lexical_source_id
       WHERE cr.import_row_id IN (SELECT id FROM import_rows WHERE batch_id = $1 AND status = 'existing_entry')`,
      [batchId],
    );
    expect(Number(fact?.n ?? 0)).toBe(1);
    expect(fact?.associated).toBeTruthy();
    expect(fact?.src_type).toBe("import");

    // 词条未被重建（仍是 1 条）。
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [preExisting],
      ),
    ).toBe(1);
  });

  it("4. 同 key + 同语义重放：返回原始结果，无重复词条/来源/行事实/审计", async () => {
    const cw = freshWord();
    const batchId = await uploadTxt(`${cw}\n`);
    await validateBatch(batchId);
    const key = uniqKey();
    const c1 = await commitBatch(batchId, { key });
    expect(c1.statusCode).toBe(200);
    const first = body(c1) as {
      createdEntryCount: number;
      committedRowCount: number;
      isIdempotentReplay: boolean;
    };
    expect(first.createdEntryCount).toBe(1);
    expect(first.isIdempotentReplay).toBe(false);

    const c2 = await commitBatch(batchId, { key });
    expect(c2.statusCode).toBe(200);
    const second = body(c2) as {
      createdEntryCount: number;
      committedRowCount: number;
      isIdempotentReplay: boolean;
    };
    expect(second.isIdempotentReplay).toBe(true);
    expect(second.committedRowCount).toBe(1);
    expect(second.createdEntryCount).toBe(1);

    // 无重复事实。
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw],
      ),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_sources ls JOIN import_batch_commit_rows cr ON ls.lexical_entry_id = cr.created_entry_id WHERE cr.normalized_spelling = $1`,
        [cw],
      ),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM import_batch_commit_rows cr JOIN import_rows r ON r.id = cr.import_row_id WHERE r.batch_id = $1`,
        [batchId],
      ),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM audit_events WHERE actor_id = $1 AND action = 'admin.import.commit' AND target_id = $2`,
        [adminUserId, batchId],
      ),
    ).toBe(1);
  });

  it("5. 同 key + 不同语义 → 409 IDEMPOTENCY_CONFLICT", async () => {
    const cw = freshWord();
    const batchId = await uploadTxt(`${cw}\n`);
    await validateBatch(batchId);
    const key = uniqKey();
    const ok = await commitBatch(batchId, { key });
    expect(ok.statusCode).toBe(200);
    // 同 key 但不同 mappingVersion（语义不同）→ 409。
    const conflict = await commitBatch(batchId, { key, mappingVersion: 999 });
    expect(conflict.statusCode).toBe(409);
    expect((body(conflict) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("6. 并发不同 key：行/词条/来源/审计只提交一次", async () => {
    const cw1 = freshWord();
    const cw2 = freshWord();
    const batchId = await uploadTxt(`${cw1}\n${cw2}\n`);
    await validateBatch(batchId);
    // 并发两次不同 key 提交。
    const [r1, r2] = await Promise.all([
      commitBatch(batchId, { key: uniqKey() }),
      commitBatch(batchId, { key: uniqKey() }),
    ]);
    // 两者都成功（一个真正提交，另一个拿到既有提交事实）。
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const c1 = body(r1) as { committedRowCount: number };
    const c2 = body(r2) as { committedRowCount: number };
    expect(c1.committedRowCount).toBe(2);
    expect(c2.committedRowCount).toBe(2);

    // 词条唯一、提交事实唯一、行提交事实唯一、审计批次提交唯一。
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw1],
      ),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw2],
      ),
    ).toBe(1);
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batch_commits WHERE batch_id = $1`, [
        batchId,
      ]),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM import_batch_commit_rows cr JOIN import_rows r ON r.id = cr.import_row_id WHERE r.batch_id = $1`,
        [batchId],
      ),
    ).toBe(2);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM audit_events WHERE actor_id = $1 AND action = 'admin.import.commit' AND target_id = $2`,
        [adminUserId, batchId],
      ),
    ).toBe(1);
  });

  it("7. stale 映射 / 未校验 / 无候选 不能提交", async () => {
    // 7a. 未校验。
    const unvalidated = await uploadTxt(`${freshWord()}\n`);
    const nv = await commitBatch(unvalidated, { mappingVersion: 1 });
    expect([409, 422]).toContain(nv.statusCode);
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batch_commits WHERE batch_id = $1`, [
        unvalidated,
      ]),
    ).toBe(0);

    // 7b. 映射变更（stale）后提交 → 结构化 422/409。
    const batchId = await uploadTxt(`${freshWord()}\n`);
    await validateBatch(batchId);
    const detail = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d = body(detail) as { version: number };
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: {}, version: d.version },
    });
    expect(patch.statusCode).toBe(200);
    const afterPatch = body(patch) as { mappingVersion: number };
    expect(afterPatch.mappingVersion).toBe(2);
    // 用旧 mappingVersion 提交 → 过期。
    const stale = await commitBatch(batchId, { mappingVersion: 1 });
    expect([409, 422]).toContain(stale.statusCode);
    expect((body(stale) as { error?: { code: string } }).error?.code).toMatch(
      /COMMIT_STALE_MAPPING|IDEMPOTENCY_CONFLICT/,
    );
    // 用新 mappingVersion 但还没重新校验 → 结构化拒绝（未校验/过期/身份不匹配/无候选）。
    const nv2 = await commitBatch(batchId, { mappingVersion: 2 });
    expect([409, 422]).toContain(nv2.statusCode);
    expect((body(nv2) as { error?: { code: string } }).error?.code).toMatch(
      /COMMIT_NOT_VALIDATED|COMMIT_STALE_MAPPING|COMMIT_NO_ELIGIBLE_ROWS|COMMIT_VALIDATION_MISMATCH/,
    );
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batch_commits WHERE batch_id = $1`, [
        batchId,
      ]),
    ).toBe(0);

    // 7c. 全部行都不可提交（无候选）。
    const allInvalid = await uploadTxt(`1234\n\n`);
    await validateBatch(allInvalid);
    const noEligible = await commitBatch(allInvalid, { mappingVersion: 1 });
    expect([409, 422]).toContain(noEligible.statusCode);
    expect((body(noEligible) as { error?: { code: string } }).error?.code).toBe(
      "COMMIT_NO_ELIGIBLE_ROWS",
    );
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batch_commits WHERE batch_id = $1`, [
        allInvalid,
      ]),
    ).toBe(0);
  });

  it("8. 提交失败回滚所有部分写入", async () => {
    // 用「断开的批」（不存在）验证 404 不产生任何提交事实。
    const missing = await commitBatch(randomUUID());
    expect([404, 409, 422]).toContain(missing.statusCode);

    // 语义错误的同 key 第二次提交 → 409，不产生新的行级事实。
    const cw = freshWord();
    const batchId = await uploadTxt(`${cw}\n`);
    await validateBatch(batchId);
    const key = uniqKey();
    const first = await commitBatch(batchId, { key });
    expect(first.statusCode).toBe(200);
    const conflict = await commitBatch(batchId, { key, mappingVersion: 999 });
    expect(conflict.statusCode).toBe(409);
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batch_commits WHERE batch_id = $1`, [
        batchId,
      ]),
    ).toBe(1);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM import_batch_commit_rows cr JOIN import_rows r ON r.id = cr.import_row_id WHERE r.batch_id = $1`,
        [batchId],
      ),
    ).toBe(1);
  });

  it("8b. 真实中途事务回滚（P2-2）：词条/来源已写、批次提交插入失败 → 全部回滚", async () => {
    const cw = freshWord();
    const batchId = await uploadTxt(`${cw}\n`);
    await validateBatch(batchId);

    // 安装临时触发器：在 import_batch_commits INSERT 后抛错，强制中途失败。
    const tmpFn = "motro_test_fail_commit_insert";
    const tmpTrig = "motro_test_fail_commit_insert_trig";
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${tmpFn}() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'P2-2 forced mid-transaction failure';
      END;
      $$ LANGUAGE plpgsql`);
    await pool.query(
      `CREATE TRIGGER ${tmpTrig} BEFORE INSERT ON import_batch_commits FOR EACH ROW EXECUTE FUNCTION ${tmpFn}()`,
    );

    let commitStatus: number | undefined;
    try {
      const res = await commitBatch(batchId);
      commitStatus = res.statusCode;
    } finally {
      // 无论成功与否，总是移除临时触发器/函数（测试不留残留）。
      await pool.query(`DROP TRIGGER IF EXISTS ${tmpTrig} ON import_batch_commits`).catch(() => {});
      await pool.query(`DROP FUNCTION IF EXISTS ${tmpFn}()`).catch(() => {});
    }
    // 提交必须失败（结构化的 500/422/409 均可；重点是事务回滚）。
    expect(commitStatus).toBeGreaterThanOrEqual(400);

    // 无任何部分事实残留。
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batches WHERE id = $1`, [batchId]),
    ).toBe(1);
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batch_commits WHERE batch_id = $1`, [
        batchId,
      ]),
    ).toBe(0);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM import_batch_commit_rows cr JOIN import_rows r ON r.id = cr.import_row_id WHERE r.batch_id = $1`,
        [batchId],
      ),
    ).toBe(0);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw],
      ),
    ).toBe(0);
    // 无该批次词条的任何 import 来源。
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_sources ls WHERE ls.source_note = 'import:commit:${batchId}'`,
        [],
      ),
    ).toBe(0);
    // 幂等记录中不得有指向本批次的 completed/pending 响应（本次失败已回滚）。
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM idempotency_keys WHERE scope = $1 AND response_json::text LIKE '%${batchId}%'`,
        [`import:commit:${adminUserId}`],
      ),
    ).toBe(0);
    // 批次保持未提交。
    const batchStatus = await q1<{ status: string }>(
      `SELECT status FROM import_batches WHERE id = $1`,
      [batchId],
    );
    expect(batchStatus?.status).not.toBe("committed");
  });

  it("9. 错误报告内容、CSV 引号、公式中和、无敏感字段泄漏", async () => {
    const cw = freshWord();
    // 行：非法"1234"、cw 重复两次（第 2 次 duplicate）、公式前缀=的重复行（neutralize）。
    // `=SUM` 是合法拼写（含英文）→ candidate；重复第 2 次 duplicate_in_file，rawSummary 以 = 开头。
    const batchId = await uploadTxt(`1234\n${cw}\n${cw}\n=SUM\n=SUM\n`);
    await validateBatch(batchId);
    const res = await admin.req("GET", `/api/v1/admin/imports/${batchId}/error-report`, {});
    expect(res.statusCode).toBe(200);
    const csv = String((res as unknown as { body: string }).body ?? "");
    // 表头存在。
    expect(csv).toContain("ordinal,rawSummary,status,errorCodes,duplicateOfOrdinal,mappingVersion");
    // 不包含存储路径、storage key、cookie 或原始文件路径。
    expect(csv).not.toContain("storage_key");
    expect(csv).not.toContain("/motro-import");
    expect(csv).not.toContain("motro_csrf");
    expect(csv).not.toContain("Admin-pass-123");
    // invalid 行与 duplicate 行在报告中；公式前缀已中和（'=SUM 是 duplicate 行）。
    expect(csv).toContain("invalid");
    expect(csv).toContain("duplicate_in_file");
    expect(csv).toContain("'=SUM");
    // 只有不可提交行，不含 candidate（=SUM 第 1 条是 candidate，不出现在报告中）。
    expect(csv).not.toContain("candidate");
    // CSV 引号：rawSummary 含逗号（以 , 分隔的字段被包裹）。用重复行强制进入报告。
    const commaBatch = await uploadTxt(`=a,b\n=a,b\n`);
    await validateBatch(commaBatch);
    const commaRes = await admin.req("GET", `/api/v1/admin/imports/${commaBatch}/error-report`, {});
    const commaCsv = String((commaRes as unknown as { body: string }).body ?? "");
    // 第 2 行 =a,b 是 duplicate_in_file → 中和公式 + 引号包裹（字段含逗号）。
    expect(commaCsv).toContain('"\'=a,b"');

    // 无错误行的批次 → 仅表头。
    const cleanBatch = await uploadTxt(`${freshWord()}\n`);
    await validateBatch(cleanBatch);
    const empty = await admin.req("GET", `/api/v1/admin/imports/${cleanBatch}/error-report`, {});
    const emptyCsv = String((empty as unknown as { body: string }).body ?? "");
    expect(emptyCsv.trim()).toBe(
      "ordinal,rawSummary,status,errorCodes,duplicateOfOrdinal,mappingVersion",
    );
  });

  it("10. 学习者与未认证拒绝 commit 与 error-report", async () => {
    const cw = freshWord();
    const batchId = await uploadTxt(`${cw}\n`);
    await validateBatch(batchId);
    const learnerCommit = await learner.req("POST", `/api/v1/admin/imports/${batchId}/commit`, {
      headers: { "idempotency-key": uniqKey() },
      payload: { mappingVersion: 1 },
    });
    expect([403, 404]).toContain(learnerCommit.statusCode);
    const learnerReport = await learner.req(
      "GET",
      `/api/v1/admin/imports/${batchId}/error-report`,
      {},
    );
    expect([403, 404]).toContain(learnerReport.statusCode);
    const anonCommit = await anon.req("POST", `/api/v1/admin/imports/${batchId}/commit`, {
      headers: { "idempotency-key": uniqKey() },
      payload: { mappingVersion: 1 },
    });
    expect([401, 403, 404]).toContain(anonCommit.statusCode);
    const anonReport = await anon.req("GET", `/api/v1/admin/imports/${batchId}/error-report`, {});
    expect([401, 403, 404]).toContain(anonReport.statusCode);
  });

  it("11. 证明不创建 course/release/card/review 事实", async () => {
    const before = await pool.query(
      `SELECT
        (SELECT count(*)::text FROM courses) AS courses,
        (SELECT count(*)::text FROM course_releases) AS releases,
        (SELECT count(*)::text FROM learning_cards) AS cards,
        (SELECT count(*)::text FROM review_events) AS reviews`,
    );
    const beforeRow = before.rows[0] as Record<string, string>;
    // 提交一批并关联既有词条。
    const batchId = await uploadTxt(`${freshWord()}\n${freshWord()}\n`);
    await validateBatch(batchId);
    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const after = await pool.query(
      `SELECT
        (SELECT count(*)::text FROM courses) AS courses,
        (SELECT count(*)::text FROM course_releases) AS releases,
        (SELECT count(*)::text FROM learning_cards) AS cards,
        (SELECT count(*)::text FROM review_events) AS reviews`,
    );
    const afterRow = after.rows[0] as Record<string, string>;
    for (const key of ["courses", "releases", "cards", "reviews"]) {
      expect(afterRow[key]).toBe(beforeRow[key]);
    }
  });

  /**
   * 建立负面案例 fixture：
   *   - 一个「已提交」的 commit（含合法 commit_row，占用一个 import_row_id）；
   *   - 一个【未提交】的 import_row（供负面 INSERT 使用，避免 UNIQUE(import_row_id)）；
   *   - 一个【全新、未提交】的 target entry 及其实用 import source（供负面 INSERT 作为
   *     canonical lexical_entry_id，避免 UNIQUE(commit_id, lexical_entry_id) 提前命中）。
   */
  async function freshNegativeFixture(): Promise<{
    commitId: string;
    uncommittedRowId: string;
    targetEntryId: string;
    targetSourceId: string;
  }> {
    const w1 = freshWord();
    const w2 = freshWord();
    const batchId = await uploadTxt(`${w1}\n${w2}\n`);
    await validateBatch(batchId);
    // 提交 w1（创建合法 commit + commit_row），w2 保持未提交。
    const ok = await commitBatch(batchId);
    expect(ok.statusCode).toBe(200);
    const cr = await q1<{ commit_id: string }>(
      `SELECT cr.commit_id FROM import_batch_commit_rows cr
       JOIN import_rows r ON r.id = cr.import_row_id WHERE r.batch_id = $1 LIMIT 1`,
      [batchId],
    );
    // w2 单独建批次、校验但不提交 → 拿到未提交的 import_row_id。
    const batch2 = await uploadTxt(`${w2}\n`);
    await validateBatch(batch2);
    const row2 = await q1<{ id: string }>(
      `SELECT id FROM import_rows WHERE batch_id = $1 AND normalized_spelling = $2 LIMIT 1`,
      [batch2, w2],
    );
    // 全新 target entry + 其实用 import source（未提交）。
    const targetWord = freshWord();
    const targetEntryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
        [targetWord],
      )
    ).rows[0]!.id;
    const targetSourceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_sources (lexical_entry_id, source_type, source_note, content_hash, created_by)
         VALUES ($1, 'import', 'target', 'target-hash-${uniqKey()}', $2) RETURNING id`,
        [targetEntryId, adminUserId],
      )
    ).rows[0]!.id;
    return {
      commitId: cr!.commit_id,
      uncommittedRowId: row2!.id,
      targetEntryId,
      targetSourceId,
    };
  }

  it("12. 数据库强制来源一致性（P1-4 + P1-5）：每个负面案例独立 fixture 并命中目标约束", async () => {
    // 12a. 空来源（lexical_source_id 不可空 NOT NULL）→ 拒绝。
    const a = await freshNegativeFixture();
    await expect(
      pool.query(
        `INSERT INTO import_batch_commit_rows
           (commit_id, import_row_id, ordinal, normalized_spelling, lexical_entry_id, created_entry_id, lexical_source_id)
         VALUES ($1, $2, 9901, 'x', $3, $3, NULL)`,
        [a.commitId, a.uncommittedRowId, a.targetEntryId],
      ),
    ).rejects.toThrow(/violates null constraint|not-null/i);

    // 12b. 来源属于另一词条 → provenance trigger 拒绝。
    const b = await freshNegativeFixture();
    const bOtherEntryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
        [freshWord()],
      )
    ).rows[0]!.id;
    await expect(
      pool.query(
        `INSERT INTO import_batch_commit_rows
           (commit_id, import_row_id, ordinal, normalized_spelling, lexical_entry_id, created_entry_id, lexical_source_id)
         VALUES ($1, $2, 9902, 'x', $3, $3, $4)`,
        [b.commitId, b.uncommittedRowId, bOtherEntryId, b.targetSourceId],
      ),
    ).rejects.toThrow(/belongs to a different lexical entry/);

    // 12c. canonical 词条与分类列冲突 → CHECK 拒绝。
    const c = await freshNegativeFixture();
    const cOtherEntryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
        [freshWord()],
      )
    ).rows[0]!.id;
    await expect(
      pool.query(
        `INSERT INTO import_batch_commit_rows
           (commit_id, import_row_id, ordinal, normalized_spelling, lexical_entry_id, created_entry_id, associated_entry_id, lexical_source_id)
         VALUES ($1, $2, 9903, 'x', $3, $4, NULL, $5)`,
        [c.commitId, c.uncommittedRowId, c.targetEntryId, cOtherEntryId, c.targetSourceId],
      ),
    ).rejects.toThrow(/canonical_match_check|lexical_entry_id/i);

    // 12d. canonical 词条缺失（NULL）→ NOT NULL 拒绝。
    const d = await freshNegativeFixture();
    await expect(
      pool.query(
        `INSERT INTO import_batch_commit_rows
           (commit_id, import_row_id, ordinal, normalized_spelling, lexical_entry_id, created_entry_id, lexical_source_id)
         VALUES ($1, $2, 9904, 'x', NULL, NULL, $3)`,
        [d.commitId, d.uncommittedRowId, d.targetSourceId],
      ),
    ).rejects.toThrow(/violates null constraint|not-null/i);

    // 12e. 同 entry 但 manual 来源 → source_type='import' trigger 拒绝。
    const e = await freshNegativeFixture();
    const eManualSourceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_sources (lexical_entry_id, source_type, source_note, content_hash, created_by)
         VALUES ($1, 'manual', 'P1-2 manual source', 'manual-hash-${uniqKey()}', $2)
         RETURNING id`,
        [e.targetEntryId, adminUserId],
      )
    ).rows[0]!.id;
    await expect(
      pool.query(
        `INSERT INTO import_batch_commit_rows
           (commit_id, import_row_id, ordinal, normalized_spelling, lexical_entry_id, created_entry_id, lexical_source_id)
         VALUES ($1, $2, 9905, 'x', $3, $3, $4)`,
        [e.commitId, e.uncommittedRowId, e.targetEntryId, eManualSourceId],
      ),
    ).rejects.toThrow(/must be source_type = import/);
  });

  it("12f. 已引用导入来源不可被事后篡改（P1-1）：UPDATE/DELETE 均被拒绝", async () => {
    // 预置词条 + 提交一批，产生一条「已引用」的 import 来源。
    const cw = freshWord();
    const batchId = await uploadTxt(`${cw}\n`);
    await validateBatch(batchId);
    const ok = await commitBatch(batchId);
    expect(ok.statusCode).toBe(200);

    const src = await q1<{ id: string; entry_id: string }>(
      `SELECT ls.id, ls.lexical_entry_id AS entry_id
       FROM lexical_sources ls
       JOIN import_batch_commit_rows cr ON cr.lexical_source_id = ls.id
       WHERE ls.source_type = 'import' AND cr.import_row_id IN
         (SELECT id FROM import_rows WHERE batch_id = $1)
       LIMIT 1`,
      [batchId],
    );
    expect(src).toBeTruthy();
    // 另一词条用于「转移来源归属」的篡改尝试。
    const otherWord = freshWord();
    const otherEntryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
        [otherWord],
      )
    ).rows[0]!.id;

    // 12f-1. 把来源归属改为另一词条 → 拒绝（命中不可变来源 trigger）。
    await expect(
      pool.query(`UPDATE lexical_sources SET lexical_entry_id = $1 WHERE id = $2`, [
        otherEntryId,
        src!.id,
      ]),
    ).rejects.toThrow(/referenced by a commit row and is immutable/);

    // 12f-2. 把来源类型改为 manual → 拒绝（命中不可变来源 trigger）。
    await expect(
      pool.query(`UPDATE lexical_sources SET source_type = 'manual' WHERE id = $1`, [src!.id]),
    ).rejects.toThrow(/referenced by a commit row and is immutable/);

    // 12f-3. 删除该来源 → 拒绝（命中不可变来源 trigger）。
    await expect(
      pool.query(`DELETE FROM lexical_sources WHERE id = $1`, [src!.id]),
    ).rejects.toThrow(/referenced by a commit row and is immutable/);
  });

  it("12g. 未引用来源可正常 UPDATE/DELETE（P1-4 返回语义）", async () => {
    // 创建一个未被任何 commit row 引用的 import source。
    const w = freshWord();
    const entryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
        [w],
      )
    ).rows[0]!.id;
    const sourceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_sources (lexical_entry_id, source_type, source_note, content_hash, created_by)
         VALUES ($1, 'import', 'unref', 'unref-hash-${uniqKey()}', $2) RETURNING id`,
        [entryId, adminUserId],
      )
    ).rows[0]!.id;

    // 未引用来源：合法 UPDATE（source_note）应成功。
    const upd = await pool.query(
      `UPDATE lexical_sources SET source_note = 'updated' WHERE id = $1`,
      [sourceId],
    );
    expect(upd.rowCount).toBe(1);

    // 未引用来源：DELETE 应成功（0024 修复后 RETURN OLD 放行）。
    const del = await pool.query(`DELETE FROM lexical_sources WHERE id = $1`, [sourceId]);
    expect(del.rowCount).toBe(1);
  });

  it("14. existing_entry 关联目标消失时整体拒绝提交（P1-1）", async () => {
    // 预置系统词条 → 校验后删除该词条（import_rows.lexical_entry_id 因 SET NULL 变 NULL）。
    const vanished = freshWord();
    const entryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
        [vanished],
      )
    ).rows[0]!.id;
    const cw = freshWord();
    const batchId = await uploadTxt(`${vanished}\n${cw}\n`);
    await validateBatch(batchId);
    // 删除既有词条 → 该行 lexical_entry_id 置 NULL，但 status 仍是 existing_entry。
    await pool.query(`DELETE FROM lexical_entries WHERE id = $1`, [entryId]);
    const rowCheck = await q1<{ status: string; lexical_entry_id: string | null }>(
      `SELECT status, lexical_entry_id FROM import_rows WHERE batch_id = $1 AND normalized_spelling = $2`,
      [batchId, vanished],
    );
    expect(rowCheck?.status).toBe("existing_entry");
    expect(rowCheck?.lexical_entry_id).toBeNull();

    // 提交：existing_entry 目标消失 → 整体拒绝（COMMIT_REVALIDATION_REQUIRED），
    // 绝不「跳过该行 + 部分提交」，健康 candidate 也不得被创建。
    const commit = await commitBatch(batchId);
    expect([409, 422]).toContain(commit.statusCode);
    expect((body(commit) as { error?: { code: string } }).error?.code).toBe(
      "COMMIT_REVALIDATION_REQUIRED",
    );

    // 批次零提交副作用：无 commit、无 commit_row、candidate 未被创建。
    expect(
      await qcount(`SELECT count(*)::text AS n FROM import_batch_commits WHERE batch_id = $1`, [
        batchId,
      ]),
    ).toBe(0);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM import_batch_commit_rows cr JOIN import_rows r ON r.id = cr.import_row_id WHERE r.batch_id = $1`,
        [batchId],
      ),
    ).toBe(0);
    expect(
      await qcount(
        `SELECT count(*)::text AS n FROM lexical_entries WHERE canonical_spelling = $1`,
        [cw],
      ),
    ).toBe(0);
    // import_rows.status 保持原始 existing_entry。
    const afterCheck = await q1<{ status: string }>(
      `SELECT status FROM import_rows WHERE batch_id = $1 AND normalized_spelling = $2`,
      [batchId, vanished],
    );
    expect(afterCheck?.status).toBe("existing_entry");
    // batch 未进入 committed。
    const bStatus = await q1<{ status: string }>(
      `SELECT status FROM import_batches WHERE id = $1`,
      [batchId],
    );
    expect(bStatus?.status).not.toBe("committed");

    // 同一 Idempotency-Key 重试不留下永久 pending（无 idempotency 残留指向本批次）。
    const retryKey = uniqKey();
    const retry1 = await commitBatch(batchId, { key: retryKey });
    expect([409, 422]).toContain(retry1.statusCode);
    const retry2 = await commitBatch(batchId, { key: retryKey });
    expect([409, 422]).toContain(retry2.statusCode);

    // 推进映射版本并重新校验（覆盖既有 existing_entry 的陈旧分类），再用新确认身份继续。
    const detail = await admin.req("GET", `/api/v1/admin/imports/${batchId}`, {});
    const d = body(detail) as { version: number; mappingVersion: number };
    const patch = await admin.req("PATCH", `/api/v1/admin/imports/${batchId}`, {
      payload: { mapping: {}, version: d.version },
    });
    expect(patch.statusCode).toBe(200);
    const afterPatch = body(patch) as { mappingVersion: number };
    expect(afterPatch.mappingVersion).toBe(d.mappingVersion + 1);
    await validateBatch(batchId);
    const retry3 = await commitBatch(batchId);
    expect(retry3.statusCode).toBe(200);
  });

  it("13. 错误报告只含真正不可提交行：existing_entry 不出现（P1-1）", async () => {
    // 预置系统词条 → 文件行在校验时归类为 existing_entry。
    const preExisting = freshWord();
    await pool.query(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
       VALUES ($1, $1, '[]'::jsonb) ON CONFLICT (canonical_spelling) DO NOTHING`,
      [preExisting],
    );
    const cw = freshWord();
    // 文件：preExisting（existing_entry）、cw 重复两次（第 2 次 duplicate）、非法 1234。
    const batchId = await uploadTxt(`${preExisting}\n${cw}\n${cw}\n1234\n`);
    await validateBatch(batchId);

    // 提交成功：existing_entry 关联（committed），不视为错误。
    const commit = await commitBatch(batchId);
    expect(commit.statusCode).toBe(200);
    const c = body(commit) as {
      createdEntryCount: number;
      associatedExistingEntryCount: number;
      skippedCountByDisposition: Record<string, number>;
      committedRowCount: number;
    };
    expect(c.associatedExistingEntryCount).toBe(1);
    expect(c.createdEntryCount).toBe(1);
    expect(c.committedRowCount).toBe(2);
    expect(c.skippedCountByDisposition).toEqual({ invalid: 1, duplicate_in_file: 1 });

    // 错误报告：不含 existing_entry（ordinal/拼写/状态），仍含 invalid 与 duplicate。
    const res = await admin.req("GET", `/api/v1/admin/imports/${batchId}/error-report`, {});
    expect(res.statusCode).toBe(200);
    const csv = String((res as unknown as { body: string }).body ?? "");
    expect(csv).toContain("invalid");
    expect(csv).toContain("duplicate_in_file");
    expect(csv).not.toContain("existing_entry");
    expect(csv).not.toContain(preExisting);
    // 数据行数（不含表头）= invalid(1) + duplicate(1) = 2。
    const dataLines = csv.split("\n").filter((l) => l.trim() !== "").length - 1; // 去掉表头
    expect(dataLines).toBe(2);
  });

  it("15. E2E 隔离清理证明（P1-3/P1-4）：正常 FK/trigger 下删除，外部词条保留、无孤儿、trigger 保持 enabled", async () => {
    // 创建一个「外部管理员」及其词条（模拟共享库中的真实数据）。
    const externalWord = freshWord();
    const externalEntryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
         VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
        [externalWord],
      )
    ).rows[0]!.id;

    // 创建一个「隔离测试用户」+ 会话。
    const ps = new PasswordService();
    const isoUser = `e2e-cleanup-probe-${Date.now()}`;
    const isoRow = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Cleanup Probe', 'admin', 'active', 'Asia/Shanghai', 10, $2, false) RETURNING id`,
      [isoUser, await ps.hashPassword("cleanup-probe-pass-123")],
    );
    const isoUserId = isoRow.rows[0]!.id;
    await pool.query(
      `INSERT INTO auth_sessions (user_id, token_digest, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, 'probe-token', now(), now(), now() + interval '1 hour', now() + interval '1 day')`,
      [isoUserId],
    );
    // 隔离用户创建测试来源：对外部词条创建 import source（仅关联，不拥有该词条）。
    await pool.query(
      `INSERT INTO lexical_sources (lexical_entry_id, source_type, source_note, content_hash, created_by)
       VALUES ($1, 'import', 'iso-assoc', 'iso-assoc-hash-${uniqKey()}', $2)`,
      [externalEntryId, isoUserId],
    );

    // 执行与 cleanupIsolatedAdmin 相同的清理算法（正常 FK/trigger 下；不删除任何 lexical_entries）。
    await pool.query("BEGIN");
    await pool.query(`DELETE FROM auth_sessions WHERE user_id = $1::uuid`, [isoUserId]);
    // 隔离用户创建的 sources（关联外部词条的也删，但绝不删外部词条本身）。
    await pool.query(`DELETE FROM lexical_sources WHERE created_by = $1::uuid`, [isoUserId]);
    await pool.query(`DELETE FROM audit_events WHERE actor_id = $1::uuid`, [isoUserId]);
    await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [isoUserId]);
    await pool.query("COMMIT");

    // 断言：
    // 1) 隔离用户及其会话被删除；无孤儿 session。
    const isoUserCount = await qcount(`SELECT count(*)::text AS n FROM users WHERE id = $1`, [
      isoUserId,
    ]);
    expect(isoUserCount).toBe(0);
    const orphanSessions = await qcount(
      `SELECT count(*)::text AS n FROM auth_sessions WHERE user_id = $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = $1)`,
      [isoUserId],
    );
    expect(orphanSessions).toBe(0);
    // 2) 外部词条仍存在（未被误删）——即使隔离用户曾为它创建 import source。
    expect(
      await qcount(`SELECT count(*)::text AS n FROM lexical_entries WHERE id = $1`, [
        externalEntryId,
      ]),
    ).toBe(1);
    // 3) 隔离用户创建的来源被清理。
    expect(
      await qcount(`SELECT count(*)::text AS n FROM lexical_sources WHERE created_by = $1`, [
        isoUserId,
      ]),
    ).toBe(0);
    // 4) 所有完整性 trigger 仍 enabled（未 DISABLE / 未 session_replication_role）。
    const disabled = await qcount(
      `SELECT count(*)::text AS n FROM pg_trigger WHERE tgenabled = 'D'
       AND tgname IN ('import_batch_commits_no_delete','import_batch_commit_rows_no_delete',
                      'lexical_sources_no_delete_when_referenced','lexical_sources_no_update_when_referenced',
                      'course_releases_no_delete','learning_exposures_no_delete')`,
      [],
    );
    expect(disabled).toBe(0);
    // 5) 无 FK 孤儿（users 无孤立 audit/session/source）。
    const orphanAudit = await qcount(
      `SELECT count(*)::text AS n FROM audit_events WHERE actor_id = $1`,
      [isoUserId],
    );
    expect(orphanAudit).toBe(0);
    const orphanSources = await qcount(
      `SELECT count(*)::text AS n FROM lexical_sources WHERE created_by = $1`,
      [isoUserId],
    );
    expect(orphanSources).toBe(0);
  });
});
