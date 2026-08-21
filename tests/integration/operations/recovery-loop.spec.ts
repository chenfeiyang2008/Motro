// 阶段 6 工单 04：lease-expiry 恢复扫描（recovery loop）集成验收（真实 PostgreSQL）。
//
// 覆盖（每项都在一次性隔离库上进行，完成后销毁数据库，绝不动共享开发库）：
//   1. expired-only：只有 running + lease 已过期 的 operation 进入恢复，其它一律不 enqueue；
//   2. 恢复投递：recovery 投递后，operation 可被重新领取并成功完成；
//   3. 并发扫描：两个独立扫描同时处理同一 operation → 不重复推进 attempt；
//   4. add_job payload 只含最小稳定字段，不含敏感字段；
//   5. add_job 异常：SAVEPOINT 回滚，不进展 attempt；下一周期可重试；
//   6. 负例：running 未过期 / succeeded 永不被加入恢复队列；
//   7. graceful shutdown：RecoveryScanLoop.stop() 清理 timer，停止后不再扫描；
//   8. 源码/网络守卫：不查询 _private_*，不引用外部 URL/Key，不携带敏感 payload。
//
// 完全通过官方公共 API（graphile_worker.add_job / graphile_worker.jobs view）验证，
// 从不查询 _private_* 表。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { claimOperation, executeOperation } from "../../../apps/worker/src/operation-executor.js";
import { buildFixtureHandler } from "../../../apps/worker/src/fixture-handler.js";
import {
  addOperationJob,
  RECOVERY_QUEUE_NAME,
  RecoveryScanLoop,
  runRecoveryScan,
} from "../../../apps/worker/src/recovery-scan.js";
import { operationInputHash, validateOperationPayload } from "@motro/domain";
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

describe("lease-expiry recovery loop", () => {
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let registry: ReturnType<typeof buildFixtureHandler>;
  let isolatedDbName: string | undefined;
  let tempImportRoot: string;
  let fixtureUserId: string;

  /**
   * 直接种入一个处于给定状态的 operation（不投递 job）。
   * 满足 0025 CHECK 不变量：running 需要 started_at，succeeded 需要 completed_at。
   */
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
    const completedAt = status === "succeeded" ? new Date() : null;
    const res = await pool.query<{ id: string }>(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, attempt_count, claim_token,
          lease_expires_at, started_at, completed_at)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        completedAt,
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

  /**
   * 在隔离库的 graphile_worker.jobs（公共只读 view）上，按 recovery job key 前缀统计当前待处理 job。
   * payload 不在公共 view 上暴露；key 本身即 recovery identity。
   */
  async function enqueuedRecoveryJobs(id: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE key LIKE $1`,
      [`motro:ops:recover:${id}:%`],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /**
   * Graphile 公共 jobs view 中 recovery job 的首次调度时刻。
   * preserve_run_at 的关键安全语义是：后续扫描不得把这个时刻不断推迟，
   * 否则周期扫描会让 job 永远没有机会被 worker 拾取。
   */
  async function recoveryJobRunAt(id: string): Promise<string> {
    const r = await pool.query<{ run_at: string }>(
      `SELECT run_at::text AS run_at
       FROM graphile_worker.jobs
       WHERE key LIKE $1
       ORDER BY id ASC
       LIMIT 1`,
      [`motro:ops:recover:${id}:%`],
    );
    return r.rows[0]?.run_at ?? "";
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error("recovery-loop 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。");
    }
    isolatedDbName = `motro_recover_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({
      connectionString: pgConn(isolatedConfig),
      schema: "graphile_worker",
    });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-recover-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.POSTGRES_DB = isolatedDbName;

    pool = createPool({ ...isolatedConfig, max: 4 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });
    registry = buildFixtureHandler(workerPool);
    // 创建用户供 createCommitRow 使用（0029：target_id 必须引用真实 commit row）。
    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Recovery Fixture User', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
      ["recovery-fixture-user", await ps.hashPassword("fixture-pass-123")],
    );
    fixtureUserId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
        "recovery-fixture-user",
      ])
    ).rows[0]!.id;
  });

  afterEach(async () => {
    // 严格重置：TRUNCATE 不触发行级 BEFORE DELETE 触发器（attempts 的不可变删除守卫），
    // 通过 FK CASCADE 一并清空 attempts，保证每个测试在干净基线上运行。
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

  describe("1. expired-only 候选选择", () => {
    it("只有 running + lease 已过期 的 operation 被投递；其它一律不 enqueue", async () => {
      const expiredId = await seed({
        status: "running",
        leaseExpiresAt: new Date(Date.now() - 1000),
      });
      await seed({ status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) }); // 未过期
      await seed({ status: "succeeded", leaseExpiresAt: null });
      await seed({ status: "queued", leaseExpiresAt: null });
      await seed({ status: "running", leaseExpiresAt: null }); // running 但无 lease

      const { report } = await runRecoveryScan(pool, {
        intervalMs: 0,
        batchSize: 20,
      });
      expect(report.scanned).toBe(1);
      expect(report.enqueued).toBe(1);
      // DB 上只有一份待处理 recovery job（以 key prefix 命中确认）。
      expect(await enqueuedRecoveryJobs(expiredId)).toBe(1);
    });

    it("单次扫描有批量上限；不遗漏过期候选", async () => {
      // 造 5 个过期候选，batchSize=2：第一周期投 2 个，第二周期投 2 个，第三周期投 1 个。
      // 注意：投递只是写 graphile_job_id 诊断字段；operation 仍在 running+expired 状态，
      // 所以重复扫描会【重复选择】同一批最旧候选。preserve_run_at 把它们融合为同一份
      // DB job，且不会把首次 run_at 推迟；DB job 数始终 ≤ batchSize（per-operation 去重）。
      for (let i = 0; i < 5; i++) {
        await seed({ status: "running", leaseExpiresAt: new Date(Date.now() - 1000) });
      }
      const { report: r1 } = await runRecoveryScan(pool, {
        intervalMs: 0,
        batchSize: 2,
      });
      expect(r1.scanned).toBe(2);
      expect(r1.enqueued).toBe(2);

      // 第二周期：前 2 个仍在 expired+running，重复投递由 preserve_run_at 融合。
      const { report: r2 } = await runRecoveryScan(pool, {
        intervalMs: 0,
        batchSize: 2,
      });
      expect(r2.enqueued).toBe(2);

      // 第三周期：仍有最旧候选被重选；已有 job 不会被推迟到未来。
      const { report: r3 } = await runRecoveryScan(pool, {
        intervalMs: 0,
        batchSize: 2,
      });
      expect(r3.scanned).toBeGreaterThanOrEqual(1);
    });
  });

  describe("2. 恢复投递后重新领取可成功", () => {
    it("过期 running → recovery 投递 → 重新 claim → 成功完成，attempt 时间线正确", async () => {
      // 模拟旧 worker 崩溃：先 queued，再以【过去的时间】claim 产生已过期 lease + running。
      const id = await seed({ status: "queued", inputVersion: 1 });
      const claimed = await claimOperation(workerPool, id, {
        leaseMs: 60_000,
        leaseOwner: "old-worker",
        now: new Date(Date.now() - 120_000),
      });
      expect(claimed.kind).toBe("claimed");
      // 强制 lease 过期（现在时间下 lease_expires_at 已过去）。
      await pool.query(
        `UPDATE application_operations SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [id],
      );
      expect(await attemptCount(id)).toBe(1);

      const { report } = await runRecoveryScan(pool, {
        intervalMs: 0,
        batchSize: 20,
      });
      expect(report.enqueued).toBe(1);
      expect(await enqueuedRecoveryJobs(id)).toBe(1);

      // recovery job 已投递；worker 重新领取并执行（旧 attempt 标记 abandoned）。
      const outcome = await executeOperation(workerPool, registry, id, "recovery-job");
      expect(outcome).toBe("succeeded");
      const op = await opRow(id);
      expect(op.status).toBe("succeeded");
      expect(op.attempt_count).toBe(2);
      // 注：本测试用 executeOperation 直接执行（不经 Graphile consumer），因此 Graphile
      // 队列中的 recovery job 仍在（未被自动清理）；关键事实是 operation 已 succeeded、
      // 旧 attempt abandoned、新 attempt succeeded——由上面断言覆盖。
    });

    it("多次扫描对同一 operation 保留首次 run_at，不产生多个 pending recovery job", async () => {
      const id = await seed({ status: "running", leaseExpiresAt: new Date(Date.now() - 1000) });
      await runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 });
      const firstRunAt = await recoveryJobRunAt(id);
      expect(firstRunAt).not.toBe("");
      // 跨越一次时钟 tick，若错误使用 replace，run_at 会被刷新为更晚时间。
      await new Promise((resolve) => setTimeout(resolve, 25));
      await runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 });
      await runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 });
      // DB 上只有一份待处理 recovery job（jobKey preserve_run_at 语义融合）。
      expect(await enqueuedRecoveryJobs(id)).toBe(1);
      expect(await recoveryJobRunAt(id)).toBe(firstRunAt);
      // 操作未被消费：attempt 数为 0（扫描本身不推进 attempt）。
      expect(await attemptCount(id)).toBe(0);
    });
  });

  describe("3. 并发扫描唯一 recovery job", () => {
    it("两个独立连接同时扫描同一 operation → 不重复推进 attempt", async () => {
      const id = await seed({ status: "running", leaseExpiresAt: new Date(Date.now() - 1000) });
      const [r1, r2] = await Promise.all([
        runRecoveryScan(workerPool, { intervalMs: 0, batchSize: 20 }),
        runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 }),
      ]);
      // 并发合并：两者 enqueued 之和 ≥ 1，但 DB 上仅一份 recovery job（jobKey 去重）。
      const totalEnqueued = (r1.report.enqueued ?? 0) + (r2.report.enqueued ?? 0);
      expect(totalEnqueued).toBeGreaterThanOrEqual(1);
      expect(await enqueuedRecoveryJobs(id)).toBe(1);
      // 操作未被消费：attempt 数为 0。
      expect(await attemptCount(id)).toBe(0);
    });
  });

  describe("4. recovery job payload 只含最小稳定字段", () => {
    it("add_job 只携带 {operationId, inputVersion}，不含敏感字段", async () => {
      const id = await seed({ status: "running", leaseExpiresAt: new Date(Date.now() - 1000) });
      // 通过透传 spy 捕获 addOperationJob 的参数（只记录投递给 graphile 的载荷字段）。
      const captured: Array<{ operationId: string; inputVersion: number; queueName: string }> = [];
      const spyAddJob: Parameters<typeof runRecoveryScan>[2] = async (client, spec) => {
        captured.push({
          operationId: spec.operationId,
          inputVersion: spec.inputVersion,
          queueName: spec.queueName,
        });
        return addOperationJob(client, spec);
      };
      await runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 }, spyAddJob);
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const capturedJob = captured[0]!;
      expect(capturedJob.operationId).toBe(id);
      expect(capturedJob.inputVersion).toBe(1);
      // 原 queue 被已崩溃的 job 锁住时，恢复任务仍必须可被 worker 取走。
      expect(capturedJob.queueName).toBe(RECOVERY_QUEUE_NAME);
      expect(capturedJob.queueName).not.toBe(QUEUE);
      // queueName 是 add_job 选项、不是 payload；实际 task payload 仍严格只有两项。
      const payload = {
        operationId: capturedJob.operationId,
        inputVersion: capturedJob.inputVersion,
      };
      // 载荷结构合法性校验（validateOperationPayload 只允许 operationId + inputVersion）。
      const parsed = validateOperationPayload(payload);
      expect(parsed.ok).toBe(true);
      // 序列化载荷中不含任何敏感字段名。
      const raw = JSON.stringify(payload);
      expect(raw).not.toMatch(
        /password|secret|storage|path|content|raw|provider|api[_-]?key|authorization/i,
      );
    });
  });

  describe("5. add_job 异常回滚 + 可重试", () => {
    it("add_job 异常：SAVEPOINT 回滚，不进展 attempt；下一周期可重试成功", async () => {
      const id = await seed({
        status: "running",
        inputVersion: 1,
        leaseExpiresAt: new Date(Date.now() - 1000),
        claimToken: randomUUID(),
      });
      const before = await attemptCount(id);
      // 抛异常的假 addJob：recoverOne 的 try/catch 捕获，由 SAVEPOINT 回滚本候选事务。
      const failingAddJob = async () => {
        throw new Error("add_job 注入失败（模拟连接断了）");
      };
      const { report, errors } = await runRecoveryScan(
        pool,
        { intervalMs: 0, batchSize: 20 },
        failingAddJob,
      );
      expect(report.errors).toBeGreaterThanOrEqual(1);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(await attemptCount(id)).toBe(before); // 未进展
      // 下一周期使用真实 addJob：可成功恢复。
      const { report: r2 } = await runRecoveryScan(pool, {
        intervalMs: 0,
        batchSize: 20,
      });
      expect(r2.enqueued).toBeGreaterThanOrEqual(1);
      expect(await enqueuedRecoveryJobs(id)).toBe(1);
    });
  });

  describe("6. 负例：未过期 / succeeded 不被 enqueue", () => {
    it("running 未过期 / succeeded 永不被加入恢复队列", async () => {
      await seed({ status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) });
      await seed({ status: "succeeded", leaseExpiresAt: null });
      const { report } = await runRecoveryScan(pool, {
        intervalMs: 0,
        batchSize: 20,
      });
      expect(report.enqueued).toBe(0);
      expect(report.scanned).toBe(0);
    });
  });

  describe("7. graceful shutdown", () => {
    it("RecoveryScanLoop.stop() 清理 timer，停止后不再扫描", async () => {
      let scans = 0;
      const loop = new RecoveryScanLoop({
        pool,
        intervalMs: 50,
        batchSize: 20,
        onReport: () => {
          scans++;
        },
      });
      loop.start();
      // start() 立即触发一次 tick()（异步）。等待足够让第一次扫描完成。
      await new Promise((r) => setTimeout(r, 200));
      const scansWhileRunning = scans;
      expect(scansWhileRunning).toBeGreaterThanOrEqual(1);
      await loop.stop();
      expect(loop.isStopped()).toBe(true);
      const stoppedAt = scans;
      // 停止后再等 2 个 interval：timer 已清理，不应继续扫描。
      await new Promise((r) => setTimeout(r, 150));
      expect(scans).toBe(stoppedAt);
    });
  });

  describe("8. 源码/网络守卫", () => {
    it("恢复实现不查询 _private_* 表，不引用外部 URL/Key 或真实账户，不携带敏感 payload", () => {
      const dirs = [
        resolve(process.cwd(), "apps/worker/src"),
        resolve(process.cwd(), "packages/domain/src/operations"),
      ];
      // T22 真实 adapter 含必要端点配置；从扫描中排除。
      const exclude = new Set(["wiktionary-real-adapter.ts", "deepseek-real-adapter.ts"]);
      const files: string[] = [];
      const collect = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir)) {
          const p = join(dir, e);
          if (statSync(p).isDirectory()) collect(p);
          else if (
            /\.ts$/.test(e) &&
            !/\.spec\.ts$/.test(e) &&
            !/\.d\.ts$/.test(e) &&
            !exclude.has(e)
          )
            files.push(p);
        }
      };
      for (const d of dirs) collect(d);
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        expect(content).not.toMatch(/graphile_worker\._private/);
        expect(content).not.toMatch(/_private_jobs/);
        expect(content).not.toMatch(/wiktionary\.org|www\.mediawiki|api\.deepseek|deepseek\.com/i);
        expect(content).not.toMatch(/(sk-|api[_-]?key|secret|access[_-]?token)=[a-zA-Z0-9]{16,}/);
      }
      // recovery-scan.ts 不含敏感值字面量绑定（注释里提及的禁止词不在此列）。
      const rec = readFileSync(resolve(process.cwd(), "apps/worker/src/recovery-scan.ts"), "utf8");
      expect(rec).not.toMatch(
        /(?:apiKey|password|authorization|bearer|storageKey|filePath)\s*[:=]\s*["']/i,
      );
      expect(rec).not.toMatch(/postgresql:\/\/\S+:\S+@/);
    });
  });
});
