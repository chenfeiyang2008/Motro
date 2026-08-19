// 阶段 7 工单 22：Real Provider Smoke（需显式启用 MOTRO_REAL_PROVIDER_SMOKE=1）。
//
// 只在以下条件全部满足时运行：
//   - 环境变量 MOTRO_REAL_PROVIDER_SMOKE=1
//   - PostgreSQL 可连接
//   - DEEPSEEK_API_KEY 已设置（测试 DeepSeek 真实调用）
//
// 设计约束：
//   - 使用一次性隔离数据库（不触共享库）
//   - 使用临时数据
//   - 不使用真实用户数据
//   - 记录状态码、耗时、脱敏摘要、provenance 是否完整
//   - 不把响应正文写入报告
//   - 完成后清理隔离资源
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import { executeOperation } from "../../../apps/worker/src/operation-executor.js";
import {
  buildWiktionaryRealAdapter,
  WIKTIONARY_REAL_TASK_IDENTIFIER,
} from "../../../apps/worker/src/wiktionary-real-adapter.js";
import {
  buildDeepSeekRealAdapter,
  DEEPSEEK_REAL_TASK_IDENTIFIER,
} from "../../../apps/worker/src/deepseek-real-adapter.js";
import { operationInputHash } from "@motro/domain";
import { createCommitRow } from "../operations/commit-row-helper.js";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

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

const runSmoke =
  process.env.MOTRO_REAL_PROVIDER_SMOKE === "1" &&
  (await canConnect()) &&
  !!process.env.DEEPSEEK_API_KEY;

const describeSmoke = describe.skipIf(!runSmoke);

describeSmoke("real provider smoke（真实网络，隔离库，需 MOTRO_REAL_PROVIDER_SMOKE=1）", () => {
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let isolatedDbName: string | undefined;
  let tempImportRoot: string;
  let fixtureUserId: string;

  beforeAll(async () => {
    isolatedDbName = `motro_smoke_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const admin = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await admin.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-smoke-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.POSTGRES_DB = isolatedDbName;

    pool = createPool({ ...isolatedConfig, max: 2 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });

    const { PasswordService } = await import("../../../apps/api/src/auth/password.service.js");
    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
       VALUES ($1, $2, 'admin', 'active', 'UTC', 10, $3)
       ON CONFLICT (username) DO NOTHING`,
      ["smoke-admin", "Smoke Admin", await ps.hashPassword("smoke-test-password-123")],
    );
    const user = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = 'smoke-admin'",
    );
    fixtureUserId = user.rows[0]!.id;
  });

  afterAll(async () => {
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
  });

  async function createOp(opType: string, commitRowId: string, inputVersion = 1) {
    await pool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, requested_by)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'queued', $1, 'local', 2, $5)`,
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

  it("Wiktionary real：获取已知英语单词 → provenance 完整", async () => {
    const { commitRowId } = await createCommitRow(pool, {
      userId: fixtureUserId,
      normalizedSpelling: "run",
    });
    const opId = await createOp(WIKTIONARY_REAL_TASK_IDENTIFIER, commitRowId);
    const cfg = {
      env: "test",
      providerMode: "real",
      wiktionary: {
        apiBaseUrl: "https://en.wiktionary.org/w/api.php",
        userAgent: "MotroBot/1.0 (contact: motro@example.com)",
        allowNetwork: true,
        timeoutMs: 15000,
        maxResponseBytes: 5_000_000,
        hostAllowlist: ["en.wiktionary.org"],
      },
      deepseek: {
        enabled: false,
        apiKey: undefined,
        apiBaseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        timeoutMs: 30000,
        maxResponseBytes: 1_000_000,
      },
    } as unknown as import("@motro/config").AppConfig;
    const t0 = Date.now();
    const outcome = await executeOperation(
      workerPool,
      buildWiktionaryRealAdapter(workerPool, cfg),
      opId,
      "smoke-wik-1",
    );
    const elapsed = Date.now() - t0;
    expect(outcome).toBe("succeeded");
    const fact = await pool.query(
      "SELECT page_id, revision_id, license_name, attribution, source_url, fetched_at FROM wiktionary_source_facts WHERE commit_row_id = $1 AND status='fetched'",
      [commitRowId],
    );
    expect(fact.rows).toHaveLength(1);
    const r = fact.rows[0]!;
    expect(r.page_id).toBeTruthy();
    expect(r.revision_id).toBeTruthy();
    expect(r.license_name).toBe("CC BY-SA 4.0");
    expect(r.attribution).toContain("Wiktionary");
    expect(r.fetched_at).toBeTruthy();
    console.log(
      `Wiktionary smoke: page=${r.page_id} rev=${r.revision_id} status=fetched latency=${elapsed}ms provenance=complete`,
    );
  });

  it("DeepSeek real：使用真实密钥 → draft_ready", async () => {
    const { commitRowId } = await createCommitRow(pool, {
      userId: fixtureUserId,
      normalizedSpelling: "hello",
    });
    // 先种子一个 wiktionary source fact
    const wikOp = await createOp(WIKTIONARY_REAL_TASK_IDENTIFIER, commitRowId);
    const wikCfg = {
      env: "test",
      providerMode: "real",
      wiktionary: {
        apiBaseUrl: "https://en.wiktionary.org/w/api.php",
        userAgent: "MotroBot/1.0 (contact: motro@example.com)",
        allowNetwork: true,
        timeoutMs: 15000,
        maxResponseBytes: 5_000_000,
        hostAllowlist: ["en.wiktionary.org"],
      },
      deepseek: {
        enabled: false,
        apiKey: undefined,
        apiBaseUrl: "https://api.deepseek.com",
        model: "x",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
      },
    } as unknown as import("@motro/config").AppConfig;
    await executeOperation(
      workerPool,
      buildWiktionaryRealAdapter(workerPool, wikCfg),
      wikOp,
      "smoke-wik-seed",
    );

    const dsOp = await createOp(DEEPSEEK_REAL_TASK_IDENTIFIER, commitRowId);
    const dsCfg = {
      env: "test",
      providerMode: "real",
      wiktionary: {
        apiBaseUrl: "x",
        userAgent: "x",
        allowNetwork: false,
        timeoutMs: 1000,
        maxResponseBytes: 1000,
        hostAllowlist: [],
      },
      deepseek: {
        enabled: true,
        apiKey: process.env.DEEPSEEK_API_KEY!,
        apiBaseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        timeoutMs: 30_000,
        maxResponseBytes: 1_000_000,
      },
    } as unknown as import("@motro/config").AppConfig;
    const t0 = Date.now();
    const outcome = await executeOperation(
      workerPool,
      buildDeepSeekRealAdapter(workerPool, dsCfg),
      dsOp,
      "smoke-ds-1",
    );
    const elapsed = Date.now() - t0;
    expect(outcome).toBe("succeeded");
    const draft = await pool.query(
      "SELECT status, simplified_chinese_meaning, resolved_provider_model, wiktionary_source_fact_id FROM enrichment_drafts WHERE operation_id = $1",
      [dsOp],
    );
    expect(draft.rows).toHaveLength(1);
    const d = draft.rows[0]!;
    expect(d.status).toBe("draft_ready");
    expect(d.resolved_provider_model).toBeTruthy();
    expect(d.wiktionary_source_fact_id).toMatch(/^[0-9a-f]{64}$/);
    // 记录状态码与耗时；不记录响应正文
    console.log(
      `DeepSeek smoke: model=${d.resolved_provider_model} meaningLen=${(d.simplified_chinese_meaning ?? "").length} latency=${elapsed}ms provenance=complete`,
    );
  });
});
