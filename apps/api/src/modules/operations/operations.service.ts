// 阶段 6 工单 04：operation 应用服务（管理命令/查询）。
//
// 重试命令要求：
//   - 管理员 + CSRF（controller）+ Idempotency-Key（本服务）+ 审计；
//   - 只允许 failed / manual_action 状态；
//   - 同 key + 同载荷重放原响应；同 key + 不同载荷返回 409 IDEMPOTENCY_CONFLICT；
//   - 事务内把 operation 转 queued 并重新投递 Graphile job；
//   - 已 succeeded/queued/running/retry_wait 一律拒绝人工重试。
//
// 重试的幂等 scope 按 admin 用户隔离，key 由调用方（controller）从 Idempotency-Key 头读入。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { POOL } from "../../auth/database.provider.js";
import { isRetryEligible, type OperationStatus } from "@motro/domain";
import type {
  OperationDetailDto,
  OperationListResponseDto,
  OperationRetryResultDto,
  OperationSummaryDto,
} from "./operations.dto.js";
import { OperationRepository } from "./operations.repository.js";
import { addOperationJob, GRAPHILE_SCHEMA } from "./enqueue.service.js";
import { toSummary } from "./operations.repository.js";

const RETRY_SCOPE_PREFIX = "operations:retry";

export class OperationRetryConflictError extends Error {
  constructor(message = "该 Idempotency-Key 已被不同的请求载荷占用") {
    super(message);
    this.name = "OperationRetryConflictError";
  }
}

export class OperationRetryInProgressError extends Error {
  constructor() {
    super("该请求正在处理中，请稍后重试");
    this.name = "OperationRetryInProgressError";
  }
}

export class OperationNotRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationNotRetryableError";
  }
}

export class OperationGraphileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationGraphileUnavailableError";
  }
}

interface RetryRow {
  id: string;
  operation_type: string;
  operation_version: number;
  target_type: string;
  target_id: string;
  input_version: number;
  status: string;
  attempt_count: number;
  max_attempts: number;
  retryable: boolean;
  last_error_code: string | null;
  last_error_summary: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  queue_name: string;
  task_identifier: string;
}

/** 把事务内读到的 RetryRow 映射为与 repository.toSummary 一致的 OperationSummaryDto 投影。 */
function toRetrySummary(op: RetryRow): OperationSummaryDto {
  return toSummary({
    id: op.id,
    operation_type: op.operation_type,
    operation_version: op.operation_version,
    target_type: op.target_type,
    target_id: op.target_id,
    input_version: op.input_version,
    status: op.status,
    attempt_count: op.attempt_count,
    max_attempts: op.max_attempts,
    retryable: op.retryable,
    last_error_code: op.last_error_code,
    last_error_summary: op.last_error_summary,
    created_at: op.created_at,
    updated_at: op.updated_at,
    started_at: op.started_at,
    completed_at: op.completed_at,
  });
}

@Injectable()
export class OperationsService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly repository: OperationRepository,
  ) {}

  list(opts: {
    status?: string;
    operationType?: string;
    cursor?: string;
    limit?: number;
  }): Promise<OperationListResponseDto> {
    return this.repository.list(opts);
  }

  getDetail(id: string): Promise<OperationDetailDto> {
    return this.repository.getDetail(id);
  }

  /**
   * 管理员重试命令。要求 admin、CSRF、Idempotency-Key 与审计。
   * 事务内把 operation 转 queued，重新投递 Graphile job，并写审计 + 幂等完成。
   */
  async retry(opts: {
    operationId: string;
    adminId: string;
    idempotencyKey: string;
    confirm: boolean;
    requestId: string;
  }): Promise<OperationRetryResultDto> {
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      // 1) 锁定 operation 行，重读权威状态。
      const opRes = await client.query<RetryRow>(
        `SELECT id, operation_type, operation_version, target_type, target_id, input_version,
                status, attempt_count, max_attempts, retryable,
                last_error_code, last_error_summary, created_at, updated_at, started_at, completed_at,
                queue_name, task_identifier
         FROM application_operations WHERE id = $1 FOR UPDATE`,
        [opts.operationId],
      );
      const op = opRes.rows[0];
      if (!op) {
        await client.query("ROLLBACK").catch(() => {});
        throw new NotFoundException("操作不存在");
      }

      // 2) 幂等检查必须优先于状态/confirm 错误：同 key 重放返回原结果，改载荷 409。
      const scope = `${RETRY_SCOPE_PREFIX}:${opts.adminId}`;
      const semanticHash = retrySemanticHash(opts.operationId, opts.confirm);
      const idem = await client.query<{ response_json: unknown; request_hash: string }>(
        `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, opts.idempotencyKey],
      );
      if (idem.rows[0]) {
        const stored = idem.rows[0].response_json as Record<string, unknown> | null;
        if (stored && "pending" in stored) {
          await client.query("ROLLBACK").catch(() => {});
          throw new OperationRetryInProgressError();
        }
        if (idem.rows[0].request_hash !== semanticHash) {
          await client.query("ROLLBACK").catch(() => {});
          throw new OperationRetryConflictError();
        }
        // 同 key + 同语义重放：返回【冻结的首次响应投影】，绝不再读实时状态。
        const frozen =
          stored && typeof stored.operation === "object" && stored.operation !== null
            ? (stored.operation as OperationSummaryDto)
            : toRetrySummary(op); // 防御：老数据无完整投影时回退到当前投影。
        await client.query("ROLLBACK").catch(() => {});
        return { operation: frozen, isIdempotentReplay: true };
      }

      // 3) 新 key 请求：必须先显式确认。
      if (!opts.confirm) {
        await client.query("ROLLBACK").catch(() => {});
        throw new OperationNotRetryableError("必须显式确认重试（confirm=true）");
      }

      // 3) 状态门：只允许 failed / manual_action。
      // 4) 状态门：只允许 failed / manual_action。
      if (!isRetryEligible(op.status as OperationStatus)) {
        await client.query("ROLLBACK").catch(() => {});
        throw new OperationNotRetryableError(
          `当前状态 ${op.status} 不允许人工重试（只允许 failed / manual_action）`,
        );
      }

      // 5) Graphile schema 就绪检查（readiness 区分）。
      const ready = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.schemata WHERE schema_name = $1`,
        [GRAPHILE_SCHEMA],
      );
      if (Number(ready.rows[0]?.n ?? 0) === 0) {
        await client.query("ROLLBACK").catch(() => {});
        throw new OperationGraphileUnavailableError("Graphile worker schema 未就绪，无法重试");
      }

      // 6) claim 幂等 pending。
      await client.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash, response_json) VALUES ($1,$2,$3,$4)
         ON CONFLICT (scope, key) DO NOTHING`,
        [scope, opts.idempotencyKey, semanticHash, JSON.stringify({ pending: true })],
      );

      // 7) 状态 → queued，投递 job，写审计。
      const jobId = await addOperationJob(client, {
        taskIdentifier: op.task_identifier || op.operation_type,
        queueName: op.queue_name,
        operationId: op.id,
        inputVersion: op.input_version,
        maxAttempts: op.max_attempts,
      });
      if (jobId === null) {
        await client.query("ROLLBACK").catch(() => {});
        throw new OperationGraphileUnavailableError("add_job 返回空（job key 冲突），重试已回滚");
      }

      await client.query(
        `UPDATE application_operations
         SET status = 'queued', graphile_job_id = $2, started_at = NULL, completed_at = NULL,
             retryable = true, last_error_code = NULL, last_error_summary = NULL,
             updated_at = now()
         WHERE id = $1`,
        [op.id, jobId],
      );

      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'application_operation', $3, $4::jsonb, $5::jsonb, $6)`,
        [
          opts.adminId,
          "admin.operations.retry",
          op.id,
          JSON.stringify({ status: op.status, attemptCount: op.attempt_count }),
          JSON.stringify({ status: "queued", jobId }),
          opts.requestId,
        ],
      );

      // 冻结首次成功响应的完整投影：重放时绝不读实时状态。
      const frozenProjection = toRetrySummary({
        ...op,
        status: "queued",
        retryable: true,
        last_error_code: null,
        last_error_summary: null,
        started_at: null,
        completed_at: null,
        updated_at: new Date(),
      });
      await client.query(
        `UPDATE idempotency_keys SET response_json = $3, resource_id = $4
         WHERE scope = $1 AND key = $2`,
        [
          scope,
          opts.idempotencyKey,
          JSON.stringify({ operation: frozenProjection, isIdempotentReplay: false }),
          op.id,
        ],
      );
      await client.query("COMMIT");
      // 事务提交后返回冻结投影（与存储一致），绝不再调 getSummary 替换实时状态。
      return { operation: frozenProjection, isIdempotentReplay: false };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

/** 重试请求的语义哈希：绑定 operation ID 与 confirm 载荷（同操作同 key 重放；不同载荷 409）。 */
function retrySemanticHash(operationId: string, confirm: boolean): string {
  return createHash("sha256")
    .update(`operations:retry:${operationId}:confirm=${confirm}`)
    .digest("hex");
}
