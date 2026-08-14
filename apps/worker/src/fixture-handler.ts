// 阶段 6 工单 04：确定性、无网络的 fixture handler，用于证明 operation 生命周期。
//
// 本 handler 不生成 Wiktionary 事实或中文草稿，不触网、不接触任何外部 URL/密钥。
// 行为由 operation 的 input_version（一个稳定、确定性的输入版本字段）决定：
//   - input_version=1：成功（真实导入投递使用 1）；
//   - input_version=2：抛 OPERATION_TRANSIENT（触发 Graphile 退避重试）；
//   - input_version=3：抛 OPERATION_PERMANENT（终止自动重试）；
//   - input_version=4：尊重 AbortSignal，收到中断即抛 OperationAbortError；
//   - input_version=5：crash-recovery 模式——持锁等待一段时间后成功，用于真实
//     Worker 停止 → lease 到期 → 重启重领恢复测试；
//   - input_version=6：长任务——运行超过默认 lease 时长（依赖心跳续租），成功后返回。
//
// 测试用不同 input_version 精确触发失败语义，同时用唯一 target id 保持互不干扰。
// 该 handler 是窄提供者缝（见 @motro/domain 的 OperationHandler）。
import type { Pool } from "pg";
import {
  OperationAbortError,
  type OperationHandler,
  type OperationHandlerRegistry,
} from "@motro/domain";

/** fixture 可见的只读投影：operation 的稳定目标与输入身份。 */
export interface FixtureOperationView {
  operationId: string;
  targetType: string;
  targetId: string;
  inputHash: string;
  inputVersion: number;
}

export const FIXTURE_TASK_IDENTIFIER = "motro-op-fixture";
export const FIXTURE_QUEUE_NAME = "local";

/** fixture 行为通过 operation 的 input_version 确定性选择（真实投递 input_version=1 → 成功）。 */
export const BEHAVIOR_INPUT_VERSION_SUCCESS = 1;
export const BEHAVIOR_INPUT_VERSION_RETRYABLE = 2;
export const BEHAVIOR_INPUT_VERSION_PERMANENT = 3;
export const BEHAVIOR_INPUT_VERSION_ABORT = 4;
export const BEHAVIOR_INPUT_VERSION_CRASH_RECOVERY = 5;
export const BEHAVIOR_INPUT_VERSION_LONG_RUNNING = 6;

/** crash-recovery fixture 的持锁时长（毫秒）：足够让 E2E 在锁内停止 worker。 */
export const CRASH_RECOVERY_HOLD_MS = 10_000;
/** 长任务时长（毫秒）：超过默认 lease（60s）依赖心跳续租；测试可用更短 lease 触发心跳。 */
export const LONG_RUNNING_HOLD_MS = 80_000;

/**
 * 构造一个本地、确定性 fixture handler。需要 db pool 以读取 operation 的目标身份
 * （始终只读稳定字段，绝不写业务事实；真正的 attempt/状态推进由 operation-executor 完成）。
 */
export function buildFixtureHandler(pool: Pool): OperationHandlerRegistry {
  const registry = new Map<string, OperationHandler>();
  const handler: OperationHandler = {
    taskIdentifier: FIXTURE_TASK_IDENTIFIER,
    async run(operationId, signal) {
      const view = await readOperationView(pool, operationId);
      switch (view.inputVersion) {
        case BEHAVIOR_INPUT_VERSION_RETRYABLE:
          if (signal?.aborted) throw new OperationAbortError();
          throw new CannotRetryError("fixture 可重试失败（本次执行确定失败，等待退避重试）");
        case BEHAVIOR_INPUT_VERSION_PERMANENT:
          if (signal?.aborted) throw new OperationAbortError();
          throw new PermanentFailureError("fixture 永久失败（任何重试都不会改变结果）");
        case BEHAVIOR_INPUT_VERSION_ABORT:
          throw new OperationAbortError();
        case BEHAVIOR_INPUT_VERSION_CRASH_RECOVERY:
          // 持锁等待：模拟 worker 在执行中崩溃（在锁内被 kill）。abort → 立即退出。
          await waitForHold(signal, CRASH_RECOVERY_HOLD_MS);
          return { outcome: "succeeded", summary: "fixture crash-recovery 成功（重领后完成）" };
        case BEHAVIOR_INPUT_VERSION_LONG_RUNNING:
          // 长任务：超过默认 lease（依赖心跳续租保持 claim）。abort（如失去 claim）→ 立即退出。
          await waitForHold(signal, LONG_RUNNING_HOLD_MS);
          return { outcome: "succeeded", summary: "fixture 长任务成功（心跳续租保持 claim）" };
        default:
          if (signal?.aborted) throw new OperationAbortError();
          return { outcome: "succeeded", summary: "fixture 成功（无供应商调用，无外部网络）" };
      }
    },
  };
  registry.set(handler.taskIdentifier, handler);
  registry.set(FIXTURE_TASK_IDENTIFIER, handler);
  return registry;
}

async function waitForHold(signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (signal?.aborted) throw new OperationAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new OperationAbortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function registryForTaskIdentifiers(registry: OperationHandlerRegistry): string[] {
  return [...registry.keys()];
}

export class CannotRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotRetryError";
    this.errorCode = "OPERATION_TRANSIENT";
  }
  readonly errorCode = "OPERATION_TRANSIENT";
}

export class PermanentFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentFailureError";
    this.errorCode = "OPERATION_PERMANENT";
  }
  readonly errorCode = "OPERATION_PERMANENT";
}

async function readOperationView(pool: Pool, operationId: string): Promise<FixtureOperationView> {
  const res = await pool.query<{
    target_type: string;
    target_id: string;
    input_hash: string;
    input_version: number;
  }>(
    `SELECT target_type, target_id, input_hash, input_version
     FROM application_operations WHERE id = $1`,
    [operationId],
  );
  const row = res.rows[0];
  if (!row) {
    return {
      operationId,
      targetType: "unknown",
      targetId: "",
      inputHash: "",
      inputVersion: 1,
    };
  }
  return {
    operationId,
    targetType: row.target_type,
    targetId: row.target_id,
    inputHash: row.input_hash,
    inputVersion: row.input_version,
  };
}
