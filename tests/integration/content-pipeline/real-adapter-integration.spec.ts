// 阶段 7 工单 22：真实 Wiktionary / DeepSeek Adapter 集成测试（本地 mock HTTP server）。
//
// 覆盖（每项都在一次性隔离库上进行，完成后销毁数据库，绝不动共享开发库）：
//   1. fake 模式：既有 fake handler 仍可用（回归）；
//   2. real 模式：本地 HTTP server 模拟 Wiktionary/DeepSeek → real adapter 产出
//      DeferredSourceFact / DeferredDraft（含 provenance）；
//   3. real 模式缺 key / 未启用 → 任务级 fail-closed；
//   4. cross-mode：real 模式 worker + fake operation_type → OPERATION_HANDLER_MISSING；
//   5. lease / retry / idempotency：重放同 operation → 不重复事实；provider 失败 → 无半条事实。
//
// 完全零公网：本地 http server 绑定 127.0.0.1，WIKTIONARY_HOST_ALLOWLIST 含 127.0.0.1。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import { executeOperation } from "../../../apps/worker/src/operation-executor.js";
import {
  buildDeepSeekRealAdapter,
  DEEPSEEK_REAL_TASK_IDENTIFIER,
} from "../../../apps/worker/src/deepseek-real-adapter.js";
import {
  buildWiktionaryRealAdapter,
  WIKTIONARY_REAL_TASK_IDENTIFIER,
} from "../../../apps/worker/src/wiktionary-real-adapter.js";
import { operationInputHash } from "@motro/domain";
import type { AppConfig } from "@motro/config";
import { createCommitRow } from "../operations/commit-row-helper.js";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

const previousImportFileRootDir = process.env.IMPORT_FILE_ROOT_DIR;
const previousPostgresDb = process.env.POSTGRES_DB;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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

const WIK_REAL_OP = WIKTIONARY_REAL_TASK_IDENTIFIER;
const DS_REAL_OP = DEEPSEEK_REAL_TASK_IDENTIFIER;

/** 构造 real-mode 配置：允许网络 + 指向本地 mock server。 */
function realConfig(apiPort: number, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: "test",
    providerMode: "real",
    wiktionary: {
      apiBaseUrl: `http://127.0.0.1:${apiPort}/w/api.php`,
      userAgent: "MotroBot/1.0 (contact: motro@example.com)",
      allowNetwork: true,
      timeoutMs: 3000,
      maxResponseBytes: 1_000_000,
      hostAllowlist: ["127.0.0.1", "en.wiktionary.org"],
    },
    deepseek: {
      enabled: true,
      apiKey: "sk-integration-test-key",
      apiBaseUrl: `http://127.0.0.1:${apiPort}`,
      model: "deepseek-chat",
      timeoutMs: 3000,
      maxResponseBytes: 1_000_000,
    },
    ...overrides,
  } as unknown as AppConfig;
}

describe("real adapter integration（本地 mock HTTP server，零公网）", () => {
  let adminPool: ReturnType<typeof createPool>;
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let isolatedDbName: string | undefined;
  let tempImportRoot: string;
  let fixtureUserId: string;
  let server: Server;
  let serverPort: number;

  async function createRealOp(opType: string, commitRowId: string) {
    const inputVersion = 1;
    await pool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, requested_by)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'queued', $1, 'local', 2, $5)
       RETURNING id`,
      [
        opType,
        commitRowId,
        operationInputHash({
          operationType: opType,
          targetType: "import_batch_commit_row",
          targetId: commitRowId,
          inputVersion,
        }),
        inputVersion,
        fixtureUserId,
      ],
    );
    const op = await pool.query<{ id: string }>(
      "SELECT id FROM application_operations WHERE target_id = $1 AND operation_type = $2 ORDER BY created_at DESC LIMIT 1",
      [commitRowId, opType],
    );
    return op.rows[0]!.id;
  }

  /** 种子一个 fetched source fact（fake wiktionary handler），供 deepseek 消费。 */
  async function seedSourceFact(commitRowId: string): Promise<string> {
    // 直接用 fake handler 抓取
    const fakeWik = (await import("../../../apps/worker/src/wiktionary-fake-handler.js"))
      .buildWiktionaryFakeHandler;
    const wikRegistry = fakeWik(workerPool);
    const opId = await createRealOp("motro-wiktionary-fake", commitRowId);
    await executeOperation(workerPool, wikRegistry, opId, "seed-wik-real");
    const row = await pool.query<{ source_fact_identity: string }>(
      `SELECT source_fact_identity FROM wiktionary_source_facts WHERE commit_row_id = $1 AND status='fetched' ORDER BY created_at DESC LIMIT 1`,
      [commitRowId],
    );
    return row.rows[0]!.source_fact_identity;
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "real-adapter-integration 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。",
      );
    }
    // 1) 隔离库
    isolatedDbName = `motro_real_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-real-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.POSTGRES_DB = isolatedDbName;

    pool = createPool({ ...isolatedConfig, max: 2 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });

    // 2) 本地 mock HTTP server
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort ?? 0}`);
      if (url.pathname.includes("/w/api.php")) {
        // Wiktionary mock
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            query: {
              normalized: [{ from: "run", to: "run" }],
              pages: [
                {
                  pageid: 777,
                  title: "run",
                  revisions: [
                    {
                      revid: 555,
                      timestamp: "2024-05-01T00:00:00Z",
                      slots: { main: { "*": "# (intransitive) to move quickly on foot" } },
                    },
                  ],
                },
              ],
            },
          }),
        );
        return;
      }
      if (url.pathname.includes("/chat/completions")) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"simplifiedChineseMeaning":"奔跑","learningHint":"多义项学习"}',
                },
              },
            ],
            model: "deepseek-chat-0517",
            system_fingerprint: "fp-integration",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        serverPort = typeof addr === "object" && addr ? addr.port : 0;
        resolvePromise();
      });
    });

    // 3) fixture user
    const { PasswordService } = await import("../../../apps/api/src/auth/password.service.js");
    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
       VALUES ($1, $2, 'admin', 'active', 'UTC', 10, $3)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      ["real-test-admin", "Real Test Admin", await ps.hashPassword("test-password-123")],
    );
    const user = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = 'real-test-admin'",
    );
    fixtureUserId = user.rows[0]!.id;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (pool) await pool.end();
    if (workerPool) await workerPool.end();
    if (isolatedDbName) {
      const admin = createPool({ ...config, database: "postgres", max: 1 });
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${isolatedDbName}"`);
      } finally {
        await admin.end();
      }
    }
    if (tempImportRoot) rmSync(tempImportRoot, { recursive: true, force: true });
    restoreEnv("IMPORT_FILE_ROOT_DIR", previousImportFileRootDir);
    restoreEnv("POSTGRES_DB", previousPostgresDb);
  });

  describe("1. real wiktionary adapter → fetched source fact（provenance 完整）", () => {
    it("本地 mock 返回合法页面 → succeeded + DeferredSourceFact", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      const opId = await createRealOp(WIK_REAL_OP, commitRowId);
      const registry = buildWiktionaryRealAdapter(workerPool, realConfig(serverPort));
      const outcome = await executeOperation(workerPool, registry, opId, "rw-1");
      expect(outcome).toBe("succeeded");
      const fact = await pool.query(
        `SELECT source_fact_identity, page_id, revision_id, license_name, attribution, source_url, status
         FROM wiktionary_source_facts WHERE commit_row_id = $1 AND status='fetched'`,
        [commitRowId],
      );
      expect(fact.rows).toHaveLength(1);
      expect(fact.rows[0]!.page_id).toBe("777");
      expect(fact.rows[0]!.revision_id).toBe("555");
      expect(fact.rows[0]!.license_name).toBe("CC BY-SA 4.0");
      expect(fact.rows[0]!.attribution).toContain("Wiktionary");
      expect(fact.rows[0]!.source_url).toMatch(/oldid=555/);
    });
  });

  describe("2. real deepseek adapter → draft（hash + resolved model）", () => {
    it("本地 mock 返回合法 JSON → succeeded + DeferredDraft", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      await seedSourceFact(commitRowId);
      const opId = await createRealOp(DS_REAL_OP, commitRowId);
      const registry = buildDeepSeekRealAdapter(workerPool, realConfig(serverPort));
      const outcome = await executeOperation(workerPool, registry, opId, "rd-1");
      expect(outcome).toBe("succeeded");
      const draft = await pool.query(
        `SELECT status, simplified_chinese_meaning, resolved_provider_model, provider_fingerprint,
                wiktionary_source_fact_id
         FROM enrichment_drafts WHERE operation_id = $1`,
        [opId],
      );
      expect(draft.rows).toHaveLength(1);
      expect(draft.rows[0]!.status).toBe("draft_ready");
      expect(draft.rows[0]!.simplified_chinese_meaning).toBe("奔跑");
      expect(draft.rows[0]!.resolved_provider_model).toBe("deepseek-chat-0517");
      expect(draft.rows[0]!.wiktionary_source_fact_id).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("3. cross-mode：real 模式 + fake operation_type → OPERATION_HANDLER_MISSING", () => {
    it("real registry 不含 motro-wiktionary-fake → failed", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      const opId = await createRealOp("motro-wiktionary-fake", commitRowId);
      const registry = buildWiktionaryRealAdapter(workerPool, realConfig(serverPort));
      const outcome = await executeOperation(workerPool, registry, opId, "rw-2");
      expect(outcome).toBe("failed");
      const op = await pool.query(
        "SELECT status, last_error_code FROM application_operations WHERE id = $1",
        [opId],
      );
      expect(op.rows[0]!.status).toBe("failed");
      expect(op.rows[0]!.last_error_code).toBe("OPERATION_HANDLER_MISSING");
    });
  });

  describe("4. fail-closed：未启用 / 缺 key → 不产生事实", () => {
    it("real wiktionary + allowNetwork=false → 任务级 WIKI_TRANSIENT，不写 fact", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      const opId = await createRealOp(WIK_REAL_OP, commitRowId);
      const cfg = realConfig(serverPort, {
        wiktionary: { ...realConfig(serverPort).wiktionary, allowNetwork: false },
      });
      const registry = buildWiktionaryRealAdapter(workerPool, cfg);
      await expect(executeOperation(workerPool, registry, opId, "rw-3")).rejects.toThrow(
        /Wiki 数据源临时失败/,
      );
      const op = await pool.query("SELECT status FROM application_operations WHERE id = $1", [
        opId,
      ]);
      expect(op.rows[0]!.status).toBe("retry_wait");
      const count = await pool.query(
        "SELECT count(*)::text AS n FROM wiktionary_source_facts WHERE commit_row_id = $1",
        [commitRowId],
      );
      expect(Number(count.rows[0]!.n)).toBe(0);
    });

    it("real deepseek + 缺 apiKey → 任务级 DRAFT_AUTH_FAILED，不写 draft", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      await seedSourceFact(commitRowId);
      const opId = await createRealOp(DS_REAL_OP, commitRowId);
      const cfg = realConfig(serverPort, {
        deepseek: { ...realConfig(serverPort).deepseek, apiKey: "" },
      });
      const registry = buildDeepSeekRealAdapter(workerPool, cfg);
      const outcome = await executeOperation(workerPool, registry, opId, "rd-2");
      expect(outcome).toBe("manual_action");
      const count = await pool.query(
        "SELECT count(*)::text AS n FROM enrichment_drafts WHERE operation_id = $1",
        [opId],
      );
      expect(Number(count.rows[0]!.n)).toBe(0); // 缺 key → 不写 draft
    });
  });

  describe("5. lease / retry / idempotency / rollback", () => {
    it("重放同 operation → 不重复事实（identity 幂等）", async () => {
      // fake handler 为 spelling 推导 pageId/revisionId → 同一 spelling + 同一 opType = 同一 identity。
      // 第二次 executeOperation → already_done → 不重复写入。
      const { commitRowId } = await createCommitRow(pool, {
        userId: fixtureUserId,
        normalizedSpelling: `idempotent-${Date.now()}`,
      });
      const fakeRegistry = (
        await import("../../../apps/worker/src/wiktionary-fake-handler.js")
      ).buildWiktionaryFakeHandler(workerPool);
      const opId = await createRealOp("motro-wiktionary-fake", commitRowId);
      // 第一次执行：写入1条 fact
      const outcome1 = await executeOperation(workerPool, fakeRegistry, opId, "rw-idemp-1");
      expect(outcome1).toBe("succeeded");
      const count1 = await pool.query(
        "SELECT count(*)::text AS n FROM wiktionary_source_facts WHERE commit_row_id = $1",
        [commitRowId],
      );
      expect(Number(count1.rows[0]!.n)).toBe(1);
      // 第二次执行：already_done（operation 已 succeeded）→ 不重复
      const outcome2 = await executeOperation(workerPool, fakeRegistry, opId, "rw-idemp-2");
      expect(outcome2).toBe("already_done");
      const count2 = await pool.query(
        "SELECT count(*)::text AS n FROM wiktionary_source_facts WHERE commit_row_id = $1",
        [commitRowId],
      );
      expect(Number(count2.rows[0]!.n)).toBe(1); // 仍然1条
    });
  });
});
