// 阶段 6 工单 04 关键修复 + 工单 05 原子性修复：operation 执行核心。
//
// 原子性契约（工单 05，Ticket 05 source-fact atomicity）：
//   - handler 返回的 deferred source facts 由本模块在【最终事务】中写入
//     wiktionary_source_facts，与 operation completion（completeAttempt）同事务提交；
//   - 若 completeAttempt 因 stale claim / claim token 不匹配 / 状态非法而失败（返回
//     result 为 stale_claim），整个事务 rollback —— 已写入的不可变 source fact 随之回滚，
//     绝不留下「operation 未成功但 fact 已落库」的孤儿事实；
//   - source fact INSERT 与 completeAttempt 使用【同一事务连接】（deferred-writer 模式）；
//   - heartbeat 可用独立连接，但最终事实写入 + 完成在同事务，且事务不依赖已失效 claim。
import type { Pool, PoolClient } from "pg";
import {
  claimDecision,
  classifyError,
  DEFAULT_LEASE_MS,
  generateClaimToken,
  isLegalTransition,
  safeErrorSummary,
  type DeferredSourceFact,
  type OperationHandlerRegistry,
  type OperationStatus,
} from "@motro/domain";

export interface OperationRow {
  id: string;
  operation_type: string;
  target_type: string;
  target_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  graphile_job_id: string | null;
  input_version: number;
  claim_token: string | null;
  lease_expires_at: Date | null;
}

const SUCCEEDED = "succeeded";
const RUNNING = "running";

export class OperationExecutionError extends Error {
  constructor(
    message: string,
    public readonly opErrorCode: string,
    public readonly disposition: "retryable" | "permanent" | "manual_action",
  ) {
    super(message);
    this.name = "OperationExecutionError";
  }
}

export type ClaimResult =
  | { kind: "noop" }
  | {
      kind: "claimed";
      claimToken: string;
      operation: OperationRow;
      attemptNumber: number;
    }
  | { kind: "max_attempts_exceeded" };

/**
 * 当 lease 已过期且已达到 max_attempts 时，终止 operation：把当前未完成 attempt 标记为
 * abandoned，operation → 终态（failed），清除 claim/lease 字段，设置 completed_at。
 * 稳定错误码 OPERATION_MAX_ATTEMPTS_EXCEEDED；绝不伪造 succeeded；绝不改写已完成 attempt。
 * 返回 true 表示已终止（调用方应 no-op 且不再投递）。
 */
async function terminateExhaustedOperation(
  client: PoolClient,
  op: OperationRow,
  message: string,
): Promise<void> {
  // 当前未完成 attempt（outcome IS NULL 且编号 < 下一编号）标记为 abandoned —— 可审计、
  // 不是成功/失败伪装，也不改写已完成 attempt。
  const nextAttempt = op.attempt_count + 1;
  await client.query(
    `UPDATE application_operation_attempts
     SET outcome = 'abandoned', finished_at = now()
     WHERE operation_id = $1 AND outcome IS NULL AND attempt_number < $2`,
    [op.id, nextAttempt],
  );
  // operation → failed（终态），清空 claim/lease，设置 completed_at 与脱敏错误。
  await client.query(
    `UPDATE application_operations
     SET status = 'failed', retryable = false,
         last_error_code = 'OPERATION_MAX_ATTEMPTS_EXCEEDED',
         last_error_summary = $2,
         completed_at = now(),
         claim_token = NULL, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1`,
    [op.id, safeErrorSummary("OPERATION_MAX_ATTEMPTS_EXCEEDED", message)],
  );
}

/**
 * 原子领取 operation（lease-based）。在一个事务内完成全部判定与写入。
 * @param now 可注入时钟（测试确定性）；默认 new Date()。
 */
export async function claimOperation(
  pool: Pool | PoolClient,
  operationId: string,
  opts: { leaseMs?: number; leaseOwner?: string; now?: Date } = {},
): Promise<ClaimResult> {
  const client =
    typeof (pool as Pool).connect === "function"
      ? await (pool as Pool).connect()
      : (pool as PoolClient);
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const owner = opts.leaseOwner ?? "worker";
  const now = opts.now ?? new Date();
  await client.query("BEGIN");
  try {
    const row = await client.query<OperationRow>(
      `SELECT id, operation_type, target_type, target_id, status, attempt_count, max_attempts,
              graphile_job_id, input_version, claim_token, lease_expires_at
       FROM application_operations WHERE id = $1 FOR UPDATE`,
      [operationId],
    );
    const op = row.rows[0];
    if (!op) {
      // operation 不存在：丢弃，不做任何写入。
      await client.query("ROLLBACK").catch(() => {});
      client.release?.();
      return { kind: "noop" };
    }

    const decision = claimDecision({
      status: op.status as OperationStatus,
      leaseExpiresAt: op.lease_expires_at,
      now,
    });

    if (decision === "noop") {
      // succeeded / running(lease 未过期) / failed / manual_action：no-op。
      await client.query("COMMIT").catch(() => {});
      client.release?.();
      return { kind: "noop" };
    }

    const reclaim = decision === "reclaimable";
    const nextAttempt = op.attempt_count + 1;
    if (nextAttempt > op.max_attempts) {
      // 已达到最大尝试次数：不得静默 no-op（否则 recovery scan 会无限重投形成 zombie
      // running）；在同一事务内终止 operation → failed 终态，回收扫描后续不再 enqueue。
      await terminateExhaustedOperation(
        client,
        op,
        "operation 已达到最大尝试次数（OPERATION_MAX_ATTEMPTS_EXCEEDED）",
      );
      await client.query("COMMIT");
      client.release?.();
      return { kind: "max_attempts_exceeded" };
    }

    const claimToken = generateClaimToken();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    // 重领：旧 running attempt 必须以可审计方式标记为 abandoned（不是成功/失败伪装），
    // 且绝不改写它（attempt 事实不可变）。
    if (reclaim) {
      await client.query(
        `UPDATE application_operation_attempts
         SET outcome = 'abandoned', finished_at = now()
         WHERE operation_id = $1 AND outcome IS NULL AND attempt_number < $2`,
        [op.id, nextAttempt],
      );
    }

    // 建新 running attempt（worker_job_id 由 INSERT 时写入，见 0025 语义）。
    await client.query(
      `INSERT INTO application_operation_attempts (operation_id, attempt_number, worker_job_id)
       VALUES ($1, $2, $3)`,
      [op.id, nextAttempt, op.graphile_job_id],
    );

    // 写新 lease + 置 running。
    await client.query(
      `UPDATE application_operations
       SET status = 'running', attempt_count = $2, started_at = now(),
           claim_token = $3, lease_owner = $4, lease_expires_at = $5
       WHERE id = $1`,
      [op.id, nextAttempt, claimToken, owner, leaseExpiresAt],
    );
    await client.query("COMMIT");
    client.release?.();

    return {
      kind: "claimed",
      claimToken,
      operation: {
        ...op,
        status: RUNNING,
        attempt_count: nextAttempt,
        claim_token: claimToken,
        lease_expires_at: leaseExpiresAt,
      },
      attemptNumber: nextAttempt,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release?.();
    throw err;
  }
}

export interface CompleteAttemptInput {
  operationId: string;
  attemptNumber: number;
  claimToken: string;
  graphileJobId: string | null;
  succeeded: boolean;
  errorCode?: string;
  /** 已脱敏的错误摘要（由调用方经 safeErrorSummary 生成）。 */
  errorSummary?: string;
}

export type CompleteAttemptResult =
  "succeeded" | "retry_wait" | "failed" | "manual_action" | "stale_claim";

/**
 * 在【已由调用方开好的事务 client 上】执行 attempt 完成与 operation 状态推进。
 * 不自行 BEGIN/COMMIT——调用方拥有事务边界，因此 source fact INSERT 可与本函数
 * 同事务提交，任一步失败整体 rollback。
 *
 * 返回 { result, committed }：result 为完成结果；若为 stale_claim，调用方必须 ROLLBACK。
 */
export async function completeAttemptInTx(
  client: PoolClient,
  input: CompleteAttemptInput,
): Promise<CompleteAttemptResult> {
  const op = await client.query<{
    status: string;
    max_attempts: number;
    attempt_count: number;
    claim_token: string | null;
  }>(
    `SELECT status, max_attempts, attempt_count, claim_token
     FROM application_operations WHERE id = $1 FOR UPDATE`,
    [input.operationId],
  );
  if (!op.rows[0]) throw new Error(`operation ${input.operationId} 不存在`);
  const { status, max_attempts, attempt_count, claim_token } = op.rows[0];

  // claim 归属校验：当前 operation 的 claim token 必须与本次执行的 token 一致。
  if (claim_token !== input.claimToken) {
    // 过期 worker 或重复 job：不得覆盖已被新 worker 重领后的状态。返回 stale_claim，
    // 由调用方在事务内回滚（若已写入 deferred facts，一并回滚）。
    return "stale_claim";
  }

  // succeeded → 幂等 no-op（防重复 job 并发完成）。
  if (status === SUCCEEDED) return "succeeded";

  if (input.succeeded) {
    await client.query(
      `UPDATE application_operation_attempts
       SET outcome = 'succeeded', finished_at = now(), worker_job_id = $3
       WHERE operation_id = $1 AND attempt_number = $2`,
      [input.operationId, input.attemptNumber, input.graphileJobId],
    );
    await client.query(
      `UPDATE application_operations
       SET status = 'succeeded', last_error_code = NULL, last_error_summary = NULL,
           completed_at = now(), claim_token = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [input.operationId],
    );
    return "succeeded";
  }

  // 失败：errorCode 是权威；summary 必须经过脱敏（防御纵深：即使调用方传了原文也脱敏）。
  const disposition = classifyError(input.errorCode);
  const attemptsLeft = max_attempts - attempt_count;
  const retryable = disposition === "retryable" && attemptsLeft > 0;
  const safeSummary = safeErrorSummary(input.errorCode, input.errorSummary ?? "");

  await client.query(
    `UPDATE application_operation_attempts
     SET outcome = 'failed', finished_at = now(), worker_job_id = $3, error_code = $4, error_summary = $5
     WHERE operation_id = $1 AND attempt_number = $2`,
    [
      input.operationId,
      input.attemptNumber,
      input.graphileJobId,
      input.errorCode ?? null,
      safeSummary,
    ],
  );

  // manual_action 分类：写入失败 attempt、retryable=false、稳定错误码、completed_at、
  // 清空 claim/lease，不进 retry_wait，不自动再次投递；仅由管理员经既有 retry 端点
  // 显式重试（manual_action → queued 是数据库 transition guard 允许的唯一离开路径）。
  if (
    disposition === "manual_action" &&
    isLegalTransition(status as OperationStatus, "manual_action")
  ) {
    await client.query(
      `UPDATE application_operations
       SET status = 'manual_action', retryable = false, last_error_code = $2, last_error_summary = $3,
           completed_at = now(), claim_token = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [input.operationId, input.errorCode ?? null, safeSummary],
    );
    return "manual_action";
  }

  if (retryable && isLegalTransition(status as OperationStatus, "retry_wait")) {
    await client.query(
      `UPDATE application_operations
       SET status = 'retry_wait', last_error_code = $2, last_error_summary = $3,
           claim_token = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [input.operationId, input.errorCode ?? null, safeSummary],
    );
    return "retry_wait";
  }

  // 不可重试或达到上限：operation → failed（终止自动重试）。
  await client.query(
    `UPDATE application_operations
     SET status = 'failed', retryable = $2, last_error_code = $3, last_error_summary = $4,
         completed_at = now(), claim_token = NULL, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1`,
    [input.operationId, false, input.errorCode ?? null, safeSummary],
  );
  return "failed";
}

function isPool(x: Pool | PoolClient): x is Pool {
  return typeof (x as Pool).connect === "function";
}

/**
 * completeAttempt 的公开入口（兼容既有调用/测试）：自开自关事务，
 * 然后调用 completeAttemptInTx 并据此提交或回滚。
 */
export async function completeAttempt(
  pool: Pool | PoolClient,
  input: CompleteAttemptInput,
): Promise<CompleteAttemptResult> {
  const client = isPool(pool) ? await pool.connect() : pool;
  await client.query("BEGIN");
  try {
    const result = await completeAttemptInTx(client, input);
    if (result === "stale_claim") {
      await client.query("ROLLBACK").catch(() => {});
    } else {
      await client.query("COMMIT");
    }
    client.release?.();
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release?.();
    throw err;
  }
}

/**
 * 在【已开好的事务 client 上】写入 deferred source facts（append-only，幂等 ON CONFLICT）。
 * 与 completeAttempt 同事务 → 任一步失败整体 rollback，绝不留孤儿不可变事实。
 * 返回已写入数量（重放命中既有 identity 的不计入）。不关闭事务/连接。
 */
export async function writeDeferredFactsInTx(
  client: PoolClient,
  facts: DeferredSourceFact[],
): Promise<{ inserted: number; replayed: number }> {
  let inserted = 0;
  let replayed = 0;
  for (const f of facts) {
    const res = await client.query(
      `INSERT INTO wiktionary_source_facts
         (source_fact_identity, page_identity_hash, revision_identity_hash, page_id, revision_id,
          revision_timestamp, canonical_title, normalized_spelling, language, part_of_speech,
          definition_excerpt, content_hash, source_url, license_name, license_version, license_url,
          attribution, parser_version, status, ambiguity_note, ambiguity_candidates,
          commit_row_id, input_version_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (source_fact_identity) DO NOTHING`,
      [
        f.sourceFactIdentity,
        f.pageIdentityHash,
        f.revisionIdentityHash,
        f.pageId,
        f.revisionId,
        f.revisionTimestamp,
        f.canonicalTitle,
        f.normalizedSpelling,
        f.language,
        f.partOfSpeech,
        f.definitionExcerpt,
        f.contentHash,
        f.sourceUrl,
        f.licenseName,
        f.licenseVersion,
        f.licenseUrl,
        f.attribution,
        f.parserVersion,
        f.status,
        f.ambiguityNote,
        f.ambiguityCandidates ? JSON.stringify(f.ambiguityCandidates) : null,
        f.commitRowId,
        f.inputVersionUsed,
      ],
    );
    if ((res.rowCount ?? 0) > 0) inserted++;
    else replayed++;
  }
  return { inserted, replayed };
}

export type ExecuteResult =
  | "succeeded"
  | "failed"
  | "retry_wait"
  | "manual_action"
  | "already_done"
  | "stale_claim"
  | "max_attempts_exceeded";

/** lease 续租默认周期：默认 lease 60s → 每 20s 续租一次（明显小于 lease）。 */
export const LEASE_HEARTBEAT_INTERVAL_MS = 20_000;
/** 心跳周期取 lease/3（明显小于 lease），且不小于该下界（避免对短 lease 高轮询）。 */
export const LEASE_HEARTBEAT_MIN_INTERVAL_MS = 200;

/**
 * 依据 lease 时长计算心跳周期。运行时配置要求 lease 至少 600ms，故常规路径始终满足
 * interval < lease；这里仍对直接调用者做上界保护，避免测试/未来调用传入异常小 lease 时
 * 心跳晚于租约。
 */
export function heartbeatIntervalFor(leaseMs: number): number {
  const third = Math.max(1, Math.floor(leaseMs / 3));
  const bounded = Math.min(
    LEASE_HEARTBEAT_INTERVAL_MS,
    Math.max(LEASE_HEARTBEAT_MIN_INTERVAL_MS, third),
  );
  return Math.max(1, Math.min(bounded, leaseMs - 1));
}

/**
 * 为执行中的 claim 续租。使用 claim_token 归属校验：
 *   UPDATE ... WHERE operation_id=$1 AND claim_token=$2 AND status='running'
 * 影响行数为 0 → 已失去 claim（被 recovery 重领/管理员终止），返回 false。
 */
export async function leaseHeartbeat(
  pool: Pool | PoolClient,
  operationId: string,
  claimToken: string,
  leaseMs: number,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE application_operations
     SET lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
     WHERE id = $1 AND claim_token = $2 AND status = 'running'`,
    [operationId, claimToken, leaseMs],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 完整执行一次 operation：claim → 找 handler → run（含 lease 心跳）→ 完成。
 * 可重试未耗尽时抛 OperationExecutionError(disposition=retryable) 交给 Graphile 退避。
 */
export async function executeOperation(
  pool: Pool,
  registry: OperationHandlerRegistry,
  operationId: string,
  graphileJobId: string | null,
  signal?: AbortSignal,
  opts: { leaseMs?: number; leaseOwner?: string; now?: Date } = {},
): Promise<ExecuteResult> {
  const claimed = await claimOperation(pool, operationId, opts);
  if (claimed.kind === "noop") return "already_done";
  if (claimed.kind === "max_attempts_exceeded") return "max_attempts_exceeded";
  const { operation, attemptNumber, claimToken } = claimed;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;

  const handler = registry.get(operation.operation_type);
  if (!handler) {
    // 无 handler：视为永久失败（记录 attempt；summary 用固定安全文案）。
    await completeAttempt(pool, {
      operationId,
      attemptNumber,
      claimToken,
      graphileJobId,
      succeeded: false,
      errorCode: "OPERATION_HANDLER_MISSING",
      errorSummary: `未注册的 operation handler：${operation.operation_type}`,
    });
    return "failed";
  }

  // 失去 claim 的 abort 源：recovery/管理员重领后，旧 handler 必须通过 AbortSignal 停止。
  const lostClaimController = new AbortController();
  const handlerSignal = combineSignals(signal, lostClaimController.signal);

  // 周期续租：保证执行超过 lease 时仍持有同一 claim。周期依 lease 派生（明显小于 lease）。
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatInFlight = false;
  const startHeartbeat = (): void => {
    const intervalMs = heartbeatIntervalFor(leaseMs);
    heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || lostClaimController.signal.aborted) return;
      heartbeatInFlight = true;
      // 任一 heartbeat 失败都按“claim 已不可证明仍归我”处理：停止 handler，避免旧 worker
      // 在数据库不可达/连接拒绝时继续产生外部副作用。catch 必须在此处消费，避免 unhandled
      // rejection 静默绕过这条安全边界。
      void leaseHeartbeat(pool, operationId, claimToken, leaseMs)
        .then((stillHeld) => {
          if (!stillHeld) lostClaimController.abort();
        })
        .catch(() => {
          lostClaimController.abort();
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, intervalMs);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  };
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  startHeartbeat();
  // 分两阶段执行，避免死锁：
  //   阶段 1：先跑 handler（只读、构建 deferred facts），此时【不开事务】——handler 内部用
  //     pool.query 读目标，若 txClient 先占用一个连接，pool max 较小（如 2）时并发执行会死锁。
  //   阶段 2：拿到 handler 结果后，再开【单个事务】：写 deferred facts + completeAttempt 一起提交。
  //     completeAttemptInTx 在事务内重新校验 claim_token（fencing），stale_claim → 整体 rollback。
  if (lostClaimController.signal.aborted) {
    stopHeartbeat();
    return "stale_claim";
  }
  let txClient: PoolClient | null = null;
  try {
    const result = await handler.run(operationId, handlerSignal);
    stopHeartbeat();
    if (lostClaimController.signal.aborted || handlerSignal.aborted) {
      // 失去 claim（heartbeat 失败 / 被接管）：绝不写 fact / 完成，返回 stale_claim。
      return "stale_claim";
    }
    const outcome = result.outcome;

    // 阶段 2：单事务写 fact + 完成。
    txClient = await pool.connect();
    await txClient.query("BEGIN");

    // 校验并写入 deferred facts（与 completion 同事务；stale_claim/失败 → 整体回滚）。
    const facts = result.deferredFacts ?? [];
    if (facts.length > 0) {
      const { validateDeferredFact } = await import("@motro/domain");
      for (const f of facts) {
        const v = validateDeferredFact(f);
        if (!v.ok) {
          await txClient.query("ROLLBACK").catch(() => {});
          return "failed";
        }
      }
      await writeDeferredFactsInTx(txClient, facts);
    }

    if (outcome === "succeeded") {
      const completed = await completeAttemptInTx(txClient, {
        operationId,
        attemptNumber,
        claimToken,
        graphileJobId,
        succeeded: true,
        errorSummary: result.summary,
      });
      if (completed === "stale_claim") {
        await txClient.query("ROLLBACK").catch(() => {});
        return "stale_claim";
      }
      await txClient.query("COMMIT");
      return completed;
    }

    // handler 返回 outcome='failed' + errorCode（如 WIKI_AMBIGUOUS → manual_action）：
    // deferred fact 已在上方同事务写入，随后按分类完成（manual_action/failed/retry_wait）。
    const failedInput: CompleteAttemptInput = {
      operationId,
      attemptNumber,
      claimToken,
      graphileJobId,
      succeeded: false,
      errorSummary: result.summary,
    };
    if (result.errorCode !== undefined) failedInput.errorCode = result.errorCode;
    const completed = await completeAttemptInTx(txClient, failedInput);
    if (completed === "stale_claim") {
      await txClient.query("ROLLBACK").catch(() => {});
      return "stale_claim";
    }
    if (completed === "retry_wait") {
      await txClient.query("COMMIT");
      throw new OperationExecutionError(
        result.summary,
        result.errorCode ?? "OPERATION_TRANSIENT",
        classifyError(result.errorCode),
      );
    }
    await txClient.query("COMMIT");
    return completed;
  } catch (err) {
    // handler 抛出（失败路径）或事务内失败：回滚 txClient 上已写入的事实，然后记录 attempt 失败。
    // 若 handler 抛错时 txClient 尚未打开（null），现在补开一个短事务连接记录失败——此时
    // handler 已结束，不会与 handler 内部的 pool.query 争用连接（避免之前的死锁）。
    if (txClient) {
      await txClient.query("ROLLBACK").catch(() => {});
    }
    const errorCode =
      (err instanceof OperationExecutionError ? err.opErrorCode : undefined) ??
      (err as { errorCode?: string })?.errorCode ??
      "OPERATION_TRANSIENT";
    const rawMessage = err instanceof Error ? err.message : String(err);
    const safeSummary = safeErrorSummary(errorCode, rawMessage);
    let outcome: CompleteAttemptResult;
    let failureConn: PoolClient | null = txClient;
    try {
      if (!failureConn) failureConn = await pool.connect();
      await failureConn.query("BEGIN");
      const failedInput: CompleteAttemptInput = {
        operationId,
        attemptNumber,
        claimToken,
        graphileJobId,
        succeeded: false,
        errorCode,
        errorSummary: safeSummary,
      };
      outcome = await completeAttemptInTx(failureConn, failedInput);
      if (outcome === "stale_claim") await failureConn.query("ROLLBACK").catch(() => {});
      else await failureConn.query("COMMIT");
    } catch {
      if (failureConn) await failureConn.query("ROLLBACK").catch(() => {});
      outcome = "stale_claim";
    } finally {
      if (failureConn && failureConn !== txClient) failureConn.release?.();
    }
    if (outcome === "retry_wait") {
      throw new OperationExecutionError(safeSummary, errorCode, classifyError(errorCode));
    }
    return outcome === "stale_claim" ? "stale_claim" : outcome;
  } finally {
    if (txClient) txClient.release?.();
    stopHeartbeat();
  }
}

/** 组合两个 AbortSignal：任一被 abort 即 abort 结果。 */
export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  for (const s of signals) {
    if (s?.aborted) {
      controller.abort();
      break;
    }
    s?.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/** executeOperation 的别名：透传 Graphile abort signal。 */
export async function executeWithAbort(
  pool: Pool,
  registry: OperationHandlerRegistry,
  operationId: string,
  graphileJobId: string | null,
  signal: AbortSignal,
  opts: { leaseMs?: number; leaseOwner?: string; now?: Date } = {},
): Promise<ExecuteResult> {
  return executeOperation(pool, registry, operationId, graphileJobId, signal, opts);
}
