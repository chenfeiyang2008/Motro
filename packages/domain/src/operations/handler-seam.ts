// 阶段 6 工单 04：Worker handler 窄接口缝。
//
// 本文件定义 operation handler 的最小契约：Worker 只按 operation ID 执行 handler，
// handler 负责读取权威目标、执行确定性业务（本票为 fixture）、并返回一个稳定结果。
//
// 工单 05/06 只需在此 seam 注入 Wiktionary/DeepSeek provider adapter，而无需重新设计
// 队列、operation、attempt、重试、审计、状态 API 或管理 UI。
// 本 seam 不携带任何供应商 payload、秘密、路径或完整异常堆栈。

export interface OperationHandlerResult {
  /** 稳定、脱敏、受限长度的结果摘要（写入 attempt 投影；绝不包含供应商正文或秘密）。 */
  outcome: "succeeded" | "failed";
  /** 供 attempt 记录的可读摘要（脱敏）。 */
  summary: string;
  /** 0-255 的稳定失败码（retryable 判定由调用方经 classifyError 决定）。 */
  errorCode?: string;
}

/**
 * operation handler 契约。实现必须是确定性的、无网络的（本票 fixture）；
 * 工单 05/06 的 provider adapter 也遵循同一契约。
 * `signal` 可选：worker 优雅关闭或超时/abort 时调用方传入以协调取消。
 */
export interface OperationHandler {
  /** 唯一低基数 task identifier（可打印 ASCII，禁 UUID）。 */
  readonly taskIdentifier: string;
  /**
   * 执行一次 operation 的真实业务意图。必须以 operationId 为权威依据，
   * 在写入前由调用方完成 claim；返回结果或抛出可分类错误。
   */
  run(operationId: string, signal?: AbortSignal): Promise<OperationHandlerResult>;
}

/** 抛给 handler 的确定性问题标记：用于触发可重试/永久/取消路径。 */
export class OperationAbortError extends Error {
  constructor(message = "operation aborted") {
    super(message);
    this.name = "OperationAbortError";
    this.errorCode = "OPERATION_ABORTED";
  }
  readonly errorCode = "OPERATION_ABORTED";
}

/** handler registry：taskIdentifier → handler。由显式 TypeScript 列表构造。 */
export type OperationHandlerRegistry = ReadonlyMap<string, OperationHandler>;
