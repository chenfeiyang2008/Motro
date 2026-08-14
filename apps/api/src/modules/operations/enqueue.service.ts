// 阶段 6 工单 04：enqueue port 的 Graphile 实现。
// 在调用方（import commit）的事务内创建/取得 operation 并调用公共 graphile_worker.add_job。
//
// 只使用官方公共 API：graphile_worker.add_job(...)。禁止查询、依赖或建立外键到
// `_private_*` 表。Graphile schema 由官方 runMigrations() 管理，不复制进 Motro migration。
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { operationJobKey } from "@motro/domain";
import {
  type EnqueueOperationInput,
  type EnqueueOperationResult,
  type OperationEnqueuePort,
} from "./enqueue.port.js";

/** Graphile 官方 schema 名。 */
export const GRAPHILE_SCHEMA = "graphile_worker";

export class OperationEnqueueError extends Error {
  constructor(
    message: string,
    public readonly reason: "invalid_input" | "add_job_failed" | "graphile_schema_missing",
  ) {
    super(message);
    this.name = "OperationEnqueueError";
  }
}

/** 校验 task identifier / queue name 属于允许的低基数 ASCII 集合。 */
function validateTaskAndQueue(
  taskIdentifier: string,
  queueName: string,
): { ok: boolean; reason?: string } {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(taskIdentifier)) {
    return { ok: false, reason: `task identifier 不合法：${taskIdentifier}` };
  }
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(queueName) ||
    /[0-9a-f]{32}/i.test(queueName.replace(/-/g, ""))
  ) {
    return { ok: false, reason: `queue name 不合法（须为低基数 ASCII，禁 UUID）：${queueName}` };
  }
  return { ok: true };
}

@Injectable()
export class OperationEnqueueService implements OperationEnqueuePort {
  async enqueueInTransaction(
    client: PoolClient,
    input: EnqueueOperationInput,
  ): Promise<EnqueueOperationResult | null> {
    // 1) 校验低基数约束。
    const v = validateTaskAndQueue(input.operationType, input.queueName);
    if (!v.ok) throw new OperationEnqueueError(v.reason ?? "invalid input", "invalid_input");

    // 2) Graphile 官方 schema 必须在 API 接受导入提交前就绪（readiness 门）。
    const ready = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.schemata WHERE schema_name = $1`,
      [GRAPHILE_SCHEMA],
    );
    if (Number(ready.rows[0]?.n ?? 0) === 0) {
      throw new OperationEnqueueError(
        "Graphile worker schema 未就绪，无法投递任务",
        "graphile_schema_missing",
      );
    }

    // 3) 创建/取得 operation（同 operation_type + target + input 唯一）。
    const upsert = await client.query<{ id: string; created: boolean }>(
      `WITH candidate AS (
         INSERT INTO application_operations
           (operation_type, operation_version, target_type, target_id, input_hash, input_version,
            status, task_identifier, queue_name, max_attempts, requested_by)
         VALUES ($1, 1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9)
         ON CONFLICT (operation_type, target_type, target_id, input_hash) DO NOTHING
         RETURNING id, true AS created
       )
       SELECT id, created FROM candidate
       UNION ALL
       SELECT id, false AS created FROM application_operations
       WHERE operation_type = $1 AND target_type = $2 AND target_id = $3 AND input_hash = $4
       LIMIT 1`,
      [
        input.operationType,
        input.targetType,
        input.targetId,
        input.inputHash,
        input.inputVersion,
        input.operationType, // task_identifier 与 operation_type 一致（窄 task identifier）。
        input.queueName,
        input.maxAttempts,
        input.requestedBy,
      ],
    );
    const row = upsert.rows[0];
    if (!row) throw new OperationEnqueueError("operation 创建/取得失败", "add_job_failed");

    // 4) 同一事务调用公共 add_job。jobKey 带 Motro 命名空间；返回 null → 调用方回滚。
    const jobId = await addOperationJob(client, {
      taskIdentifier: input.operationType,
      queueName: input.queueName,
      operationId: row.id,
      inputVersion: input.inputVersion,
      maxAttempts: input.maxAttempts,
    });
    if (jobId === null) {
      throw new OperationEnqueueError("add_job 返回空（job key 冲突），必须回滚", "add_job_failed");
    }

    // 5) 记录 Graphile job id（诊断字段，不 FK 私有表）。
    await client.query(
      `UPDATE application_operations SET graphile_job_id = $2, updated_at = now() WHERE id = $1`,
      [row.id, jobId],
    );

    return { created: row.created, operationId: row.id };
  }
}

/**
 * 在传入的（业务事务）client 上调用公共 graphile_worker.add_job(...)，返回 job id。
 * payload 只含稳定、不透明 ID 与版本：{ operationId, inputVersion }。
 * 返回 null 表示 job key 冲突（高争用 job key 时官方可能返回 null）——调用方必须
 * 将其转换为安全回滚/重试，绝不伪造已投递。
 */
export async function addOperationJob(
  client: PoolClient,
  spec: {
    taskIdentifier: string;
    queueName: string;
    operationId: string;
    inputVersion: number;
    maxAttempts: number;
  },
): Promise<string | null> {
  const payload = {
    operationId: spec.operationId,
    inputVersion: spec.inputVersion,
  };
  const res = await client.query<{ id: string }>(
    `SELECT (graphile_worker.add_job(
       $1, $2::json, $3, NULL, $4, $5, 0, NULL, 'replace'
     )).id AS id`,
    [
      spec.taskIdentifier,
      JSON.stringify(payload),
      spec.queueName,
      spec.maxAttempts,
      operationJobKey(spec.operationId),
    ],
  );
  return res.rows[0]?.id ?? null;
}
