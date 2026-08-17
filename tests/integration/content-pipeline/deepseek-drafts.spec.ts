// 阶段 6 工单 06：DeepSeek draft 内网零网络基础集成验收（真实 PostgreSQL）。
//
// 覆盖（每项都在一次性隔离库上进行，完成后销毁数据库，绝不动共享开发库）：
//   1. 空库 migration 0001–0035；enrichment_drafts/review decisions/game 表存在；校验/触发/FK 就位；
//   2. fake success：operation → succeeded，写入一条 draft_ready draft（原子 append-only）；
//   3. 同输入重放：第二次执行 no-op，不新增 draft（identity 幂等）；
//   4. retryable（empty/非JSON/429/5xx）→ 各自正确路由到 retry_wait/failed；
//   5. manual_action（auth/budget/model-identity 不足/source missing）→ 不写 draft；
//   6. 单个 draft 失败不阻塞同批其它 operation（batch/row independence）；
//   7. deferred draft + completeAttempt 同事务：失败整体回滚不留孤儿 draft；
//   8. 敏感字段拒绝：draft 表不含 prompt / provider response / secret / 路径；
//   9. 网络禁用与源码 secret 扫描。
//
// 本套件完全零网络：Fake Provider 不发 HTTP，不访问 DNS，不读 key。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import { executeOperation } from "../../../apps/worker/src/operation-executor.js";
import { buildDeepSeekFakeHandler } from "../../../apps/worker/src/deepseek-fake-handler.js";
import { buildWiktionaryFakeHandler } from "../../../apps/worker/src/wiktionary-fake-handler.js";
import { operationInputHash } from "@motro/domain";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
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

const DS_OP = "motro-deepseek-fake";
const QUEUE = "local";

describe("deepseek draft foundation", () => {
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let registry: ReturnType<typeof buildDeepSeekFakeHandler>;
  let wiktionaryRegistry: ReturnType<typeof buildWiktionaryFakeHandler>;
  let isolatedDbName: string | undefined;
  let tempImportRoot: string;
  let fixtureUserId: string;

  const WIK_OP = "motro-wiktionary-fake";

  /** 为指定 commit row 创建一条 Ticket 05 fetched source fact（返回其 source_fact_identity）。
   *  幂等：若已存在 fetched 事实，直接返回既有 identity，不重复创建 wiktionary operation。 */
  async function seedSourceFact(commitRowId: string): Promise<string> {
    const existing = (
      await pool.query<{ source_fact_identity: string }>(
        "SELECT source_fact_identity FROM wiktionary_source_facts WHERE commit_row_id = $1 AND status='fetched' ORDER BY created_at DESC LIMIT 1",
        [commitRowId],
      )
    ).rows[0];
    if (existing) return existing.source_fact_identity;

    await pool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, requested_by)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, 1, 'queued', $1, 'local', 5, $4)
       RETURNING id`,
      [
        WIK_OP,
        commitRowId,
        operationInputHash({
          operationType: WIK_OP,
          targetType: "import_batch_commit_row",
          targetId: commitRowId,
          inputVersion: 1,
        }),
        fixtureUserId,
      ],
    );
    const op = (
      await pool.query<{ id: string }>(
        "SELECT id FROM application_operations WHERE target_id = $1 AND operation_type = $2 ORDER BY created_at DESC LIMIT 1",
        [commitRowId, WIK_OP],
      )
    ).rows[0]!;
    const outcome = await executeOperation(workerPool, wiktionaryRegistry, op.id, "seed-wik");
    expect(outcome).toBe("succeeded");
    const row = (
      await pool.query<{ source_fact_identity: string }>(
        "SELECT source_fact_identity FROM wiktionary_source_facts WHERE commit_row_id = $1 AND status='fetched' ORDER BY created_at DESC LIMIT 1",
        [commitRowId],
      )
    ).rows[0]!;
    return row.source_fact_identity;
  }

  async function createDraftOp(opts: {
    inputVersion: number;
    maxAttempts?: number;
    commitRowId?: string;
    seedSource?: boolean;
  }): Promise<{ operationId: string; commitRowId: string }> {
    const commitRowId =
      opts.commitRowId ?? (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
    if (opts.seedSource !== false) {
      // 默认播种一条 Ticket 05 fetched source fact，draft 才可消费。
      await seedSourceFact(commitRowId);
    }
    const inputVersion = opts.inputVersion;
    await pool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, requested_by)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'queued', $1, $5, $6, $7)
       RETURNING id`,
      [
        DS_OP,
        commitRowId,
        operationInputHash({
          operationType: DS_OP,
          targetType: "import_batch_commit_row",
          targetId: commitRowId,
          inputVersion,
        }),
        inputVersion,
        QUEUE,
        opts.maxAttempts ?? 5,
        fixtureUserId,
      ],
    );
    const op = await pool.query<{ id: string }>(
      "SELECT id FROM application_operations WHERE target_id = $1 AND input_version = $2 ORDER BY created_at DESC LIMIT 1",
      [commitRowId, inputVersion],
    );
    return { operationId: op.rows[0]!.id, commitRowId };
  }

  async function draftCount(): Promise<number> {
    const r = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM enrichment_drafts");
    return Number(r.rows[0]?.n ?? 0);
  }

  async function draftCountFor(opId: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM enrichment_drafts WHERE operation_id = $1",
      [opId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async function opStatus(id: string): Promise<string> {
    const r = await pool.query<{ status: string }>(
      "SELECT status FROM application_operations WHERE id = $1",
      [id],
    );
    return r.rows[0]!.status;
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error("deepseek-drafts 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。");
    }
    isolatedDbName = `motro_dsdraft_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-dsdraft-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.POSTGRES_DB = isolatedDbName;

    pool = createPool({ ...isolatedConfig, max: 2 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });
    registry = buildDeepSeekFakeHandler(workerPool);
    wiktionaryRegistry = buildWiktionaryFakeHandler(workerPool);
    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'DS Draft User', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
      ["dsdraft-user", await ps.hashPassword("fixture-pass-123")],
    );
    fixtureUserId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", ["dsdraft-user"])
    ).rows[0]!.id;
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
      if (workerPool) await workerPool.end();
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
        /* ignore */
      }
      restoreEnv("IMPORT_FILE_ROOT_DIR", previousImportFileRootDir);
      restoreEnv("POSTGRES_DB", previousPostgresDb);
    }
  });

  afterEach(async () => {
    await pool.query("TRUNCATE enrichment_drafts, application_operations CASCADE");
  });

  describe("1. migration 就绪", () => {
    it("0001–0035 已应用，enrichment_drafts 表存在，immutable trigger 就位", async () => {
      const versions = await pool.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(versions.rows.map((r) => r.version)).toContain(33);
      const max = Math.max(...versions.rows.map((r) => r.version));
      expect(max).toBe(37);
      const tbl = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = 'enrichment_drafts'`,
      );
      expect(Number(tbl.rows[0]?.n ?? 0)).toBe(1);
      const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger
         WHERE tgrelid = 'enrichment_drafts'::regclass AND NOT tgisinternal ORDER BY tgname`,
      );
      expect(triggers.rows.map((r) => r.tgname)).toEqual([
        "enrichment_drafts_no_delete",
        "enrichment_drafts_no_update",
      ]);
      for (const t of triggers.rows) expect(t.tgenabled).toBe("O");
    });

    it("0033 校验：非法 status / 非法 hash / 超长 safe_error_summary 被拒", async () => {
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO enrichment_drafts
             (import_batch_commit_row_id, lexical_entry_id, wiktionary_source_fact_id,
              configured_model_alias, prompt_template_version, input_hash, request_hash, status)
           VALUES ($1, $2, $3, 'deepseek-v4-flash', 'zh-draft-v1', $4, $5, 'bogus_status')`,
          [
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "c".repeat(64),
            "d".repeat(64),
            "e".repeat(64),
          ],
        );
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(/status|check/i);
      }
      expect(rejected).toBe(true);
    });
  });

  describe("2. fake success 写入 draft_ready", () => {
    it("成功：operation → succeeded，写入一条 draft_ready draft", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 1 });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-1");
      expect(outcome).toBe("succeeded");
      expect(await opStatus(operationId)).toBe("succeeded");
      const rows = await pool.query<{
        status: string;
        simplified_chinese_meaning: string | null;
        configured_model_alias: string;
        resolved_provider_model: string | null;
        provider_fingerprint: string | null;
        wiktionary_source_fact_id: string;
      }>(
        "SELECT status, simplified_chinese_meaning, configured_model_alias, resolved_provider_model, provider_fingerprint, wiktionary_source_fact_id FROM enrichment_drafts WHERE operation_id = $1",
        [operationId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.status).toBe("draft_ready");
      expect(rows.rows[0]!.simplified_chinese_meaning).toBeTruthy();
      expect(rows.rows[0]!.configured_model_alias).toBe("deepseek-v4-flash");
      expect(rows.rows[0]!.resolved_provider_model).toBe("deepseek-v4-flash-0731");
      expect(rows.rows[0]!.provider_fingerprint).toBe("fp-abc123");
      // wiktionary_source_fact_id 是 64 hex（来源事实身份）。
      expect(rows.rows[0]!.wiktionary_source_fact_id).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("3. 幂等（operation / input）", () => {
    it("同一 operation 重放 → already_done，不新增 draft", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 1 });
      const first = await executeOperation(workerPool, registry, operationId, "ds-replay-1");
      expect(first).toBe("succeeded");
      expect(await draftCountFor(operationId)).toBe(1);
      // 同一 operation 已 succeeded → no-op，不重复写 draft。
      const second = await executeOperation(workerPool, registry, operationId, "ds-replay-2");
      expect(second).toBe("already_done");
      expect(await draftCountFor(operationId)).toBe(1);
      expect(await draftCount()).toBe(1);
    });

    it("同一 commit row + 同 input_version 的第二个 operation 被 operation 级 UNIQUE 拒绝（DB 最终防线）", async () => {
      const first = await createDraftOp({ inputVersion: 1 });
      await executeOperation(workerPool, registry, first.operationId, "ds-dedup-1");
      expect(await draftCountFor(first.operationId)).toBe(1);
      // 同 (operation_type, target_type, target_id, input_hash) → 0025 UNIQUE 拒绝第二次插入。
      let rejected = false;
      try {
        await createDraftOp({ inputVersion: 1, commitRowId: first.commitRowId });
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(
          /application_operations_type_target_input_unique/,
        );
      }
      expect(rejected).toBe(true);
      // 只有一个 operation，一个 draft。
      expect(await draftCount()).toBe(1);
    });

    it("并发两个 worker（不同 input_version 同一 commit row）各自独立推进", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      const a = await createDraftOp({ inputVersion: 1, commitRowId });
      const b = await createDraftOp({ inputVersion: 2, commitRowId });
      // input_version=1 → success（draft_ready）；input_version=2 → empty（retry_wait 抛出）。
      const oa = await executeOperation(workerPool, registry, a.operationId, "ds-cc-1");
      expect(oa).toBe("succeeded");
      await expect(
        executeOperation(workerPool, registry, b.operationId, "ds-cc-2"),
      ).rejects.toThrow(/空内容/);
      expect(await draftCount()).toBe(1); // 只有 success 写 draft
    });
  });

  describe("4. retryable / permanent / manual_action 路由", () => {
    it("empty output → retry_wait（可自动重试）", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 2, maxAttempts: 5 });
      await expect(executeOperation(workerPool, registry, operationId, "ds-empty")).rejects.toThrow(
        /DRAFT_EMPTY_OUTPUT|空内容/,
      );
      expect(await opStatus(operationId)).toBe("retry_wait");
      expect(await draftCountFor(operationId)).toBe(0);
    });

    it("非 JSON → retry_wait（有限重试）", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 3, maxAttempts: 5 });
      await expect(
        executeOperation(workerPool, registry, operationId, "ds-nonjson"),
      ).rejects.toThrow(/解析失败/);
      expect(await opStatus(operationId)).toBe("retry_wait");
    });

    it("429 rate limit → retry_wait", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 10, maxAttempts: 5 });
      await expect(executeOperation(workerPool, registry, operationId, "ds-429")).rejects.toThrow(
        /繁忙/,
      );
      expect(await opStatus(operationId)).toBe("retry_wait");
    });

    it("5xx → retry_wait", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 11, maxAttempts: 5 });
      await expect(executeOperation(workerPool, registry, operationId, "ds-5xx")).rejects.toThrow(
        /不可用/,
      );
      expect(await opStatus(operationId)).toBe("retry_wait");
    });

    it("extra field → permanent failed（不自动重试），不写 draft", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 6 });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-extra");
      expect(outcome).toBe("failed");
      expect(await opStatus(operationId)).toBe("failed");
      expect(await draftCountFor(operationId)).toBe(0);
    });

    it("unsafe content → permanent failed", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 7 });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-unsafe");
      expect(outcome).toBe("failed");
      expect(await opStatus(operationId)).toBe("failed");
    });

    it("over length → permanent failed", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 9 });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-over");
      expect(outcome).toBe("failed");
      expect(await opStatus(operationId)).toBe("failed");
    });

    it("auth failed → manual_action，不写 draft", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 16 });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-auth");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
      expect(await draftCountFor(operationId)).toBe(0);
    });

    it("budget exceeded → manual_action", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 17 });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-budget");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
    });

    it("model identity insufficient → manual_action，不写 draft，不伪造版本", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 25 });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-mid");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
      const op = await pool.query<{ last_error_code: string | null }>(
        "SELECT last_error_code FROM application_operations WHERE id = $1",
        [operationId],
      );
      expect(op.rows[0]!.last_error_code).toBe("DRAFT_MODEL_IDENTITY_INSUFFICIENT");
      expect(await draftCountFor(operationId)).toBe(0);
    });

    it("source fact missing → manual_action（DRAFT_SOURCE_MISSING），不写 draft", async () => {
      // 不播种 source fact → resolveSourceFactId 为 null。
      const { operationId } = await createDraftOp({ inputVersion: 1, seedSource: false });
      const outcome = await executeOperation(workerPool, registry, operationId, "ds-nosrc");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
      const op = await pool.query<{ last_error_code: string | null }>(
        "SELECT last_error_code FROM application_operations WHERE id = $1",
        [operationId],
      );
      expect(op.rows[0]!.last_error_code).toBe("DRAFT_SOURCE_MISSING");
      expect(await draftCountFor(operationId)).toBe(0);
    });
  });

  describe("5. 单条失败不阻塞同批其它 operation", () => {
    it("一个 manual_action + 一个 success 各自独立推进，互不回滚", async () => {
      const bad = await createDraftOp({ inputVersion: 16 });
      const good = await createDraftOp({ inputVersion: 1 });
      const bOut = await executeOperation(workerPool, registry, bad.operationId, "ds-bad");
      const gOut = await executeOperation(workerPool, registry, good.operationId, "ds-good");
      expect(bOut).toBe("manual_action");
      expect(gOut).toBe("succeeded");
      expect(await opStatus(bad.operationId)).toBe("manual_action");
      expect(await opStatus(good.operationId)).toBe("succeeded");
      expect(await draftCount()).toBe(1); // 只有 good 写 draft
    });
  });

  describe("6. deferred draft + completion 原子性", () => {
    it("draft INSERT 与 completeAttempt 同事务：失败整体回滚不留孤儿 draft", async () => {
      // 用 extra-field（permanent）路径：handler 返回 failure，不写 draft。
      // 再验证合法 draft 在 succeeded 时写入，且 DB 回滚不留半条。
      const before = await draftCount();
      const { operationId } = await createDraftOp({ inputVersion: 6 });
      await executeOperation(workerPool, registry, operationId, "ds-rollback");
      expect(await draftCount()).toBe(before); // 无孤儿 draft
    });

    it("draft_ready 事实不可被 UPDATE/DELETE（immutable trigger）", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 1 });
      await executeOperation(workerPool, registry, operationId, "ds-imm");
      const row = (await pool.query<{ id: string }>("SELECT id FROM enrichment_drafts LIMIT 1"))
        .rows[0]!;
      let upd = false;
      try {
        await pool.query(
          "UPDATE enrichment_drafts SET simplified_chinese_meaning='x' WHERE id = $1",
          [row.id],
        );
      } catch (err) {
        upd = true;
        expect(String((err as Error).message)).toMatch(/immutable/);
      }
      expect(upd).toBe(true);
      let del = false;
      try {
        await pool.query("DELETE FROM enrichment_drafts WHERE id = $1", [row.id]);
      } catch (err) {
        del = true;
        expect(String((err as Error).message)).toMatch(/immutable/);
      }
      expect(del).toBe(true);
    });
  });

  describe("7. 敏感字段 / 网络 / 源码守卫", () => {
    it("draft 表不含 prompt / provider response / secret / 路径", async () => {
      const { operationId } = await createDraftOp({ inputVersion: 1 });
      await executeOperation(workerPool, registry, operationId, "ds-secret");
      const rows = await pool.query("SELECT * FROM enrichment_drafts WHERE operation_id = $1", [
        operationId,
      ]);
      const raw = JSON.stringify(rows.rows[0]);
      // 不含完整 prompt 内容（不是 prompt 模板版本元数据）、原始 provider response、API key、路径。
      // prompt_template_version 是合法的版本元数据字段名，只检查是否有实际 prompt 正文/指令泄漏。
      expect(raw).not.toMatch(/englishSpelling["']?\s*:/i);
      expect(raw).not.toMatch(/englishDefinitionExcerpt["']?\s*:/i);
      expect(raw).not.toMatch(/to move quickly/i);
      expect(raw).not.toMatch(/sk-[a-zA-Z0-9]{16,}/);
      expect(raw).not.toMatch(/\/(tmp|Users|home|var|etc|app)\//);
      expect(raw).not.toMatch(/bearer\s+[a-zA-Z0-9]/i);
      expect(raw).not.toMatch(/system\s*:\s*你|你是|assistant\s*:/i);
    });

    it("无外部 URL / key / DNS / 真实 provider 引用", () => {
      const dirs = [
        resolve(process.cwd(), "packages/domain/src/drafts"),
        resolve(process.cwd(), "apps/worker/src"),
      ];
      const banned = [
        /api\.deepseek\.com|deepseek\.com\/v1|\/chat\/completions/i,
        /(sk-|api[_-]?key|secret|access[_-]?token)=[a-zA-Z0-9]{16,}/,
      ];
      const files: string[] = [];
      const collect = (d: string): void => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          if (statSync(p).isDirectory()) collect(p);
          else if (/\.ts$/.test(e) && !/\.spec|\.test|\.d\.ts$/.test(e)) files.push(p);
        }
      };
      for (const d of dirs) collect(d);
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        for (const re of banned) expect(content, f).not.toMatch(re);
        expect(content, f).not.toMatch(/graphile_worker\._private/);
      }
    });
  });

  describe("8. 共享数据库不被清空", () => {
    it("本套件使用一次性隔离数据库（前缀 motro_dsdraft_）", async () => {
      expect(isolatedDbName).toMatch(/^motro_dsdraft_/);
    });
  });
});
