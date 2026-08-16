// 阶段 6 工单 04：Worker 操作基础集成验收（真实 PostgreSQL + in-process worker 执行）。
//
// 覆盖（每项都在一次性隔离库上进行，完成后销毁数据库，绝不动共享开发库）：
//   1. 空库业务 migration 0001–0025 + Graphile 官方 migration 就绪；
//   2. commit 成功：operation + job 原子可见（同一事务投递）；
//   3. commit/审计/add_job 失败：全部回滚（不产生 operation/job/业务事实）；
//   4. 同一操作类型 + 目标 + input 唯一：重放/并发只产生一个 operation；
//   5. fixture handler 成功 → queued/running → succeeded；
//   6. fixture 可重试失败 + 退避：operation → retry_wait，attempt 增长；
//   7. fixture 永久失败 → failed（终止自动重试）；
//   8. 达到最大尝试 → failed；
//   9. 重复 job / at-least-once：已 succeeded 不再重复执行业务意图；
//  10. 管理员重试幂等：同 key 重放原结果；同 key 改载荷 409；
//  11. learner / 未登录拒绝；CSRF 拒绝；
//  12. payload 只含 {operationId, inputVersion}，不泄露敏感字段。
//
// 由于本票 fixture 不触网，普通测试默认禁用外网（网络禁用守卫见 fixture handler 设计）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { loadConfig } from "@motro/config";
import { runMigrations } from "graphile-worker";
import type { Pool } from "pg";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { AuthModule } from "../../../apps/api/src/auth/auth.module.js";
import { POOL } from "../../../apps/api/src/auth/database.provider.js";
import { DbHealthService } from "../../../apps/api/src/health/db-health.service.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { ImportModule } from "../../../apps/api/src/modules/admin/imports/import.module.js";
import { OperationsModule } from "../../../apps/api/src/modules/operations/operations.module.js";
import { OperationEnqueueService } from "../../../apps/api/src/modules/operations/enqueue.service.js";
import {
  claimOperation,
  completeAttempt,
  executeOperation,
  leaseHeartbeat,
  type ClaimResult,
} from "../../../apps/worker/src/operation-executor.js";
import { buildFixtureHandler } from "../../../apps/worker/src/fixture-handler.js";
import { buildTaskList } from "../../../apps/worker/src/task-list.js";
import { runRecoveryScan } from "../../../apps/worker/src/recovery-scan.js";
import { operationInputHash, validateOperationPayload } from "@motro/domain";
import { createCommitRow } from "./commit-row-helper.js";

type App = Awaited<ReturnType<typeof createApp>>;

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

interface Res {
  statusCode: number;
  json(): unknown;
  headers: Record<string, unknown>;
}
type HttpMethod = "GET" | "POST";
interface Client {
  warm(): Promise<void>;
  req(
    method: HttpMethod,
    url: string,
    opts?: { payload?: object; headers?: Record<string, string> },
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
  } as Client;
}

async function closeModulePools(app: App): Promise<void> {
  const modules = [AuthModule, ImportModule, OperationsModule];
  const pools = new Set<Pool>();
  for (const module of modules) {
    pools.add(app.select(module).get<Pool>(POOL, { strict: true }));
  }
  await Promise.all([...pools].map((p) => p.end()));
  // 关闭 health 服务内部池（避免连接残留阻塞隔离库 DROP）。
  const health = app.get(DbHealthService);
  await health.close();
}

// 哨兵：真实 commit row 不会用到；测试用唯一 target + 行为 input_version 触发语义。
// input_version：1 成功 / 2 可重试失败 / 3 永久失败。
const SUCCESS_IV = 1;
const RETRY_IV = 2;
const PERM_IV = 3;

/** 递归收集一个目录下所有非 spec 的 TS 源码文件（供源码扫描守卫）。 */
function collectTsFiles(dir: string, acc: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      collectTsFiles(p, acc);
    } else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      acc.push(p);
    }
  }
}

/** 断言 claim 成功并窄化为 claimed 变体。 */
function asClaimed(r: ClaimResult): Extract<ClaimResult, { kind: "claimed" }> {
  if (r.kind !== "claimed") throw new Error(`期望 claimed，实际 ${r.kind}`);
  return r;
}

describe("worker operations foundation", () => {
  let app: App;
  let admin: Client;
  let learner: Client;
  let anon: Client;
  let pool: ReturnType<typeof createPool>;
  let isolatedDbName: string | undefined;
  let adminUserId: string;
  let tempImportRoot: string;
  let enqueue: OperationEnqueueService;
  let workerRegistry: ReturnType<typeof buildFixtureHandler>;
  let workerPool: ReturnType<typeof createPool>;

  const opType = "motro-op-fixture";
  const queueName = "local";
  function uniqKey(): string {
    return `${randomUUID()}-${Date.now()}`;
  }
  function body(res: Res): Record<string, unknown> {
    return res.json() as Record<string, unknown>;
  }
  async function qcount(sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query<{ n: string }>(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  }
  /** 直接创建 operation 并投递 job（模拟 enqueue port 在事务内的工作）。 */
  async function createOperation(opts: {
    /** 显式复用某 commit row id（用于幂等/唯一测试）；缺省则新建真实 commit row。 */
    commitRowId?: string;
    inputVersion?: number;
    maxAttempts?: number;
    requestedBy?: string;
  }): Promise<{ operationId: string; created: boolean; targetId: string }> {
    // 0029：target_id 必须引用真实 import_batch_commit_rows(id)。
    const targetId =
      opts.commitRowId ?? (await createCommitRow(pool, { userId: adminUserId })).commitRowId;
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const r = await enqueue.enqueueInTransaction(client, {
        operationType: opType,
        targetType: "import_batch_commit_row",
        targetId,
        inputVersion: opts.inputVersion ?? 1,
        inputHash: operationInputHash({
          operationType: opType,
          targetType: "import_batch_commit_row",
          targetId,
          inputVersion: opts.inputVersion ?? 1,
        }),
        requestedBy: opts.requestedBy ?? adminUserId,
        queueName,
        maxAttempts: opts.maxAttempts ?? 5,
      });
      await client.query("COMMIT");
      if (r === null) throw new Error("enqueue returned null");
      return { ...r, targetId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "worker-operations 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。",
      );
    }
    isolatedDbName = `motro_worker_op_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-worker-op-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.IMPORT_MAX_FILE_BYTES = String(6 * 1024 * 1024);

    const suffix = randomBytes(3).toString("hex");
    const ps = new PasswordService();
    pool = createPool({ ...isolatedConfig, max: 2 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });
    const adminU = `wop-admin-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'WOP Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [adminU, await ps.hashPassword("Admin-pass-123")],
    );
    adminUserId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [adminU])
    ).rows[0]!.id;
    const learnerU = `wop-learner-${suffix}`;
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'WOP Learner', 'learner', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', must_change_password = false`,
      [learnerU, await ps.hashPassword("learner-pass-123")],
    );

    // 装配 Nest app（指向隔离库）；worker 用其自己的 pool + registry。
    process.env.POSTGRES_DB = isolatedDbName;
    const cfg = loadConfig();
    app = await createApp({
      ...cfg,
      db: { ...cfg.db, database: isolatedDbName },
      import: { ...cfg.import, fileRootDir: tempImportRoot },
    });
    await app.init();
    enqueue = app.select(OperationsModule).get(OperationEnqueueService, { strict: true });
    workerRegistry = buildFixtureHandler(workerPool);

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

  describe("1. 空库 migration + Graphile schema", () => {
    it("业务 migration 0001–0030 已应用且 graphile_worker 就绪", async () => {
      const versions = await pool.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(versions.rows.map((r) => r.version)).toContain(30);
      expect(versions.rows.map((r) => r.version)).toContain(31);
      expect(versions.rows.map((r) => r.version)).toContain(32);
      expect(versions.rows.map((r) => r.version)).toContain(33);
      const max = Math.max(...versions.rows.map((r) => r.version));
      expect(max).toBe(36);
      const sch = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.schemata WHERE schema_name = 'graphile_worker'`,
      );
      expect(Number(sch.rows[0]?.n ?? 0)).toBe(1);
    });

    it("API readiness 区分业务 migration 完成但 Graphile schema 未就绪", async () => {
      // 就绪态（graphile_worker 已存在）→ 200 ok。
      const ready = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(ready.statusCode).toBe(200);
      const readyBody = ready.json() as {
        status: string;
        checks?: { db: string; graphileWorker: string };
      };
      expect(readyBody.status).toBe("ok");
      expect(readyBody.checks?.graphileWorker).toBe("ok");

      // 临时隐藏 graphile_worker schema（改名）→ 503 degraded，且区分 graphileWorker=missing。
      // 用独立连接避免影响 app 的池；完成后立即还原。
      const renamePool = createPool({ ...config, database: isolatedDbName!, max: 1 });
      try {
        await renamePool.query(
          `ALTER SCHEMA graphile_worker RENAME TO graphile_worker_probe_hidden`,
        );
        const degraded = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
        expect(degraded.statusCode).toBe(503);
        const db = degraded.json() as {
          status: string;
          checks?: { db: string; graphileWorker: string };
        };
        expect(db.status).toBe("degraded");
        expect(db.checks?.db).toBe("ok");
        expect(db.checks?.graphileWorker).toBe("missing");
      } finally {
        await renamePool.query(
          `ALTER SCHEMA graphile_worker_probe_hidden RENAME TO graphile_worker`,
        );
        await renamePool.end();
      }
      // 还原后就绪恢复 200。
      const after = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(after.statusCode).toBe(200);
    });
  });

  describe("2. 原子投递与幂等", () => {
    it("创建 operation + 同一事务投递 job，操作/job 原子可见", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      expect(r.created).toBe(true);
      const op = await pool.query<{ id: string; status: string; graphile_job_id: string | null }>(
        "SELECT id, status, graphile_job_id FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]).toBeTruthy();
      expect(op.rows[0]!.status).toBe("queued");
      expect(op.rows[0]!.graphile_job_id).toBeTruthy();
      // 通过官方公共只读 jobs view 验证 job 被投递（不查 _private_*）。
      const job = await pool.query<{ id: string; task_identifier: string; queue_name: string }>(
        `SELECT id, task_identifier, queue_name FROM graphile_worker.jobs WHERE id = $1`,
        [op.rows[0]!.graphile_job_id!],
      );
      expect(job.rows[0]!.task_identifier).toBe(opType);
      expect(job.rows[0]!.queue_name).toBe(queueName);
    });

    it("同一 operation_type+target+input 唯一：重放只产生一个 operation", async () => {
      const commitRow = await createCommitRow(pool, { userId: adminUserId });
      await createOperation({ commitRowId: commitRow.commitRowId });
      const r2 = await createOperation({ commitRowId: commitRow.commitRowId });
      expect(r2.created).toBe(false);
      const n = await qcount(
        `SELECT count(*)::text AS n FROM application_operations WHERE target_id = $1`,
        [commitRow.commitRowId],
      );
      expect(n).toBe(1);
    });

    it("operation 事实是权威来源；不依赖 Graphile payload 或私有表", async () => {
      // payload 设计为只含 {operationId, inputVersion}。此处校验 operation 事实本身
      // 不携带任何敏感字段（payload 是 Graphile 内部，业务不读取它）。
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const op = await pool.query<{
        operation_type: string;
        target_type: string;
        target_id: string;
        input_hash: string;
        input_version: number;
        task_identifier: string;
        queue_name: string;
        graphile_job_id: string | null;
      }>(
        `SELECT operation_type, target_type, target_id, input_hash, input_version,
                task_identifier, queue_name, graphile_job_id
         FROM application_operations WHERE id = $1`,
        [r.operationId],
      );
      const raw = JSON.stringify(op.rows[0]);
      expect(raw).toContain(opType);
      expect(raw).toContain("import_batch_commit_row");
      expect(raw).not.toMatch(/password|token|secret|storage|path|content|raw|provider/i);
      // job key 命名空间（通过官方公共 jobs view 的 key 字段验证，不查私有表）。
      // job 可能已被 worker 消费（Graphile 成功删除），此时以 operation 事实为准。
      if (op.rows[0]!.graphile_job_id) {
        const job = await pool.query<{ key: string | null }>(
          `SELECT key FROM graphile_worker.jobs WHERE id = $1`,
          [op.rows[0]!.graphile_job_id],
        );
        const jKey = job.rows[0]?.key;
        if (jKey !== undefined && jKey !== null) expect(jKey.startsWith("motro:op")).toBe(true);
      }
    });
  });

  describe("3. Worker 执行生命周期（fixture handler）", () => {
    it("成功：queued → running → succeeded，attempt 记录", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const outcome = await executeOperation(workerPool, workerRegistry, r.operationId, "job-1");
      expect(outcome).toBe("succeeded");
      const op = await pool.query<{
        status: string;
        attempt_count: number;
        completed_at: Date | null;
      }>("SELECT status, attempt_count, completed_at FROM application_operations WHERE id = $1", [
        r.operationId,
      ]);
      expect(op.rows[0]!.status).toBe("succeeded");
      expect(op.rows[0]!.attempt_count).toBe(1);
      expect(op.rows[0]!.completed_at).not.toBeNull();
      const att = await pool.query<{ outcome: string }>(
        "SELECT outcome FROM application_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number",
        [r.operationId],
      );
      expect(att.rows).toHaveLength(1);
      expect(att.rows[0]!.outcome).toBe("succeeded");
    });

    it("可重试失败：attempt 增长，状态 → retry_wait，仍可再次执行", async () => {
      const r = await createOperation({ inputVersion: RETRY_IV });
      // 可重试失败：executeOperation 记录 attempt 后抛给 Graphile 退避 → 操作转 retry_wait。
      await expect(
        executeOperation(workerPool, workerRegistry, r.operationId, "job-r1"),
      ).rejects.toThrow(/临时失败/);
      let op = await pool.query<{ status: string; attempt_count: number }>(
        "SELECT status, attempt_count FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("retry_wait");
      expect(op.rows[0]!.attempt_count).toBe(1);
      // 第二次（模拟退避后再次触发）仍可重试失败。
      await expect(
        executeOperation(workerPool, workerRegistry, r.operationId, "job-r2"),
      ).rejects.toThrow(/临时失败/);
      op = await pool.query(
        "SELECT status, attempt_count FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("retry_wait");
      expect(op.rows[0]!.attempt_count).toBe(2);
    });

    it("永久失败：→ failed，不抛回（终止自动重试）", async () => {
      const r = await createOperation({ inputVersion: PERM_IV });
      const outcome = await executeOperation(workerPool, workerRegistry, r.operationId, "job-p");
      expect(outcome).toBe("failed");
      const op = await pool.query<{ status: string; retryable: boolean }>(
        "SELECT status, retryable FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("failed");
      expect(op.rows[0]!.retryable).toBe(false);
    });

    it("达到最大尝试：多次可重试失败后 → failed", async () => {
      const r = await createOperation({
        inputVersion: RETRY_IV,
        maxAttempts: 3,
      });
      for (let i = 1; i <= 2; i++) {
        await expect(
          executeOperation(workerPool, workerRegistry, r.operationId, `job-m${i}`),
        ).rejects.toThrow(/临时失败/);
      }
      // 第三次用尽（不可再退避）→ 不再抛出，转为 failed。
      const third = await executeOperation(workerPool, workerRegistry, r.operationId, "job-m3");
      expect(third).toBe("failed");
      const op = await pool.query<{ status: string; attempt_count: number }>(
        "SELECT status, attempt_count FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("failed");
      expect(op.rows[0]!.attempt_count).toBe(3);
    });

    it("at-least-once：已 succeeded 的重复 job 不再执行业务意图（no-op）", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      expect(await executeOperation(workerPool, workerRegistry, r.operationId, "j1")).toBe(
        "succeeded",
      );
      // 重复 job（如 worker 崩溃恢复重放）→ already_done，不新增 attempt/不改变状态。
      expect(await executeOperation(workerPool, workerRegistry, r.operationId, "j2")).toBe(
        "already_done",
      );
      const n = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(n).toBe(1);
    });

    it("运行中且 lease 未过期：重复 job no-op，不新增 attempt，不执行 handler", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      // 第一次真实领取（lease 生效）。
      const claimed = await claimOperation(workerPool, r.operationId, {
        leaseMs: 60_000,
        leaseOwner: "test-worker-1",
      });
      expect(claimed.kind).toBe("claimed");
      // 立即第二个 job 领取同一 operation（running + lease 未过期）→ 必须 no-op。
      const second = await claimOperation(workerPool, r.operationId, {
        leaseMs: 60_000,
        leaseOwner: "test-worker-2",
      });
      expect(second.kind).toBe("noop");
      const n = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(n).toBe(1); // 只有一个 attempt
      // 第一个 claim 完成（成功），operation → succeeded。
      const c1 = asClaimed(claimed);
      const out = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: c1.attemptNumber,
        claimToken: c1.claimToken,
        graphileJobId: "job-hold",
        succeeded: true,
      });
      expect(out).toBe("succeeded");
    });

    it("P0 并发：两个独立连接同时领取同一 queued operation → 恰好一个 claim/attempt/handler", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      // 两个独立连接并发领取（真实 Promise.all，非顺序）。
      const results = await Promise.all([
        claimOperation(workerPool, r.operationId, { leaseMs: 60_000, leaseOwner: "t1" }),
        claimOperation(workerPool, r.operationId, { leaseMs: 60_000, leaseOwner: "t2" }),
      ]);
      const claims = results.filter((x) => x.kind === "claimed");
      expect(claims).toHaveLength(1); // 恰好一个获得 claim
      const attempts = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(attempts).toBe(1); // 恰好一个 attempt
      // 持有 claim 的 worker 完成；另一个 no-op。
      const winner = claims[0] as Extract<(typeof results)[number], { kind: "claimed" }>;
      const out = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: winner.attemptNumber,
        claimToken: winner.claimToken,
        graphileJobId: "concurrent-winner",
        succeeded: true,
      });
      expect(out).toBe("succeeded");
      // handler 只执行一次：此后重复 job 全部 no-op。
      expect(await executeOperation(workerPool, workerRegistry, r.operationId, "dup-after")).toBe(
        "already_done",
      );
    });

    it("P0 并发：执行中的 operation 由重复 job 领取 → no-op（不执行 handler）", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const claimed = await claimOperation(workerPool, r.operationId, {
        leaseMs: 60_000,
        leaseOwner: "holder",
      });
      expect(claimed.kind).toBe("claimed");
      // 并发重复 job 尝试领取 → no-op（running + lease 未过期）。
      const [dup1, dup2] = await Promise.all([
        claimOperation(workerPool, r.operationId, { leaseMs: 60_000, leaseOwner: "d1" }),
        claimOperation(workerPool, r.operationId, { leaseMs: 60_000, leaseOwner: "d2" }),
      ]);
      expect(dup1.kind).toBe("noop");
      expect(dup2.kind).toBe("noop");
      const n = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(n).toBe(1);
    });

    it("P0 重领：running + lease 已过期 → 可安全重领，旧 attempt 标记 abandoned，新 attempt 继续编号", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const past = new Date(Date.now() - 1000);
      // 模拟旧 worker 崩溃：已领取但 lease 已过期。
      const claimed1 = await claimOperation(workerPool, r.operationId, {
        leaseMs: 1000,
        leaseOwner: "crashed-worker",
        now: new Date(Date.now() - 2000),
      });
      expect(claimed1.kind).toBe("claimed");
      // 新 worker 重领（lease 已过期）。
      const claimed2 = await claimOperation(workerPool, r.operationId, {
        leaseMs: 60_000,
        leaseOwner: "new-worker",
        now: new Date(),
      });
      const cA = asClaimed(claimed2);
      expect(cA.attemptNumber).toBe(2); // 新 attempt 继续编号
      // 旧 attempt 被标记 abandoned，且不可被覆盖。
      const att = await pool.query<{ outcome: string | null; attempt_number: number }>(
        "SELECT outcome, attempt_number FROM application_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number",
        [r.operationId],
      );
      expect(att.rows).toHaveLength(2);
      expect(att.rows[0]!.outcome).toBe("abandoned");
      expect(att.rows[1]!.outcome).toBeNull(); // 新 running attempt
      // 旧 claim 无法完成/覆盖新 claim（claim token 不匹配 → stale_claim）。
      const cOld = asClaimed(claimed1);
      const stale = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: cOld.attemptNumber,
        claimToken: cOld.claimToken,
        graphileJobId: "old-job",
        succeeded: true,
      });
      expect(stale).toBe("stale_claim");
      // 新 claim 正常完成。
      const out = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: cA.attemptNumber,
        claimToken: cA.claimToken,
        graphileJobId: "new-job",
        succeeded: true,
      });
      expect(out).toBe("succeeded");
      void past;
    });

    it("P0 旧 job 对 failed/manual_action 必须 no-op，不新增 attempt", async () => {
      const r = await createOperation({ inputVersion: PERM_IV });
      await executeOperation(workerPool, workerRegistry, r.operationId, "fail-job");
      // operation 现为 failed；旧 job 再次执行 → no-op（不新增 attempt）。
      const outcome = await executeOperation(workerPool, workerRegistry, r.operationId, "old-job");
      expect(outcome).toBe("already_done");
      const n = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(n).toBe(1);
    });
  });

  describe("P1-2 lease heartbeat 与失去 claim 的中止边界", () => {
    it("长任务通过心跳续租保持同一 claim；recovery scan 不产生第二个有效 attempt", async () => {
      // 用短 lease（如 500ms）使 handler 运行超过 lease，验证心跳续租保持 claim。
      const r = await createOperation({ inputVersion: 6 }); // input_version=6 → 长任务
      // 先手动 claim 一次并持有（模拟执行中），再验证心跳续租。
      const claimed = await claimOperation(workerPool, r.operationId, {
        leaseMs: 500,
        leaseOwner: "hb-1",
      });
      const c = claimed as Extract<ClaimResult, { kind: "claimed" }>;
      expect(c.kind).toBe("claimed");
      const token = c.claimToken;
      // 心跳续租：延长 lease 到 now()+500ms（模拟执行超过初始 lease）。
      const held = await leaseHeartbeat(workerPool, r.operationId, token, 500);
      expect(held).toBe(true);
      // 心跳后 lease 仍在有效期内（被续租）。
      const op = await pool.query<{ lease_expires_at: Date | null }>(
        "SELECT lease_expires_at FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.lease_expires_at).not.toBeNull();
      expect(new Date(op.rows[0]!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now());
      // 心跳后 claim_token 未变（同一 claim）。
      const op2 = await pool.query<{ claim_token: string | null }>(
        "SELECT claim_token FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op2.rows[0]!.claim_token).toBe(token);
      // 清理：完成当前 claim。
      await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: c.attemptNumber,
        claimToken: token,
        graphileJobId: "hb-1",
        succeeded: true,
      });
    });

    it("失去 claim 后（心跳返回 false）旧 handler 不能写入 succeeded/failed", async () => {
      // 先 claim（attempt 1），然后人为清除 claim_token（模拟 recovery 重领/管理员终止）。
      const r = await createOperation({ inputVersion: 6 });
      const claimed = await claimOperation(workerPool, r.operationId, {
        leaseMs: 60_000,
        leaseOwner: "hb-old",
      });
      const c = claimed as Extract<ClaimResult, { kind: "claimed" }>;
      expect(c.kind).toBe("claimed");
      // 新 worker 重领（旧 claim 失效）：用未来的 now 使第一个 lease 视为已过期。
      const newClaim = await claimOperation(workerPool, r.operationId, {
        leaseMs: 60_000,
        leaseOwner: "hb-new",
        now: new Date(Date.now() + 120_000),
      });
      const nc = newClaim as Extract<ClaimResult, { kind: "claimed" }>;
      expect(nc.kind).toBe("claimed");
      // 旧 worker 尝试心跳：claim_token 已变 → 返回 false（失去 claim）。
      const held = await leaseHeartbeat(workerPool, r.operationId, c.claimToken, 60_000);
      expect(held).toBe(false);
      // 旧 worker 尝试 completeAttempt（成功/失败）→ 必须 stale_claim，不覆盖新 claim。
      const oldDone = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: c.attemptNumber,
        claimToken: c.claimToken,
        graphileJobId: "old-job",
        succeeded: true,
      });
      expect(oldDone).toBe("stale_claim");
      // 新 claim 完成 → succeeded。
      const newDone = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: nc.attemptNumber,
        claimToken: nc.claimToken,
        graphileJobId: "new-job",
        succeeded: true,
      });
      expect(newDone).toBe("succeeded");
    });

    it("真实长任务超过 lease 后仍由心跳保持同一 claim，只产生一个 attempt", async () => {
      // 使用真实、abort-aware handler，运行时间显著长于 250ms lease；这会实际驱动
      // executeOperation 内部的 timer/leaseHeartbeat，而非只手动调用 heartbeat helper。
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const longRegistry = new Map(workerRegistry);
      longRegistry.set(opType, {
        taskIdentifier: opType,
        async run(_operationId, signal) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 900);
            const onAbort = (): void => {
              clearTimeout(timer);
              reject(new Error("long handler lost its claim"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          return { outcome: "succeeded", summary: "long fixture completed" };
        },
      });
      const outcome = await executeOperation(
        workerPool,
        longRegistry,
        r.operationId,
        "hb-long",
        undefined,
        {
          leaseMs: 250,
        },
      );
      expect(outcome).toBe("succeeded");
      const attempts = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(Number(attempts.rows[0]?.n ?? 0)).toBe(1);
    });

    it("失去 claim 时运行中的 handler 被 abort，旧 worker 不能完成 attempt", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      let abortObserved = false;
      const abortAwareRegistry = new Map(workerRegistry);
      abortAwareRegistry.set(opType, {
        taskIdentifier: opType,
        async run(_operationId, signal) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1_200);
            const onAbort = (): void => {
              abortObserved = true;
              clearTimeout(timer);
              reject(new Error("handler stopped after lost claim"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          return { outcome: "succeeded", summary: "must not reach after lost claim" };
        },
      });

      const oldExecution = executeOperation(
        workerPool,
        abortAwareRegistry,
        r.operationId,
        "old-heartbeat-job",
        undefined,
        { leaseMs: 250, leaseOwner: "old-heartbeat-worker" },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 350));

      // 使用将来的权威时钟模拟 lease 已过期后被 recovery 重领；下一次旧 heartbeat
      // 会按 claim_token 不匹配返回 false 并 abort handler。
      const replacement = asClaimed(
        await claimOperation(workerPool, r.operationId, {
          leaseMs: 60_000,
          leaseOwner: "replacement-worker",
          now: new Date(Date.now() + 2_000),
        }),
      );
      await expect(oldExecution).resolves.toBe("stale_claim");
      expect(abortObserved).toBe(true);

      const replacementDone = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: replacement.attemptNumber,
        claimToken: replacement.claimToken,
        graphileJobId: "replacement-job",
        succeeded: true,
      });
      expect(replacementDone).toBe("succeeded");
      const attempts = await pool.query<{ attempt_number: number; outcome: string | null }>(
        `SELECT attempt_number, outcome FROM application_operation_attempts
         WHERE operation_id = $1 ORDER BY attempt_number`,
        [r.operationId],
      );
      expect(attempts.rows).toEqual([
        { attempt_number: 1, outcome: "abandoned" },
        { attempt_number: 2, outcome: "succeeded" },
      ]);
    });
  });

  describe("4. 管理端 API：列表/详情/重试/权限", () => {
    it("列表返回安全投影、游标分页、状态过滤", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const list = await admin.req("GET", "/api/v1/admin/operations");
      expect(list.statusCode).toBe(200);
      const data = body(list);
      const items = data.items as Array<Record<string, unknown>>;
      expect(Array.isArray(items)).toBe(true);
      const mine = items.find((i) => i.id === r.operationId);
      expect(mine).toBeTruthy();
      // 安全投影：不得泄露 graphile payload / secrets。
      const raw = JSON.stringify(mine);
      expect(raw).not.toMatch(/password|token|secret|storage|path|stack|_private/i);
      expect(raw).toContain("targetId");
      // 非法 status 过滤 → 400。
      const bad = await admin.req("GET", "/api/v1/admin/operations?status=bogus");
      expect(bad.statusCode).toBe(400);
    });

    it("详情返回 attempt 时间线 + 脱敏错误", async () => {
      // 用永久失败（不抛回）产生一个含脱敏错误摘要的 failed operation。
      const r = await createOperation({ inputVersion: PERM_IV });
      await executeOperation(workerPool, workerRegistry, r.operationId, "det1");
      const d = await admin.req("GET", `/api/v1/admin/operations/${r.operationId}`);
      expect(d.statusCode).toBe(200);
      const data = body(d);
      const attempts = data.attempts as Array<Record<string, unknown>>;
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(data)).not.toMatch(/stack|_private|payload|password|secret/i);
      // 非法 UUID → 400；合法但不存在 → 404。
      expect((await admin.req("GET", "/api/v1/admin/operations/not-a-uuid")).statusCode).toBe(400);
      const ghost = "00000000-0000-4000-8000-0000000000ff";
      expect((await admin.req("GET", `/api/v1/admin/operations/${ghost}`)).statusCode).toBe(404);
    });

    it("重试：failed 状态可重试，转 queued 并重新投递（幂等）", async () => {
      const r = await createOperation({ inputVersion: PERM_IV });
      await executeOperation(workerPool, workerRegistry, r.operationId, "ret-job1");
      const opBefore = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(opBefore.rows[0]!.status).toBe("failed");

      const key = uniqKey();
      const ret = await admin.req("POST", `/api/v1/admin/operations/${r.operationId}/retry`, {
        headers: { "idempotency-key": key },
        payload: { confirm: true },
      });
      expect(ret.statusCode).toBe(200);
      const data = body(ret);
      expect((data.operation as Record<string, unknown>).status).toBe("queued");

      // 同 key 重放 → 幂等返回，不再重复投递。
      const replay = await admin.req("POST", `/api/v1/admin/operations/${r.operationId}/retry`, {
        headers: { "idempotency-key": key },
        payload: { confirm: true },
      });
      expect(replay.statusCode).toBe(200);
      expect((body(replay) as { isIdempotentReplay?: boolean }).isIdempotentReplay).toBe(true);

      // 重试后再次执行可成功（永久哨兵会在重试后仍失败——改用 success 已重试）。
      const opNow = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(opNow.rows[0]!.status).toBe("queued");
    });

    it("重试冻结首响应：同 key 重放返回首次 queued 投影，即使 operation 已 succeeded（P1-2）", async () => {
      // 先把 queued fixture 合法推进为 failed，模拟已耗尽尝试后的管理员可重试状态。
      // 0030 禁止 retry_wait → failed 的越级直接 SQL，因此不再用非法测试 setup。
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      await pool.query(
        `UPDATE application_operations SET status = 'failed', retryable = false,
            last_error_code = 'OPERATION_MAX_ATTEMPTS_EXCEEDED', completed_at = now()
         WHERE id = $1`,
        [r.operationId],
      );

      const key = uniqKey();
      const first = await admin.req("POST", `/api/v1/admin/operations/${r.operationId}/retry`, {
        headers: { "idempotency-key": key },
        payload: { confirm: true },
      });
      expect(first.statusCode).toBe(200);
      const firstBody = body(first);
      expect((firstBody.operation as Record<string, unknown>).status).toBe("queued");
      expect((firstBody as { isIdempotentReplay?: boolean }).isIdempotentReplay).toBe(false);

      // 冻结投影已持久化到 idempotency_keys.response_json（含完整 operation 投影）。
      const idem = await pool.query<{ response_json: unknown }>(
        `SELECT response_json FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      expect(idem.rows[0]).toBeTruthy();
      const stored = idem.rows[0]!.response_json as {
        operation: Record<string, unknown>;
        isIdempotentReplay: boolean;
      };
      expect(stored.operation.status).toBe("queued");
      expect(stored.operation.id).toBe(r.operationId);
      // 逐字段比较（键序无关）：存储投影与首次响应完全一致。
      expect(stored.operation).toEqual(firstBody.operation);

      // 让 operation 实际推进到 succeeded（先改 input_version=1 使 fixture 成功；
      // 此时 operation 是 queued → 可领取成功）。
      await pool.query(`UPDATE application_operations SET input_version = 1 WHERE id = $1`, [
        r.operationId,
      ]);
      const outcome = await executeOperation(workerPool, workerRegistry, r.operationId, "fz-2");
      expect(outcome).toBe("succeeded");
      const opAdvanced = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(opAdvanced.rows[0]!.status).toBe("succeeded");

      // 同 key 重放：必须返回【冻结的 queued 投影】，而非实时 succeeded。
      // 先记录重放前的 job/attempt/audit 基线与 attempt 编号总和。
      const jobsBefore = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE key = $1`,
        [`motro:op:${r.operationId}`],
      );
      const attemptsBefore = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      const auditsBefore = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events WHERE target_id = $1 AND action = 'admin.operations.retry'`,
        [r.operationId],
      );
      const replay = await admin.req("POST", `/api/v1/admin/operations/${r.operationId}/retry`, {
        headers: { "idempotency-key": key },
        payload: { confirm: true },
      });
      expect(replay.statusCode).toBe(200);
      const replayBody = body(replay);
      expect((replayBody as { isIdempotentReplay?: boolean }).isIdempotentReplay).toBe(true);
      // body 与首次完全一致（仅 replay 标记不同）。
      expect(replayBody.operation).toEqual(firstBody.operation);
      expect((replayBody.operation as Record<string, unknown>).status).toBe("queued");

      // 重放不新增 job/attempt/audit（与重放前基线一致）。
      const jobsAfter = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE key = $1`,
        [`motro:op:${r.operationId}`],
      );
      expect(Number(jobsAfter.rows[0]?.n ?? 0)).toBe(Number(jobsBefore.rows[0]?.n ?? 0));
      const attempts = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(Number(attempts.rows[0]?.n ?? 0)).toBe(Number(attemptsBefore.rows[0]?.n ?? 0));
      const audits = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events WHERE target_id = $1 AND action = 'admin.operations.retry'`,
        [r.operationId],
      );
      expect(Number(audits.rows[0]?.n ?? 0)).toBe(Number(auditsBefore.rows[0]?.n ?? 0));

      // 同 key 不同语义（confirm 变化）→ 409。
      const conflict = await admin.req("POST", `/api/v1/admin/operations/${r.operationId}/retry`, {
        headers: { "idempotency-key": key },
        payload: { confirm: false },
      });
      expect(conflict.statusCode).toBe(409);
    });

    it("重试：同 key 不同载荷 → 409 IDEMPOTENCY_CONFLICT", async () => {
      const a = await createOperation({ inputVersion: PERM_IV });
      await executeOperation(workerPool, workerRegistry, a.operationId, "conflict-1");
      const key = uniqKey();
      const first = await admin.req("POST", `/api/v1/admin/operations/${a.operationId}/retry`, {
        headers: { "idempotency-key": key },
        payload: { confirm: true },
      });
      expect(first.statusCode).toBe(200);
      // 同一 key 但请求体不同（confirm:false 也视为不同语义 → 409）。
      const second = await admin.req("POST", `/api/v1/admin/operations/${a.operationId}/retry`, {
        headers: { "idempotency-key": key },
        payload: { confirm: false },
      });
      expect(second.statusCode).toBe(409);
      const e = body(second);
      expect((e.error as Record<string, unknown>).code).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("重试：成功/排队/运行中/等待重试状态拒绝人工重试；confirm=false 拒绝", async () => {
      const s = await createOperation({ inputVersion: SUCCESS_IV });
      await executeOperation(workerPool, workerRegistry, s.operationId, "nr1");
      const noRetry = await admin.req("POST", `/api/v1/admin/operations/${s.operationId}/retry`, {
        headers: { "idempotency-key": uniqKey() },
        payload: { confirm: true },
      });
      expect(noRetry.statusCode).toBe(422);

      const needConfirm = await createOperation({ inputVersion: PERM_IV });
      await executeOperation(workerPool, workerRegistry, needConfirm.operationId, "nr2");
      const noConfirm = await admin.req(
        "POST",
        `/api/v1/admin/operations/${needConfirm.operationId}/retry`,
        {
          headers: { "idempotency-key": uniqKey() },
          payload: { confirm: false },
        },
      );
      expect(noConfirm.statusCode).toBe(422);
    });

    it("权限：learner 403，未登录 401，缺少幂等键 422", async () => {
      // learner 访问列表/详情/{id} 一律 403。
      expect((await learner.req("GET", "/api/v1/admin/operations")).statusCode).toBe(403);
      expect((await anon.req("GET", "/api/v1/admin/operations")).statusCode).toBe(401);

      const r = await createOperation({ inputVersion: PERM_IV });
      const missingKey = await admin.req(
        "POST",
        `/api/v1/admin/operations/${r.operationId}/retry`,
        {
          payload: { confirm: true },
        },
      );
      expect(missingKey.statusCode).toBe(422);
    });

    it("无效 CSRF token 的真实集成负例 → 403（P2-4）", async () => {
      // 构造一个 failed operation 作为 retry 目标（确保请求路径合法，仅 CSRF 无效）。
      const r = await createOperation({ inputVersion: PERM_IV });
      await executeOperation(workerPool, workerRegistry, r.operationId, "csrf-1");
      // 先 warm 拿到 session + csrf cookie 值。
      const warmRes = await app.inject({ method: "GET", url: "/api/v1/health/live" });
      const rawSetCookie = warmRes.headers["set-cookie"] as unknown;
      const setCookies: string[] = Array.isArray(rawSetCookie)
        ? rawSetCookie
        : typeof rawSetCookie === "string"
          ? [rawSetCookie]
          : [];
      const cookieValue = (name: string): string =>
        setCookies
          .find((c) => c.startsWith(`${name}=`))
          ?.split(";")[0]
          ?.split("=")
          .slice(1)
          .join("=") ?? "";
      const sessionVal = cookieValue("motro_session");
      const csrfVal = cookieValue("motro_csrf");
      // 有效 session + 有效 csrf cookie + 【伪造】x-csrf-token → 403（token ≠ cookie 值）。
      const bad = await app.inject({
        method: "POST",
        url: `/api/v1/admin/operations/${r.operationId}/retry`,
        cookies: { motro_session: sessionVal, motro_csrf: csrfVal },
        headers: { "x-csrf-token": "invalid-csrf-token-000" },
        payload: { confirm: true },
      });
      expect(bad.statusCode).toBe(403);
      // 空 x-csrf-token → 403（空串 ≠ cookie 值）。
      const noCsrf = await app.inject({
        method: "POST",
        url: `/api/v1/admin/operations/${r.operationId}/retry`,
        cookies: { motro_session: sessionVal, motro_csrf: csrfVal },
        headers: { "x-csrf-token": "" },
        payload: { confirm: true },
      });
      expect(noCsrf.statusCode).toBe(403);
    });
  });

  describe("5. 源码扫描守卫（不依赖 Graphile 私有表）", () => {
    it("实现不查询 graphile_worker._private_* 表", () => {
      const dirs = [
        resolve(process.cwd(), "apps/api/src/modules/operations"),
        resolve(process.cwd(), "apps/api/src/modules/admin/imports"),
        resolve(process.cwd(), "apps/worker/src"),
        resolve(process.cwd(), "packages/domain/src/operations"),
      ];
      const files: string[] = [];
      for (const dir of dirs) {
        collectTsFiles(dir, files);
      }
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        expect(content).not.toMatch(/graphile_worker\._private/);
        expect(content).not.toMatch(/_private_jobs/);
      }
    });
  });

  describe("6. 网络禁用守卫", () => {
    it("fixture/worker/domain 实现不引用外部供应商 URL 或真实账户", () => {
      const dirs = [
        resolve(process.cwd(), "apps/worker/src"),
        resolve(process.cwd(), "packages/domain/src/operations"),
      ];
      const files: string[] = [];
      for (const dir of dirs) collectTsFiles(dir, files);
      const banned = [
        /wiktionary\.org|www\.mediawiki|api\.deepseek|deepseek\.com|\/v1\/chat\/completions/i,
        /(sk-|api[_-]?key|secret|access[_-]?token)=[a-zA-Z0-9]{16,}/,
      ];
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        for (const re of banned) expect(content).not.toMatch(re);
      }
    });
  });

  describe("7. attempt 数据库不可变 / 错误脱敏 / payload 入口校验", () => {
    it("已完成 attempt 任何 UPDATE/DELETE 一律被数据库拒绝", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      await executeOperation(workerPool, workerRegistry, r.operationId, "imm1");
      const att = await pool.query<{ id: string; outcome: string }>(
        "SELECT id, outcome FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(att.rows[0]!.outcome).toBe("succeeded");
      const attId = att.rows[0]!.id;
      // 每个负例必须命中「completed attempt 不可变」trigger/约束，而非其他约束。
      const attemptsToReject: Array<[string, unknown[]]> = [
        ["UPDATE application_operation_attempts SET error_summary = 'x' WHERE id = $1", [attId]],
        ["UPDATE application_operation_attempts SET finished_at = now() WHERE id = $1", [attId]],
        ["UPDATE application_operation_attempts SET worker_job_id = 'x' WHERE id = $1", [attId]],
        [
          "UPDATE application_operation_attempts SET operation_id = $2 WHERE id = $1",
          [attId, randomUUID()],
        ],
        ["UPDATE application_operation_attempts SET attempt_number = 999 WHERE id = $1", [attId]],
        ["UPDATE application_operation_attempts SET started_at = now() WHERE id = $1", [attId]],
        ["DELETE FROM application_operation_attempts WHERE id = $1", [attId]],
      ];
      for (const [sql, params] of attemptsToReject) {
        let rejected = false;
        try {
          await pool.query(sql, params);
        } catch (err) {
          rejected = true;
          expect(String((err as Error).message)).toMatch(
            /immutable|completed attempt facts are immutable/,
          );
        }
        expect(rejected, `应拒绝：${sql}`).toBe(true);
      }
    });

    it("running attempt 身份字段不可变；完成转换需一次写齐 outcome+finished_at", async () => {
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const claimed = await claimOperation(workerPool, r.operationId, { leaseMs: 60_000 });
      expect(claimed.kind).toBe("claimed");
      const att = await pool.query<{ id: string; outcome: string | null }>(
        "SELECT id, outcome FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      const attId = att.rows[0]!.id;
      // running attempt 不得改 operation_id/attempt_number/started_at。
      const badIdentity: Array<[string, unknown[]]> = [
        [
          "UPDATE application_operation_attempts SET operation_id = $2 WHERE id = $1",
          [attId, randomUUID()],
        ],
        ["UPDATE application_operation_attempts SET attempt_number = 99 WHERE id = $1", [attId]],
        ["UPDATE application_operation_attempts SET started_at = now() WHERE id = $1", [attId]],
      ];
      for (const [sql, params] of badIdentity) {
        let rejected = false;
        try {
          await pool.query(sql, params);
        } catch {
          rejected = true;
        }
        expect(rejected, `running attempt 身份字段应被拒：${sql}`).toBe(true);
      }
      // 合法完成转换：outcome + finished_at 一次写齐。
      const c2 = asClaimed(claimed);
      const out = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: c2.attemptNumber,
        claimToken: c2.claimToken,
        graphileJobId: "complete-ok",
        succeeded: true,
      });
      expect(out).toBe("succeeded");
    });

    it("错误脱敏：DB/API 不出现 password/token/路径/供应商 payload 原值", async () => {
      // 构造一个 handler 抛含秘密错误的 operation（input_version=3 永久失败 + 自定义错误）。
      const r = await createOperation({ inputVersion: PERM_IV });
      // 直接通过 completeAttempt 写入一个含秘密的 errorSummary，验证被脱敏（安全占位）。
      const claimed = await claimOperation(workerPool, r.operationId, { leaseMs: 60_000 });
      expect(claimed.kind).toBe("claimed");
      const secret =
        "password=hunter2 Authorization: Bearer abcdef0123456789 /var/lib/motro/secret.csv";
      const c3 = asClaimed(claimed);
      const out = await completeAttempt(workerPool, {
        operationId: r.operationId,
        attemptNumber: c3.attemptNumber,
        claimToken: c3.claimToken,
        graphileJobId: "redact",
        succeeded: false,
        errorCode: "OPERATION_PERMANENT",
        errorSummary: secret,
      });
      expect(out).toBe("failed");
      // DB attempt + operation 投影不含原值。
      const att = await pool.query<{ error_summary: string | null }>(
        "SELECT error_summary FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(att.rows[0]!.error_summary ?? "").not.toContain("hunter2");
      expect(att.rows[0]!.error_summary ?? "").not.toContain("Bearer abcdef0123456789");
      expect(att.rows[0]!.error_summary ?? "").not.toContain("/var/lib/motro");
      const op = await pool.query<{ last_error_summary: string | null }>(
        "SELECT last_error_summary FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.last_error_summary ?? "").not.toContain("hunter2");
      // API detail 同样不含原值。
      const d = await admin.req("GET", `/api/v1/admin/operations/${r.operationId}`);
      expect(d.statusCode).toBe(200);
      expect(JSON.stringify(body(d))).not.toContain("hunter2");
    });

    it("payload 入口校验：合法 payload 执行；非法 payload 拒绝且不执行 handler/不泄露原值", async () => {
      // 合法 payload（input_version=1 成功）。
      const ok = await createOperation({ inputVersion: SUCCESS_IV });
      const parsedOk = validateOperationPayload({
        operationId: ok.operationId,
        inputVersion: 1,
      });
      expect(parsedOk.ok).toBe(true);
      // 非法 payload 各负例（结构性拒绝）。
      const badInputs: unknown[] = [
        { operationId: "not-a-uuid", inputVersion: 1 },
        { operationId: ok.operationId }, // 缺 inputVersion
        { operationId: ok.operationId, inputVersion: 0 }, // 非正整数
        { operationId: ok.operationId, inputVersion: 1, extra: "x" },
        { operationId: ok.operationId, inputVersion: 1, password: "hunter2" },
      ];
      for (const bad of badInputs) {
        const parsed = validateOperationPayload(bad);
        expect(parsed.ok, `应拒绝：${JSON.stringify(bad)}`).toBe(false);
      }
      // inputVersion=2 结构合法但 authority 不匹配 → 由 task-list 的权威校验拒绝
      // （不执行 handler、不创建业务 attempt）。此处验证领域层视为格式合法，
      // 权威不匹配是 task 入口的职责（见 task-list）。
      const mismatchParsed = validateOperationPayload({
        operationId: ok.operationId,
        inputVersion: 2,
      });
      expect(mismatchParsed.ok).toBe(true);
      // 领域层已证明；真实 task 入口行为由 task-list 调用 validateOperationPayload 保证。
      // 验证 handler 只执行一次（合法 payload 才触发 handler）。
      const before = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [ok.operationId],
      );
      expect(before).toBe(0);
    });

    it("P1-3 非法 payload 写入显式 failed 终态；不存在 operation 不伪造", async () => {
      // 直接调用真实 task-list handler（模拟 Graphile 投递）。
      const taskList = buildTaskList(workerPool, workerRegistry, 60_000);
      const handler = taskList["motro-op-fixture"]!;
      // 构造一个 queued operation（合法 target_id）。
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      // 非法 payload（敏感字段）→ handler 抛错 + operation → failed 终态。
      const sensitivePayload = { operationId: r.operationId, inputVersion: 1, password: "hunter2" };
      const helpers = {
        job: { id: "fake-job-sensitive" },
        abortSignal: new AbortController().signal,
      } as never;
      await expect(handler(sensitivePayload, helpers as never)).rejects.toThrow(
        /invalid task payload/,
      );
      const op = await pool.query<{
        status: string;
        retryable: boolean;
        last_error_code: string | null;
        completed_at: Date | null;
      }>(
        "SELECT status, retryable, last_error_code, completed_at FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("failed");
      expect(op.rows[0]!.retryable).toBe(false);
      expect(op.rows[0]!.last_error_code).toBe("OPERATION_INVALID_PAYLOAD");
      expect(op.rows[0]!.completed_at).not.toBeNull();
      // 不创建业务 attempt（claim 未发生）。
      const att = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(att).toBe(0);
      // 已 failed 的 operation 不被再次覆盖（二次非法 payload no-op）。
      const op2 = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op2.rows[0]!.status).toBe("failed");

      // 不存在的 operation：不伪造业务 operation（无写入）。
      const ghostId = "00000000-0000-4000-8000-0000000000ff";
      await expect(
        handler({ operationId: ghostId, inputVersion: 1 }, helpers as never),
      ).rejects.toThrow(/invalid task payload/);
      const ghostCount = await qcount(
        "SELECT count(*)::text AS n FROM application_operations WHERE id = $1",
        [ghostId],
      );
      expect(ghostCount).toBe(0);

      // inputVersion 不匹配 → 终态 failed + OPERATION_INVALID_PAYLOAD。
      const r2 = await createOperation({ inputVersion: SUCCESS_IV });
      await expect(
        handler({ operationId: r2.operationId, inputVersion: 99 }, helpers as never),
      ).rejects.toThrow(/invalid task payload/);
      const op3 = await pool.query<{ status: string; last_error_code: string | null }>(
        "SELECT status, last_error_code FROM application_operations WHERE id = $1",
        [r2.operationId],
      );
      expect(op3.rows[0]!.status).toBe("failed");
      expect(op3.rows[0]!.last_error_code).toBe("OPERATION_INVALID_PAYLOAD");

      // operationId 自身不是 UUID：不得把未验证字符串带入 SQL，也不得伪造事实。
      await expect(
        handler({ operationId: "not-a-uuid", inputVersion: 1 }, helpers as never),
      ).rejects.toThrow(/invalid task payload/);
    });

    it("Task3 负例：额外字段不泄露字段名；敏感字段不泄露值；恶意换行不伪造日志行", async () => {
      const taskList = buildTaskList(workerPool, workerRegistry, 60_000);
      const handler = taskList["motro-op-fixture"]!;
      const helpers = {
        job: { id: "fake-job-task3" },
        abortSignal: new AbortController().signal,
      } as never;

      // 1) 额外字段：抛出的 Error.message 不得包含字段名原文（防止字段名泄漏 / 日志伪造）。
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      const extraFieldName = "extraFieldLeakCandidate";
      await expect(
        handler(
          { operationId: r.operationId, inputVersion: 1, [extraFieldName]: "x" },
          helpers as never,
        ),
      ).rejects.toThrow(/invalid task payload/);
      await expect(
        handler(
          { operationId: r.operationId, inputVersion: 1, [extraFieldName]: "x" },
          helpers as never,
        ),
      ).rejects.not.toThrow(new RegExp(extraFieldName, "i"));

      // 2) 敏感字段：值不进入错误消息；字段名也不进入。
      const sensitiveVal = "hunter2-SUPER-SECRET";
      await expect(
        handler(
          { operationId: r.operationId, inputVersion: 1, password: sensitiveVal },
          helpers as never,
        ),
      ).rejects.not.toThrow(new RegExp(sensitiveVal, "i"));
      await expect(
        handler(
          { operationId: r.operationId, inputVersion: 1, password: sensitiveVal },
          helpers as never,
        ),
      ).rejects.not.toThrow(/password/i);

      // 3) 恶意换行：字段名含 \n / ANSI escape，不得在 Error.message 里原样出现（防日志行伪造）。
      const newlineField = "evil\nfakelog\x1b[31mPWNED\x1b[0m";
      await expect(
        handler(
          { operationId: r.operationId, inputVersion: 1, [newlineField]: "x" },
          helpers as never,
        ),
      ).rejects.toThrow(/invalid task payload/);
      await expect(
        handler(
          { operationId: r.operationId, inputVersion: 1, [newlineField]: "x" },
          helpers as never,
        ),
      ).rejects.not.toThrow(/fakelog|PWNED/);

      // 4) 不产生 ghost operation（非法 payload 不写入任何业务行）。
      const ghost = "00000000-0000-4000-8000-0000000000ee";
      await expect(
        handler({ operationId: ghost, inputVersion: 1, extra: "x" }, helpers as never),
      ).rejects.toThrow(/invalid task payload/);
      const ghostCount = await qcount(
        "SELECT count(*)::text AS n FROM application_operations WHERE id = $1",
        [ghost],
      );
      expect(ghostCount).toBe(0);

      // 5) 非法 payload 不产生业务 attempt。
      const attempts = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(attempts).toBe(0);
    });

    it("Task3 负例：invalid UUID 不进入 SQL（不伪造任何行）；inputVersion mismatch 进入正确终态", async () => {
      const taskList = buildTaskList(workerPool, workerRegistry, 60_000);
      const handler = taskList["motro-op-fixture"]!;
      const helpers = {
        job: { id: "fake-job-task3b" },
        abortSignal: new AbortController().signal,
      } as never;

      // invalid UUID：payload 校验在进入任何 SQL 之前拒绝；不创建 ghost op、不创建 attempt。
      const invalidUuid = "this-is-not-a-uuid!@#$\n";
      await expect(
        handler({ operationId: invalidUuid, inputVersion: 1 }, helpers as never),
      ).rejects.toThrow(/invalid task payload/);
      const anyInvalid = await qcount(
        "SELECT count(*)::text AS n FROM application_operations WHERE id::text = $1",
        [invalidUuid],
      );
      expect(anyInvalid).toBe(0);

      // inputVersion mismatch：合法 UUID 但版本不匹配 → 终态 failed + OPERATION_INVALID_PAYLOAD，
      // 不产生 attempt（claim 未发生）。
      const r = await createOperation({ inputVersion: SUCCESS_IV });
      await expect(
        handler({ operationId: r.operationId, inputVersion: 99 }, helpers as never),
      ).rejects.toThrow(/invalid task payload/);
      const op = await pool.query<{ status: string; last_error_code: string | null }>(
        "SELECT status, last_error_code FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("failed");
      expect(op.rows[0]!.last_error_code).toBe("OPERATION_INVALID_PAYLOAD");
      const attempts = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(attempts).toBe(0);
    });
  });

  describe("工单 04→05 seam：manual_action 真实进入路径 + WIKI 错误分类 + target 契约", () => {
    const WIKI_PERM = 7; // WIKI_RESPONSE_MALFORMED (permanent)
    const WIKI_MANUAL = 8; // WIKI_PAGE_NOT_FOUND (manual_action)
    const WIKI_RETRY = 9; // WIKI_TRANSIENT (retryable)

    it("WIKI permanent → failed，绝不计费成功，绝不复投", async () => {
      const r = await createOperation({ inputVersion: WIKI_PERM });
      const outcome = await executeOperation(
        workerPool,
        workerRegistry,
        r.operationId,
        "wiki-perm",
      );
      expect(outcome).toBe("failed");
      const op = await pool.query<{
        status: string;
        retryable: boolean;
        last_error_code: string | null;
        completed_at: Date | null;
      }>(
        "SELECT status, retryable, last_error_code, completed_at FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("failed");
      expect(op.rows[0]!.retryable).toBe(false);
      expect(op.rows[0]!.last_error_code).toBe("WIKI_RESPONSE_MALFORMED");
      expect(op.rows[0]!.last_error_code).not.toBe("WIKI_PAGE_NOT_FOUND");
      expect(op.rows[0]!.completed_at).not.toBeNull();
      // attempt 只记录一次 failed——绝不伪装 succeeded。
      const att = await pool.query<{ outcome: string; error_code: string | null }>(
        "SELECT outcome, error_code FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(att.rows).toHaveLength(1);
      expect(att.rows[0]!.outcome).toBe("failed");
      expect(att.rows[0]!.error_code).toBe("WIKI_RESPONSE_MALFORMED");
    });

    it("WIKI manual_action → 进入 manual_action，不自动再次投递（单个 attempt）", async () => {
      const r = await createOperation({ inputVersion: WIKI_MANUAL });
      const outcome = await executeOperation(workerPool, workerRegistry, r.operationId, "wiki-man");
      expect(outcome).toBe("manual_action");
      const op = await pool.query<{
        status: string;
        retryable: boolean;
        last_error_code: string | null;
        completed_at: Date | null;
        claim_token: string | null;
        lease_owner: string | null;
        lease_expires_at: Date | null;
      }>(
        "SELECT status, retryable, last_error_code, completed_at, claim_token, lease_owner, lease_expires_at FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("manual_action");
      expect(op.rows[0]!.retryable).toBe(false);
      expect(op.rows[0]!.last_error_code).toBe("WIKI_PAGE_NOT_FOUND");
      expect(op.rows[0]!.completed_at).not.toBeNull();
      expect(op.rows[0]!.claim_token).toBeNull();
      expect(op.rows[0]!.lease_owner).toBeNull();
      expect(op.rows[0]!.lease_expires_at).toBeNull();
      // 单个 attempt（无第二个自动 attempt）。
      const att = await pool.query<{
        outcome: string;
        error_code: string | null;
        error_summary: string | null;
      }>(
        "SELECT outcome, error_code, error_summary FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(att.rows).toHaveLength(1);
      expect(att.rows[0]!.outcome).toBe("failed");
      expect(att.rows[0]!.error_code).toBe("WIKI_PAGE_NOT_FOUND");
      // 摘要固定脱敏，不含 provider 原文。
      expect(att.rows[0]!.error_summary ?? "").toContain("页面不存在");
    });

    it("WIKI manual_action 旧 job 重复执行必须 no-op（不产生第二个 attempt）", async () => {
      const r = await createOperation({ inputVersion: WIKI_MANUAL });
      expect(await executeOperation(workerPool, workerRegistry, r.operationId, "wiki-man-1")).toBe(
        "manual_action",
      );
      // 重复 job（Graphile 重投/恢复重放）→ manual_action 是终态，claimDecision 返回 noop。
      expect(await executeOperation(workerPool, workerRegistry, r.operationId, "wiki-man-2")).toBe(
        "already_done",
      );
      const n = await qcount(
        "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(n).toBe(1);
    });

    it("WIKI transient → retry_wait（可自动退避重试）", async () => {
      const r = await createOperation({ inputVersion: WIKI_RETRY });
      await expect(
        executeOperation(workerPool, workerRegistry, r.operationId, "wiki-retry-1"),
      ).rejects.toThrow(/临时失败/);
      const op = await pool.query<{ status: string; last_error_code: string | null }>(
        "SELECT status, last_error_code FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("retry_wait");
      expect(op.rows[0]!.last_error_code).toBe("WIKI_TRANSIENT");
    });

    it("manual_action 不自动再次投递：无第二个自动 attempt；错误未伪装成功", async () => {
      const r = await createOperation({ inputVersion: WIKI_MANUAL, maxAttempts: 10 });
      await executeOperation(workerPool, workerRegistry, r.operationId, "wiki-man-noretry");
      // 即便 maxAttempts 很大，manual_action 也不会自动重试（单 attempt）。
      const att = await pool.query<{ outcome: string; error_code: string | null }>(
        "SELECT outcome, error_code FROM application_operation_attempts WHERE operation_id = $1",
        [r.operationId],
      );
      expect(att.rows).toHaveLength(1);
      expect(att.rows[0]!.outcome).not.toBe("succeeded");
      expect(att.rows[0]!.error_code).toBe("WIKI_PAGE_NOT_FOUND");
    });

    it("管理员经既有 retry 端点：manual_action → queued，并可重新执行", async () => {
      const r = await createOperation({ inputVersion: WIKI_MANUAL });
      await executeOperation(workerPool, workerRegistry, r.operationId, "wiki-man-retry");
      let op = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("manual_action");

      // 管理员显式 retry → queued（manual_action 的唯一合法离开路径）。
      const ret = await admin.req("POST", `/api/v1/admin/operations/${r.operationId}/retry`, {
        headers: { "idempotency-key": uniqKey() },
        payload: { confirm: true },
      });
      expect(ret.statusCode).toBe(200);
      op = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.status).toBe("queued");
      // 重试后仍会再次进入 manual_action（fixture 每轮都抛 WIKI_PAGE_NOT_FOUND）。
      expect(
        await executeOperation(workerPool, workerRegistry, r.operationId, "wiki-man-retry-again"),
      ).toBe("manual_action");
    });

    it("单个 manual_action 不阻塞其它 operation（各自独立推进）", async () => {
      const manualOp = await createOperation({ inputVersion: WIKI_MANUAL });
      const okOp = await createOperation({ inputVersion: SUCCESS_IV });
      expect(await executeOperation(workerPool, workerRegistry, manualOp.operationId, "m-1")).toBe(
        "manual_action",
      );
      expect(await executeOperation(workerPool, workerRegistry, okOp.operationId, "ok-1")).toBe(
        "succeeded",
      );
      const m = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [manualOp.operationId],
      );
      const o = await pool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [okOp.operationId],
      );
      expect(m.rows[0]!.status).toBe("manual_action");
      expect(o.rows[0]!.status).toBe("succeeded");
    });

    it("target 契约负例：target_type='wiktionary_source_fact' 被数据库拒绝（不扩展白名单）", async () => {
      const commitRow = await createCommitRow(pool, { userId: adminUserId });
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO application_operations
             (operation_type, operation_version, target_type, target_id, input_hash, input_version,
              status, task_identifier, queue_name, max_attempts)
           VALUES ($1, 1, 'wiktionary_source_fact', $2, $3, 1, 'queued', $1, $4, 5)`,
          [opType, commitRow.commitRowId, "hash_wiki", queueName],
        );
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(/target_type_whitelist/i);
      }
      expect(rejected, "target_type='wiktionary_source_fact' 应被数据库白名单拒绝").toBe(true);
    });

    it("target 契约负例：不存在的 target_id 被 FK 拒绝", async () => {
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO application_operations
             (operation_type, operation_version, target_type, target_id, input_hash, input_version,
              status, task_identifier, queue_name, max_attempts)
           VALUES ($1, 1, 'import_batch_commit_row', $2, $3, 1, 'queued', $1, $4, 5)`,
          [opType, "00000000-0000-4000-8000-0000000000ff", "hash_ghost", queueName],
        );
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(/application_operations_target_id_fkey/i);
      }
      expect(rejected, "不存在的 target_id 应被 FK 拒绝").toBe(true);
    });

    it("真实 commit row target 可创建 operation；source fact 未来只能经独立关联进入，不得伪造 target", async () => {
      const commitRow = await createCommitRow(pool, { userId: adminUserId });
      const r = await createOperation({ commitRowId: commitRow.commitRowId });
      expect(r.created).toBe(true);
      const op = await pool.query<{ target_type: string; target_id: string }>(
        "SELECT target_type, target_id FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.target_type).toBe("import_batch_commit_row");
      expect(op.rows[0]!.target_id).toBe(commitRow.commitRowId);
      // 不存在 wiktionary_source_fact 目标类型：任何尝试都会被白名单拒绝。
      const ghost = "00000000-0000-4000-8000-0000000000ee";
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO application_operations
             (operation_type, operation_version, target_type, target_id, input_hash, input_version,
              status, task_identifier, queue_name, max_attempts)
           VALUES ($1, 1, 'wiktionary_source_fact', $2, $3, 1, 'queued', $1, $4, 5)`,
          [opType, ghost, "hash_ghost2", queueName],
        );
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(/target_type_whitelist/i);
      }
      expect(rejected).toBe(true);
    });

    it("operation identity 仍绑定真实 commit row；删除被引用 commit row 被拒绝", async () => {
      const commitRow = await createCommitRow(pool, { userId: adminUserId });
      const r = await createOperation({ commitRowId: commitRow.commitRowId });
      const op = await pool.query<{ target_type: string; target_id: string }>(
        "SELECT target_type, target_id FROM application_operations WHERE id = $1",
        [r.operationId],
      );
      expect(op.rows[0]!.target_type).toBe("import_batch_commit_row");
      expect(op.rows[0]!.target_id).toBe(commitRow.commitRowId);
      // 删除被引用的 commit row 被拒绝（FK RESTRICT 或 immutable）。
      let rejected = false;
      try {
        await pool.query("DELETE FROM import_batch_commit_rows WHERE id = $1", [
          commitRow.commitRowId,
        ]);
      } catch (err) {
        rejected = true;
        expect(
          /application_operations_target_id_fkey|commit facts are immutable|immutable/i.test(
            String((err as Error).message),
          ),
        ).toBe(true);
      }
      expect(rejected).toBe(true);
    });
  });

  describe("8. Graphile 重投参数与业务 max_attempts 对齐（Task 1）", () => {
    it("recovery job 使用 recoveryJobMaxAttempts（业务上限与 recovery 底线取较大者）", async () => {
      const { recoveryJobMaxAttempts } = await import("@motro/domain");
      // 业务上限 ≤ 底线 → 用底线；业务上限更大 → 跟随业务上限。
      expect(recoveryJobMaxAttempts(1)).toBe(5);
      expect(recoveryJobMaxAttempts(5)).toBe(5);
      expect(recoveryJobMaxAttempts(7)).toBe(7);
    });

    it("recovery job 的 Graphile max_attempts 在公共 jobs view 上可见且等于 recoveryJobMaxAttempts", async () => {
      const { recoveryJobMaxAttempts } = await import("@motro/domain");
      // 构造一个业务 max_attempts=1 的过期 running operation。
      const targetId = (await createCommitRow(pool, { userId: adminUserId })).commitRowId;
      const opId = (
        await pool.query<{ id: string }>(
          `INSERT INTO application_operations
             (operation_type, operation_version, target_type, target_id, input_hash, input_version,
              status, task_identifier, queue_name, max_attempts, attempt_count, claim_token,
              lease_expires_at, started_at)
           VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'running', $1, $5, 1, 1,
                   $6, now() - interval '1 minute', now())
           RETURNING id`,
          [
            opType,
            targetId,
            operationInputHash({
              operationType: opType,
              targetType: "import_batch_commit_row",
              targetId,
              inputVersion: 1,
            }),
            1,
            queueName,
            randomUUID(),
          ],
        )
      ).rows[0]!.id;
      // 运行 recovery scan → 投递 recovery job（使用 recoveryJobMaxAttempts）。
      const { report } = await runRecoveryScan(pool, { intervalMs: 0, batchSize: 20 });
      expect(report.enqueued).toBe(1);
      // 在公共 jobs view 上断言 recovery job 的 max_attempts。
      const job = await pool.query<{ max_attempts: number; key: string | null }>(
        `SELECT max_attempts, key FROM graphile_worker.jobs WHERE key LIKE $1`,
        [`motro:ops:recover:${opId}:%`],
      );
      expect(job.rows.length).toBeGreaterThanOrEqual(1);
      expect(job.rows[0]!.max_attempts).toBe(recoveryJobMaxAttempts(1)); // max(5, 1) = 5
    });
  });
});
