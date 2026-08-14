// 阶段 6 工单 04：任务状态管理 API DTO。
// 绝不返回 Graphile payload、私有表字段、storage key、物理路径、秘密或完整异常堆栈。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class OperationAttemptSummaryDto {
  @ApiProperty({ description: "attempt ID" })
  id!: string;

  @ApiProperty({ description: "attempt 编号（从 1 递增）" })
  attemptNumber!: number;

  @ApiProperty({ description: "开始时间（RFC 3339 UTC）" })
  startedAt!: string;

  @ApiPropertyOptional({ description: "结束时间（RFC 3339 UTC）" })
  finishedAt?: string;

  @ApiPropertyOptional({ description: "结果（succeeded/failed；运行中为空）" })
  outcome?: string;

  @ApiPropertyOptional({ description: "脱敏错误码" })
  errorCode?: string;

  @ApiPropertyOptional({ description: "脱敏错误摘要（受限长度，无堆栈/供应商 payload）" })
  errorSummary?: string;
}

export class OperationSummaryDto {
  @ApiProperty({ description: "operation ID" })
  id!: string;

  @ApiProperty({ description: "操作类型" })
  operationType!: string;

  @ApiProperty({ description: "操作版本" })
  operationVersion!: number;

  @ApiProperty({ description: "目标类型" })
  targetType!: string;

  @ApiProperty({ description: "目标 ID（安全摘要：UUID 前 8 位 + …）" })
  targetId!: string;

  @ApiProperty({ description: "输入版本" })
  inputVersion!: number;

  @ApiProperty({ description: "状态（queued/running/retry_wait/succeeded/failed/manual_action）" })
  status!: string;

  @ApiProperty({ description: "尝试次数" })
  attemptCount!: number;

  @ApiProperty({ description: "最大尝试次数" })
  maxAttempts!: number;

  @ApiProperty({ description: "是否仍可自动重试" })
  retryable!: boolean;

  @ApiProperty({ description: "是否允许管理员重试（failed/manual_action 为 true）" })
  canRetry!: boolean;

  @ApiPropertyOptional({ description: "脱敏最近错误码" })
  lastErrorCode?: string;

  @ApiPropertyOptional({ description: "脱敏最近错误摘要" })
  lastErrorSummary?: string;

  @ApiProperty({ description: "创建时间（RFC 3339 UTC）" })
  createdAt!: string;

  @ApiProperty({ description: "最近更新时间（RFC 3339 UTC）" })
  updatedAt!: string;

  @ApiPropertyOptional({ description: "开始时间（RFC 3339 UTC）" })
  startedAt?: string;

  @ApiPropertyOptional({ description: "完成时间（RFC 3339 UTC）" })
  completedAt?: string;
}

export class OperationListResponseDto {
  @ApiProperty({
    description: "游标分页结果",
    type: () => OperationSummaryDto,
    isArray: true,
  })
  items!: OperationSummaryDto[];

  @ApiPropertyOptional({ description: "下一页游标；null 表示无更多" })
  nextCursor?: string;
}

export class OperationDetailDto {
  @ApiProperty({ description: "operation 概要", type: () => OperationSummaryDto })
  operation!: OperationSummaryDto;

  @ApiProperty({
    description: "attempt 时间线（新→旧）",
    type: () => OperationAttemptSummaryDto,
    isArray: true,
  })
  attempts!: OperationAttemptSummaryDto[];
}

export class OperationRetryResultDto {
  @ApiProperty({ description: "重试后的 operation 概要" })
  operation!: OperationSummaryDto;

  @ApiProperty({ description: "是否幂等重放（同 Idempotency-Key 已重试过）" })
  isIdempotentReplay!: boolean;
}

export class OperationRetryDto {
  @ApiProperty({ description: "重试确认载荷（显式确认）", required: true })
  confirm!: boolean;
}
