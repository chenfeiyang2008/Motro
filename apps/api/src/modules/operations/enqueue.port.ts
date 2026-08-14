// 阶段 6 工单 04：窄 enqueue port —— import commit 模块只能依赖这个接口投递后台操作。
//
// 调用方（import commit service）只需要知道：
//   在既有业务事务内，为一个稳定 commit row 创建/取得 application operation，
//   并在同一 PostgreSQL 事务调用公共 graphile_worker.add_job(...)。
// 任何失败都会随业务事务一起回滚（绝对禁止提交后 setTimeout / fire-and-forget）。
//
// 本 port 不向调用方暴露 Graphile 私有 schema；worker 内部实现只在 operations 模块与
// worker 进程可见。job key 含 operation UUID 但带固定 Motro/任务命名空间；jobKey 不是
// 唯一幂等防线（应用 UNIQUE + operation 状态机才是最终事实）。
import type { PoolClient } from "pg";

export interface EnqueueOperationInput {
  /** operation 类型（低基数 ASCII task identifier）。 */
  operationType: string;
  /** 目标类型（本票固定 import_batch_commit_row）。 */
  targetType: string;
  /** 稳定目标 ID（commit row id）。 */
  targetId: string;
  /** input 版本（内容版本；决定是否复用既有 operation）。 */
  inputVersion: number;
  /** 输入身份 hash（同一 operation_type+target+input 唯一）。 */
  inputHash: string;
  /** 提交者（审计字段）。 */
  requestedBy: string;
  /** 队列名（低基数 ASCII，禁 UUID）。 */
  queueName: string;
  /** 最大尝试次数（来自 worker 配置）。 */
  maxAttempts: number;
}

export interface EnqueueOperationResult {
  /** 已存在（同 identity 复用）还是新建。 */
  created: boolean;
  operationId: string;
}

export interface OperationEnqueuePort {
  /**
   * 在传入的业务事务 client 上创建/取得 operation 并原子投递 Graphile job。
   * 返回 null 表示 add_job 返回空（job key 高争用冲突）——调用方必须回滚。
   */
  enqueueInTransaction(
    client: PoolClient,
    input: EnqueueOperationInput,
  ): Promise<EnqueueOperationResult | null>;
}
