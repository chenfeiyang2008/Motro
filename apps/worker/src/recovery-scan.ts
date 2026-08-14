// 阶段 6 工单 04 关键修复：lease-expiry 受控恢复扫描（recovery loop）。
//
// 问题：原 Graphile job 被消费/删除后，若 worker 在 handler 中途被杀死，operation 会
// 停留在 running 并持有一个 lease；原 job 已被消费，不会再有新的 Graphile job 重新领取，
// operation 永久卡在 running。启动时扫描一次不足以覆盖 worker 运行期间的 lease 到期，
// 因此必须有受控的周期性 recovery loop。
//
// 本模块实现：
//   - worker 启动后立即执行一次扫描，此后按配置间隔周期性执行；
//   - 只使用 Graphile 官方公共 API（graphile_worker.add_job），绝不查询/依赖
//     _private_* 表、函数或 API；
//   - 单次扫描在【一个事务】内：BEGIN → SELECT 候选（FOR UPDATE SKIP LOCKED，行锁在
//     整个扫描期间持有，并发扫描 SKIP LOCKED 跳过这些行 → 只有一份扫描能拿到候选）→
//     对每个候选【SAVEPOINT 短事务】内：锁定行 → 重读权威状态/lease → 确认仍是
//     running + expired → 计算稳定 recovery job identity → 调 add_job → 检查结果 →
//     RELEASE SAVEPOINT。失败则 ROLLBACK TO SAVEPOINT，绝不留"已恢复"虚假事实；
//   - job identity = recoveryJobKey(operationId, claimToken)。一次扫描内同一 jobKey 只会
//     被处理一次（行锁）；并发扫描之间的重复 add_job 由 Graphile 的 jobKey 唯一 +
//     preserve_run_at 语义融合为单份 job，且不会被每轮扫描重置到“现在”而饿死（最终
//     防线）。Graphile 在 job 成功后删除该 jobKey，因此恢复
//     成功后的再次合法恢复（新 epoch）不会与原 jobKey 永久冲突；
//   - 单次扫描有明确批量上限、稳定排序、只投影必要字段，绝不读取 provider payload、
//     prompt、secret 或路径；
//   - scan 自身失败（DB 连接、add_job、行/事务错误）不杀死 worker 主循环：记录脱敏
//     错误并在下一周期重试；
//   - 可关闭：stop() 清理 timer；SIGINT/SIGTERM 时不继续发起 recovery enqueue。
import type { Pool, PoolClient } from "pg";
import {
  recoveryCandidateWhere,
  recoveryJobKey,
  recoveryJobMaxAttempts,
  safeErrorSummary,
} from "@motro/domain";
import type { AppConfig, WorkerRecoveryConfig } from "@motro/config";

/** add_job 的最小参数。 */
export interface AddOperationJobSpec {
  taskIdentifier: string;
  queueName: string;
  operationId: string;
  inputVersion: number;
  maxAttempts: number;
  jobKey: string;
}

/**
 * 恢复任务必须避开原业务队列。Graphile 对同一 queue_name 串行化：硬崩溃留下的原 job
 * 仍被锁定时，若 recovery job 复用原队列，它会永远排在那把陈旧队列锁后面。固定、低基数
 * 的专用恢复队列使其能唤醒 lease-based claim；claim token 仍是业务层最终并发防线。
 */
export const RECOVERY_QUEUE_NAME = "motro_recovery";

/**
 * 事务内 add_job 的注入点（便于测试替换为 fake）：在传入的【事务连接】上调用
 * graphile_worker.add_job，返回新 job id；同 key 的待执行 job 保留原 run_at，防止周期扫描
 * 不断把它重新排到队尾。
 */
export type AddOperationJobLike = (
  client: PoolClient,
  spec: AddOperationJobSpec,
) => Promise<string | null>;

/** candidate 只投影必要字段：状态/lease/身份/投递载荷；不读取 provider payload、secret、路径。 */
export interface RecoveryCandidate {
  id: string;
  status: string;
  lease_expires_at: Date | null;
  input_version: number;
  task_identifier: string;
  queue_name: string;
  max_attempts: number;
  attempt_count: number;
  claim_token: string | null;
  graphile_job_id: string | null;
  input_hash: string;
  target_type: string;
  target_id: string;
}

/** 每个候选的恢复处理结果。 */
export type RecoveryOutcome =
  | { kind: "enqueued" }
  | { kind: "noop" }
  | { kind: "duplicate_skipped" }
  | { kind: "error"; errorSummary: string };

export interface RecoveryScanReport {
  scanned: number;
  enqueued: number;
  noop: number;
  duplicates: number;
  errors: number;
}

/** 脱敏错误日志用：只含 operationId 与错误摘要，不含路径/密钥/完整堆栈。 */
export interface RecoveryScanError {
  operationId: string;
  status: string;
  errorSummary: string;
}

export interface RecoveryScanLoopOptions {
  intervalMs: number;
  batchSize: number;
}

/** 从 AppConfig 取 recovery 配置（供装配复用；不含任何敏感字段）。 */
export function recoveryConfig(cfg: AppConfig): WorkerRecoveryConfig {
  return cfg.worker.recovery;
}

/**
 * 单次扫描：在一个事务内选出过期 running 候选，对每个候选做【SAVEPOINT 短事务】内的
 * lock → 重读 → 确认 → enqueue。行锁在整个扫描期间持有；并发扫描 SKIP LOCKED 跳过，
 * 只有拉取到候选的那份扫描推进。
 * @param addJob 注入的 add_job（默认使用真实 addOperationJob）。
 */
export async function runRecoveryScan(
  pool: Pool,
  opts: RecoveryScanLoopOptions,
  addJob: AddOperationJobLike = addOperationJob,
): Promise<{ report: RecoveryScanReport; errors: RecoveryScanError[] }> {
  const report: RecoveryScanReport = { scanned: 0, enqueued: 0, noop: 0, duplicates: 0, errors: 0 };
  const errors: RecoveryScanError[] = [];

  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    // 一次事务持有候选行锁：并发扫描对这些行 SKIP LOCKED，只有持锁者推进。
    const candidates = await client.query<RecoveryCandidate>(
      `SELECT id, status, lease_expires_at, input_version, task_identifier, queue_name,
              max_attempts, attempt_count, claim_token, graphile_job_id, input_hash, target_type, target_id
       FROM application_operations
       WHERE ${recoveryCandidateWhere()}
       ORDER BY lease_expires_at ASC, id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [opts.batchSize],
    );
    report.scanned = candidates.rowCount ?? 0;

    for (const row of candidates.rows) {
      // SAVEPOINT 短事务：每个候选独立回滚粒度，失败不影响其它候选。
      await client.query("SAVEPOINT recover_one");
      let outcome: RecoveryOutcome;
      try {
        outcome = await recoverOne(client, row, addJob);
      } catch (err) {
        outcome = {
          kind: "error",
          errorSummary: safeErrorSummary(
            (err as { errorCode?: string })?.errorCode,
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
      const failed = outcome.kind === "error";
      if (failed) {
        // 回滚到本候选的 savepoint：有任何失败都不留下"已恢复"的半成品事实。
        await client.query("ROLLBACK TO recover_one").catch(() => {});
        await client.query("RELEASE SAVEPOINT recover_one").catch(() => {});
      } else {
        await client.query("RELEASE SAVEPOINT recover_one").catch(() => {});
      }

      switch (outcome.kind) {
        case "enqueued":
          report.enqueued++;
          break;
        case "duplicate_skipped":
          report.duplicates++;
          break;
        case "noop":
          report.noop++;
          break;
        case "error":
          report.errors++;
          errors.push({
            operationId: row.id,
            status: row.status,
            errorSummary: outcome.errorSummary,
          });
          break;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    // 外层失败（连接/查询）：回滚整个扫描事务，记录脱敏错误，下一周期重试。
    await client.query("ROLLBACK").catch(() => {});
    errors.push({
      operationId: "scan",
      status: "n/a",
      errorSummary: safeErrorSummary(undefined, err instanceof Error ? err.message : String(err)),
    });
    report.errors++;
  } finally {
    client.release();
  }
  return { report, errors };
}

/**
 * 在【已持有行锁】的候选上做一次恢复：确认仍是 running + expired → 计算稳定 jobKey →
 * add_job → 刷新诊断 graphile_job_id。运行在调用方提供的 SAVEPOINT 事务内，不自行管理
 * 连接或事务边界。
 */
async function recoverOne(
  client: PoolClient,
  candidate: RecoveryCandidate,
  addJob: AddOperationJobLike,
): Promise<RecoveryOutcome> {
  // 1) 行锁已在扫描事务内持有（FOR UPDATE）。重读权威状态/lease 二次确认。
  const cur = await client.query<RecoveryCandidate>(
    `SELECT id, status, lease_expires_at, input_version, task_identifier, queue_name,
            max_attempts, attempt_count, claim_token, graphile_job_id, input_hash, target_type, target_id
     FROM application_operations WHERE id = $1 FOR UPDATE`,
    [candidate.id],
  );
  const op = cur.rows[0];
  if (!op) return { kind: "noop" };

  const isExpired =
    op.lease_expires_at !== null && new Date(op.lease_expires_at).getTime() < Date.now();
  // 2) 权威再次确认：仍 running 且 lease 已过期。
  if (op.status !== "running" || !isExpired) {
    // 状态已被其他 worker/管理员改变（no-op，不重复推进）。
    return { kind: "noop" };
  }

  // 3) 计算【稳定】recovery job identity。首选当前已持久化的 claim_token 作为 epoch
  //    （从权威事实派生，不依赖进程内存计数）。running 的 operation 由 claimOperation
  //    写入时必有 claim_token；仅在退化情形（直接写库导致为 null）下，用一个从
  //    lease_expires_at 派生的【确定性的】稳定 token 兜底——它在同一次 lease 内跨扫描
  //    稳定（保证去重），lease 前进或恢复成功后自然失效（允许后续合法恢复重启）。
  const stableToken =
    op.claim_token ?? `lease-${new Date(op.lease_expires_at ?? 0).getTime()}-${op.id}`;
  const jobKey = recoveryJobKey(op.id, stableToken);

  // 4) 事务内调用公共 add_job。只携带稳定、最小字段 {operationId, inputVersion}；
  //    使用独立恢复队列，不能被硬崩溃旧 job 持有的原业务队列锁饿死。
  //    绝不放 API Key/Authorization/完整 prompt/完整 provider 响应/连接串/原始文件/
  //    storage path/用户隐私数据。
  //    recovery job 的 Graphile 投递/重投预算由 recoveryJobMaxAttempts 决定：它是业务
  //    max_attempts 与 recovery 底线（RECOVERY_MAX_ATTEMPTS）的较大者。Graphile 的
  //    max_attempts 只控制该挽救 job 能被投递/重投几次，绝不替代业务 claim 状态机
  //    （新增业务 attempt 的唯一入口是 lease 过期后的 claimOperation 判定）。
  const jobId = await addJob(client, {
    taskIdentifier: op.task_identifier,
    queueName: RECOVERY_QUEUE_NAME,
    operationId: op.id,
    inputVersion: op.input_version,
    maxAttempts: recoveryJobMaxAttempts(op.max_attempts),
    jobKey,
  });
  if (jobId === null) {
    // jobKey 冲突（并发扫描已投递同一 recovery job）→ no-op，不重复推进 attempt。
    return { kind: "duplicate_skipped" };
  }

  // 5) 刷新诊断 graphile_job_id。注意：graphile_job_id 只是诊断文本；操作权威事实
  //    （status / attempt_count / claim_token）不变——add_job 只是投递，真正的重领
  //    在 handler 执行 claimOperation 时发生。
  await client.query(
    `UPDATE application_operations SET graphile_job_id = $2, updated_at = now() WHERE id = $1`,
    [op.id, jobId],
  );
  return { kind: "enqueued" };
}

/**
 * 在【事务连接】上调用 Graphile 官方公共 API `graphile_worker.add_job(...)`。
 * 与 API 侧的 enqueue.service 使用同一函数体；recovery job 用独立命名空间的 jobKey
 * （MOTRO_RECOVERY_JOB_KEY_NAMESPACE，由 recoveryJobKey 推导），payload 只含
 * {operationId, inputVersion}，绝不含 API Key/Authorization/完整 prompt/完整 provider
 * 响应/连接串/原始文件/storage path/用户隐私数据。待执行同 key job 使用 preserve_run_at，
 * 避免 recovery loop 每轮扫描重置其调度时间而造成实际 worker 饥饿。
 */
export async function addOperationJob(
  client: PoolClient,
  spec: AddOperationJobSpec,
): Promise<string | null> {
  const payload = { operationId: spec.operationId, inputVersion: spec.inputVersion };
  const res = await client.query<{ id: string }>(
    `SELECT (graphile_worker.add_job(
       $1, $2::json, $3, NULL, $4, $5, 0, NULL, 'preserve_run_at'
     )).id AS id`,
    [spec.taskIdentifier, JSON.stringify(payload), spec.queueName, spec.maxAttempts, spec.jobKey],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * 受控的周期性 recovery scan loop（关闭的装饰器）。
 *
 * - 构造时不自动启动；`start()` 启动后【立即】执行一次扫描，随后按 intervalMs 周期执行；
 * - `stop()` 清理 timer 并等待在途扫描完成：停止后不再发起任何 recovery enqueue；
 * - scan 自身抛错不传播、不杀死主循环；错误记录到 `onError` 并在下一周期重试；
 * - 并发保护：用 in-flight 标志确保同进程内同一时刻至多一次扫描（进程内内存锁，
 *   不作为最终防线；真正的最终防线是 DB 行锁 + jobKey 唯一 + preserve_run_at 融合）。
 */
export class RecoveryScanLoop {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly pool: Pool;
  private readonly onReport: (r: RecoveryScanReport) => void;
  private readonly onError: (e: RecoveryScanError) => void;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(opts: {
    pool: Pool;
    intervalMs: number;
    batchSize: number;
    onReport?: (r: RecoveryScanReport) => void;
    onError?: (e: RecoveryScanError) => void;
  }) {
    this.pool = opts.pool;
    this.intervalMs = opts.intervalMs;
    this.batchSize = opts.batchSize;
    this.onReport = opts.onReport ?? (() => {});
    this.onError = opts.onError ?? (() => {});
  }

  /** 启动：立即扫描一次，然后按间隔周期性扫描。 */
  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** 停止：清理 timer 并等待在途扫描完成。停止后（含 SIGINT/SIGTERM 期间）不再发起 enqueue。 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 阻塞在途扫描：若正在跑，等它完成（不会再开新 timer，也不再发起新 enqueue）。
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  /** 是否已停止（供测试断言：stop 后不再扫描）。 */
  isStopped(): boolean {
    return this.stopped;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return; // 进程内内存锁：同一时刻至多一次扫描。
    const run = (async () => {
      try {
        const { report, errors } = await runRecoveryScan(this.pool, {
          intervalMs: this.intervalMs,
          batchSize: this.batchSize,
        });
        if (errors.length > 0) for (const e of errors) this.onError(e);
        this.onReport(report);
      } catch (err) {
        this.onError({
          operationId: "scan",
          status: "n/a",
          errorSummary: safeErrorSummary(
            undefined,
            err instanceof Error ? err.message : String(err),
          ),
        });
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
    }
  }
}
