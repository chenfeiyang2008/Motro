// 阶段 6 工单 04 关键修复：显式 TypeScript task list —— 真实 Graphile task 入口。
//
// 每个任务入口必须严格校验 payload：
//   - 只有 validateOperationPayload 通过（operationId 为 UUID、inputVersion 为正整数、
//     无额外字段、无敏感字段）才执行 handler；
//   - 校验 payload.inputVersion 与 operation 权威 input_version 一致；
//   - 非法 payload：不执行 handler、不创建业务 attempt（claim 未发生），
//     直接把 operation 置为 failed 终态（OPERATION_INVALID_PAYLOAD），
//     同时抛错让 Graphile 标记 job 永久失败（permanently-failed）。
//     若 operation 不存在，抛错让 Graphile 处理（不伪造业务 operation）。
import type { Pool } from "pg";
import type { Task, TaskList } from "graphile-worker";
import {
  type OperationHandlerRegistry,
  isValidTaskIdentifier,
  safeErrorSummary,
  type PayloadValidationResult,
  validateOperationPayload,
} from "@motro/domain";
import { executeWithAbort } from "./operation-executor.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 非法 payload 的固定错误码：把验证结果代码映射为稳定的、不含用户可控字段名的错误码。
 * 用户传入的任何字段名/值都绝不进入错误消息或 Graphile 日志，防止日志伪造与字段名泄漏。
 */
function safePayloadErrorCode(parsed: Extract<PayloadValidationResult, { ok: false }>): string {
  const mapping: Record<Extract<PayloadValidationResult, { ok: false }>["code"], string> = {
    BAD_TYPE: "INVALID_TASK_PAYLOAD_BAD_TYPE",
    INVALID_UUID: "INVALID_TASK_PAYLOAD_INVALID_UUID",
    EXTRA_FIELD: "INVALID_TASK_PAYLOAD_UNKNOWN_FIELD",
    SENSITIVE_FIELD: "INVALID_TASK_PAYLOAD_UNKNOWN_FIELD",
  } as const;
  return mapping[parsed.code] ?? "INVALID_TASK_PAYLOAD_UNKNOWN_FIELD";
}

/**
 * 固定、不含用户字段名的非法 payload 诊断消息，用于 Graphile 错误日志。
 * 不含 \r\n / 控制字符 / ANSI escape / 用户输入片段，防止日志行伪造。
 */
function safePayloadErrorMessage(code: string): string {
  switch (code) {
    case "INVALID_TASK_PAYLOAD_UNKNOWN_FIELD":
      return "invalid task payload: rejected (unknown or disallowed field)";
    case "INVALID_TASK_PAYLOAD_INVALID_UUID":
      return "invalid task payload: operationId is not a valid UUID";
    case "INVALID_TASK_PAYLOAD_BAD_TYPE":
      return "invalid task payload: payload is not a valid object";
    default:
      return "invalid task payload: rejected";
  }
}

export function buildTaskList(
  pool: Pool,
  registry: OperationHandlerRegistry,
  leaseMs = 60_000,
): TaskList {
  // 通用任务主体：对 payload 做严格校验（仅 opaque operationId + inputVersion），
  // 再执行对应 handler。所有富集/审核 task 共用同一校验语义。
  const task: Task = async (payload, helpers) => {
    const parsed = validateOperationPayload(payload);
    if (!parsed.ok) {
      // 非法 payload：尝试把 operation 置为 failed 终态；operation 不存在则只抛错。
      // 从原始 payload 提取 operationId（若为合法 UUID 字符串），用于终态写入。
      const rawId =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)["operationId"]
          : undefined;
      const opIdForFail = typeof rawId === "string" && UUID_PATTERN.test(rawId) ? rawId : null;
      const parsedCode = safePayloadErrorCode(parsed);
      // failInvalidPayload：使用固定安全文案，绝不把 parsed.message（含字段名原文）
      // 传入 safeErrorSummary 或日志——防止控制字符/ANSI escape 伪造日志行。
      await failInvalidPayload(pool, opIdForFail);
      // 抛出的 Error.message 使用固定安全文案：Graphile 会把它写入 jobs.last_error
      // 和 worker 日志，必须保证无用户可控片段。
      throw new Error(safePayloadErrorMessage(parsedCode) + "（未执行 handler）");
    }
    const { operationId, inputVersion } = parsed.payload;
    // payload.inputVersion 必须与 operation 权威 input_version 一致。
    const authoritative = await pool.query<{ input_version: number; status: string }>(
      `SELECT input_version, status FROM application_operations WHERE id = $1`,
      [operationId],
    );
    const row = authoritative.rows[0];
    if (!row) {
      // operation 不存在：不伪造业务 operation，只抛错让 Graphile 标记 job 永久失败。
      throw new Error("invalid task payload: operation not found（未执行 handler）");
    }
    if (row.input_version !== inputVersion) {
      await failInvalidPayload(pool, operationId);
      throw new Error("invalid task payload: inputVersion mismatch（未执行 handler）");
    }
    // 合法 payload → 执行（lease-based claim 在 executeWithAbort 内完成）。
    await executeWithAbort(pool, registry, operationId, helpers.job.id, helpers.abortSignal, {
      leaseMs,
    });
  };

  // 为 registry 中每个已注册 task identifier 注册一个 entry。
  // worker-runtime 的 buildHandlerRegistry 已保证同一 task id 在 registry 中是唯一的，
  // 且覆盖 fixture + wiktionary + deepseek（fake|real）。用 isValidTaskIdentifier 守卫，
  // 杜绝非法 identifier 进入 Graphile task 列表。
  const result: TaskList = {};
  for (const taskId of registry.keys()) {
    if (!isValidTaskIdentifier(taskId)) continue;
    result[taskId] = task;
  }
  return result;
}

/**
 * 非法 payload 的终态写入：当 operation 存在且状态尚未被 claim（非 running/succeeded），
 * 在事务内把它置为 failed 终态（OPERATION_INVALID_PAYLOAD），retryable=false，completed_at 非空。
 * 若 operation 已被 claim（running）或已终态，则 no-op（不覆盖已有 claim/终态）。
 * 数据库写入失败必须向上抛出：吞掉失败会让 operation 继续显示 queued，却把 Graphile 的
 * job 失败误当作权威业务终态。
 *
 * 错误摘要使用固定安全文案（safeErrorSummary → "任务载荷无效"），绝不携带用户字段名原文。
 */
async function failInvalidPayload(pool: Pool, operationId: string | null): Promise<void> {
  if (!operationId) return;
  await pool.query(
    `UPDATE application_operations
     SET status = 'failed', retryable = false,
         last_error_code = 'OPERATION_INVALID_PAYLOAD',
         last_error_summary = $2,
         completed_at = now(),
         claim_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'retry_wait')`,
    // last_error_summary 使用 safeErrorSummary，该函数对 OPERATION_INVALID_PAYLOAD 返回
    // 固定文案"任务载荷无效"，不依赖 errorCode 参数值——保证无论传入什么都是安全的。
    [operationId, safeErrorSummary("OPERATION_INVALID_PAYLOAD")],
  );
}
