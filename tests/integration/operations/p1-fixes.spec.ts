// 阶段 6 工单 04 收口：P1 修复的真实 PostgreSQL 集成验收。
//
// 覆盖：
//   P1-1 最大尝试次数终止：operation 达到 max_attempts 且 lease 过期 → 终止为 failed，
//        错误码 OPERATION_MAX_ATTEMPTS_EXCEEDED，clear claim/lease，recovery 不再 enqueue；
//   P1-3 attempt 删除保护：删除带 attempt 的 operation 被 FK RESTRICT 拒绝；
//   P2-1 target_type 数据库白名单 CHECK。
//   （P1-2 retry 冻结首响应 见 tests/integration/operations/retry-frozen.spec.ts。）
//
// 每项都在一次性隔离库上进行，完成后销毁数据库，绝不动共享开发库。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import {
  claimOperation,
  executeOperation,
  type ClaimResult,
} from "../../../apps/worker/src/operation-executor.js";
import { buildFixtureHandler } from "../../../apps/worker/src/fixture-handler.js";
import { runRecoveryScan } from "../../../apps/worker/src/recovery-scan.js";
import { operationInputHash } from "@motro/domain";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { createCommitRow } from "./commit-row-helper.js";

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

const OP_TYPE = "motro-op-fixture";
const QUEUE = "local";

describe("ticket 04 P1 fixes", () => {
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let registry: ReturnType<typeof buildFixtureHandler>;
  let isolatedDbName: string | undefined;
  let tempImportRoot: string;
  let fixtureUserId: string;

  async function seed(
    opts: Partial<{
      status: string;
      leaseExpiresAt: Date | null;
      inputVersion: number;
      claimToken: string | null;
      maxAttempts: number;
      attemptCount: number;
    }> = {},
  ): Promise<string> {
    // 0029：target_id 必须引用真实 import_batch_commit_rows(id)。
    const targetId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
    const inputVersion = opts.inputVersion ?? 1;
    const status = opts.status ?? "queued";
    const startedAt = status === "running" ? new Date() : null;
    const res = await pool.query<{ id: string }>(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, attempt_count, claim_token,
          lease_expires_at, started_at)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        OP_TYPE,
        targetId,
        operationInputHash({
          operationType: OP_TYPE,
          targetType: "import_batch_commit_row",
          targetId,
          inputVersion,
        }),
        inputVersion,
        status,
        OP_TYPE,
        QUEUE,
        opts.maxAttempts ?? 5,
        opts.attemptCount ?? 0,
        opts.claimToken ?? null,
        opts.leaseExpiresAt ?? null,
        startedAt,
      ],
    );
    return res.rows[0]!.id;
  }

  async function opRow(id: string): Promise<Record<string, unknown>> {
    const r = await pool.query("SELECT * FROM application_operations WHERE id = $1", [id]);
    return r.rows[0]! as Record<string, unknown>;
  }

  async function attemptCount(id: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
      [id],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error("P1 fixes 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。");
    }
    isolatedDbName = `motro_p1fix_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-p1fix-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.POSTGRES_DB = isolatedDbName;

    pool = createPool({ ...isolatedConfig, max: 4 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });
    registry = buildFixtureHandler(workerPool);
    // 创建用户供 createCommitRow 使用（0029：target_id 必须引用真实 commit row）。
    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'P1 Fix User', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
      ["p1-fix-user", await ps.hashPassword("fixture-pass-123")],
    );
    fixtureUserId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", ["p1-fix-user"])
    ).rows[0]!.id;
  });

  afterEach(async () => {
    await pool.query("TRUNCATE application_operations CASCADE");
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

  describe("P1-1 最大尝试次数终止", () => {
    it("达到 max_attempts 且 lease 过期 → operation 终止为 failed，recovery 不再 enqueue，attempt 不增长", async () => {
      // queued 开始，真实 claim（attempt 1）；人为耗尽到 max_attempts=1，产生过期 lease。
      const id = await seed({ status: "queued", inputVersion: 1, maxAttempts: 1 });
      const claimed = await claimOperation(workerPool, id, {
        leaseMs: 60_000,
        leaseOwner: "w1",
        now: new Date(Date.now() - 120_000),
      });
      const c = claimed as Extract<ClaimResult, { kind: "claimed" }>;
      expect(c.kind).toBe("claimed");
      expect(await attemptCount(id)).toBe(1);
      // lease 过期（现在时间下 attempt_count=1 = max_attempts=1）。
      await pool.query(
        `UPDATE application_operations SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [id],
      );

      // recovery 扫描发现它，但 claimOperation 应在 max_attempts 边界终止 → executeOperation 返回 max_attempts_exceeded。
      // 先让 recovery 投递 job（它仍会投递一次，因为 operation 尚是 running+expired）。
      await runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 });
      // 再执行 recovery job → 触发终止。
      const outcome = await executeOperation(workerPool, registry, id, "recovery-job");
      expect(outcome).toBe("max_attempts_exceeded");

      const op = await opRow(id);
      expect(op.status).toBe("failed");
      expect(op.retryable).toBe(false);
      expect(op.last_error_code).toBe("OPERATION_MAX_ATTEMPTS_EXCEEDED");
      expect(op.claim_token).toBeNull();
      expect(op.lease_owner).toBeNull();
      expect(op.lease_expires_at).toBeNull();
      expect(op.completed_at).not.toBeNull();
      // attempt 数不增长（旧的被 abandoned，不新增）。
      const attempts = await pool.query<{ outcome: string | null }>(
        "SELECT outcome FROM application_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number",
        [id],
      );
      expect(attempts.rows).toHaveLength(1);
      expect(attempts.rows[0]!.outcome).toBe("abandoned");
      // 已 terminated → recovery scan 不再 enqueue。
      const after = await runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 });
      expect(after.report.enqueued).toBe(0);
      // 已完成 attempt 不可变（DELETE 被拒绝）。
      const attId = (
        await pool.query<{ id: string }>(
          "SELECT id FROM application_operation_attempts WHERE operation_id = $1 LIMIT 1",
          [id],
        )
      ).rows[0]!.id;
      let rejected = false;
      try {
        await pool.query("DELETE FROM application_operation_attempts WHERE id = $1", [attId]);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });

  describe("P1-2 operation 状态迁移数据库最终防线（0030）", () => {
    async function expectTransitionRejected(
      id: string,
      nextStatus: string,
      fields = "",
    ): Promise<void> {
      await expect(
        pool.query(`UPDATE application_operations SET status = $2 ${fields} WHERE id = $1`, [
          id,
          nextStatus,
        ]),
      ).rejects.toThrow(/application operation status transition is invalid/i);
    }

    it("非法 SQL 状态倒退/跳转被拒绝；合法迁移与同状态诊断更新通过", async () => {
      const succeeded = await seed();
      await pool.query(
        `UPDATE application_operations
         SET status = 'succeeded', completed_at = now() WHERE id = $1`,
        [succeeded],
      );
      await expectTransitionRejected(succeeded, "queued");

      const failed = await seed();
      await pool.query(
        `UPDATE application_operations SET status = 'failed', completed_at = now() WHERE id = $1`,
        [failed],
      );
      await expectTransitionRejected(failed, "running", ", started_at = now()");
      await pool.query(
        `UPDATE application_operations SET status = 'queued', completed_at = NULL WHERE id = $1`,
        [failed],
      );

      const manual = await seed({ status: "manual_action" });
      await expectTransitionRejected(manual, "succeeded", ", completed_at = now()");
      await pool.query(`UPDATE application_operations SET status = 'queued' WHERE id = $1`, [
        manual,
      ]);

      const retryWait = await seed({ status: "retry_wait" });
      await expectTransitionRejected(retryWait, "succeeded", ", completed_at = now()");
      await pool.query(`UPDATE application_operations SET status = 'queued' WHERE id = $1`, [
        retryWait,
      ]);

      await pool.query(
        `UPDATE application_operations
         SET status = status, last_error_summary = 'diagnostic update' WHERE id = $1`,
        [retryWait],
      );
    });
  });

  describe("P1-3 attempt 删除保护", () => {
    it("删除带 attempt 的 operation 被 FK RESTRICT 拒绝；attempt 仍存在", async () => {
      const id = await seed({ status: "queued", inputVersion: 1 });
      const claimed = await claimOperation(workerPool, id, { leaseMs: 60_000 });
      const c = claimed as Extract<ClaimResult, { kind: "claimed" }>;
      expect(c.kind).toBe("claimed");
      expect(await attemptCount(id)).toBe(1);

      // 删除 operation 应被 RESTRICT 拒绝（attempt 仍在）。
      let rejected = false;
      try {
        await pool.query("DELETE FROM application_operations WHERE id = $1", [id]);
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(
          /application_operation_attempts_operation_id_fkey/i,
        );
      }
      expect(rejected).toBe(true);
      // attempt 仍存在。
      expect(await attemptCount(id)).toBe(1);
      // 完整性触发器保持 enabled（未禁用）。
      const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger
         WHERE tgrelid = 'application_operation_attempts'::regclass AND NOT tgisinternal
         ORDER BY tgname`,
      );
      const names = triggers.rows.map((r) => r.tgname);
      expect(names).toContain("application_operation_attempts_no_delete");
      expect(names).toContain("application_operation_attempts_no_update_after_completion");
      for (const t of triggers.rows) expect(t.tgenabled).toBe("O");
    });
  });

  describe("P2-1 target_type 数据库白名单", () => {
    it("非法 target_type 被拒绝；合法类型可写入", async () => {
      let rejected = false;
      const realCommitRow = await createCommitRow(pool, { userId: fixtureUserId });
      try {
        await pool.query(
          `INSERT INTO application_operations
             (operation_type, operation_version, target_type, target_id, input_hash, input_version,
              status, task_identifier, queue_name, max_attempts)
           VALUES ($1, 1, 'unknown_type', $2, $3, 1, 'queued', $1, $4, 5)`,
          [OP_TYPE, realCommitRow.commitRowId, "hash_unknown", QUEUE],
        );
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(/target_type_whitelist/i);
      }
      expect(rejected).toBe(true);
      // 合法类型可写入（target_id 引用真实 commit row）。
      await pool.query(
        `INSERT INTO application_operations
           (operation_type, operation_version, target_type, target_id, input_hash, input_version,
            status, task_identifier, queue_name, max_attempts)
         VALUES ($1, 1, 'import_batch_commit_row', $2, $3, 1, 'queued', $1, $4, 5)`,
        [OP_TYPE, realCommitRow.commitRowId, "hash_ok", QUEUE],
      );
      const ok = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM application_operations WHERE target_type = 'import_batch_commit_row'`,
      );
      expect(Number(ok.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("P1-4 target_id 引用完整性（0029）", () => {
    it("不存在的 target_id 被 FK 拒绝", async () => {
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO application_operations
             (operation_type, operation_version, target_type, target_id, input_hash, input_version,
              status, task_identifier, queue_name, max_attempts)
           VALUES ($1, 1, 'import_batch_commit_row', $2, $3, 1, 'queued', $1, $4, 5)`,
          [OP_TYPE, "00000000-0000-4000-8000-0000000000ff", "hash_missing", QUEUE],
        );
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(/application_operations_target_id_fkey/i);
      }
      expect(rejected).toBe(true);
    });

    it("删除被 operation 引用的 commit row 被 RESTRICT 拒绝；合法 commit row 可创建 operation", async () => {
      const commitRow = await createCommitRow(pool, { userId: fixtureUserId });
      // 合法 commit row 可创建 operation。
      const ok = await pool.query<{ id: string }>(
        `INSERT INTO application_operations
           (operation_type, operation_version, target_type, target_id, input_hash, input_version,
            status, task_identifier, queue_name, max_attempts)
         VALUES ($1, 1, 'import_batch_commit_row', $2, $3, 1, 'queued', $1, $4, 5)
         RETURNING id`,
        [OP_TYPE, commitRow.commitRowId, "hash_valid", QUEUE],
      );
      expect(ok.rows[0]!.id).toBeTruthy();
      // 删除被引用的 commit row → 被拒绝（immutable trigger 或 FK RESTRICT 均可证明）。
      let rejected = false;
      try {
        await pool.query("DELETE FROM import_batch_commit_rows WHERE id = $1", [
          commitRow.commitRowId,
        ]);
      } catch (err) {
        rejected = true;
        const msg = String((err as Error).message);
        // commit facts 本身不可删除（更强保护），或 FK RESTRICT。
        expect(
          /application_operations_target_id_fkey|commit facts are immutable|immutable/i.test(msg),
        ).toBe(true);
      }
      expect(rejected).toBe(true);
    });
  });
});
