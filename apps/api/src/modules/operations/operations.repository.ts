// 阶段 6 工单 04：operation/attempt 读仓库。
// 只返回安全投影（不泄露 Graphile payload、storage key、路径、秘密或完整异常）。
import { Inject, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import { isRetryEligible, type OperationStatus } from "@motro/domain";
import type {
  OperationAttemptSummaryDto,
  OperationDetailDto,
  OperationListResponseDto,
  OperationSummaryDto,
} from "./operations.dto.js";

interface OperationRow {
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
}

interface AttemptRow {
  id: string;
  attempt_number: number;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  error_code: string | null;
  error_summary: string | null;
}

const OPERATION_SELECT = `
  SELECT id, operation_type, operation_version, target_type, target_id, input_version,
         status, attempt_count, max_attempts, retryable,
         last_error_code, last_error_summary, created_at, updated_at, started_at, completed_at
  FROM application_operations`;

const LIST_LIMIT = 20;

export class OperationRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** 游标分页 + 安全 status/type/errorCode 过滤。cursor 编码为 (created_at, id) 复合键（base64url）。 */
  async list(opts: {
    status?: string;
    operationType?: string;
    targetType?: string;
    errorCode?: string;
    cursor?: string;
    limit?: number;
  }): Promise<OperationListResponseDto> {
    const limit = Math.min(Math.max(opts.limit ?? LIST_LIMIT, 1), 50);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(opts.status);
    }
    if (opts.operationType) {
      conditions.push(`operation_type = $${paramIdx++}`);
      params.push(opts.operationType);
    }
    if (opts.targetType) {
      conditions.push(`target_type = $${paramIdx++}`);
      params.push(opts.targetType);
    }
    if (opts.errorCode) {
      conditions.push(`last_error_code = $${paramIdx++}`);
      params.push(opts.errorCode);
    }

    let cursorTime: string | undefined;
    let cursorId: string | undefined;
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (decoded) {
        cursorTime = decoded.time;
        cursorId = decoded.id;
      } else {
        // 非法游标 → 结构化 400（由 controller 捕获）。
        throw new InvalidCursorError();
      }
    }

    if (cursorTime && cursorId) {
      conditions.push(`(created_at, id) < ($${paramIdx}::timestamptz, $${paramIdx + 1}::uuid)`);
      params.push(cursorTime, cursorId);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<OperationRow>(
      `${OPERATION_SELECT}${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`,
      params,
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeCursor(pageRows[pageRows.length - 1]!.created_at, pageRows[pageRows.length - 1]!.id)
        : null;

    return {
      items: pageRows.map((r) => toSummary(r)),
      hasMore,
      ...(nextCursor !== null ? { nextCursor } : {}),
    };
  }

  /** 单个 operation 概要。非法 UUID → 由 controller 的 ParseUUIDPipe 拒绝；此处不存在 → 404。 */
  async getSummary(id: string): Promise<OperationSummaryDto> {
    const res = await this.pool.query<OperationRow>(`${OPERATION_SELECT} WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) throw new NotFoundException("操作不存在");
    return toSummary(row);
  }

  /** operation + attempt 时间线。 */
  async getDetail(id: string): Promise<OperationDetailDto> {
    const op = await this.getSummary(id);
    const attempts = await this.pool.query<AttemptRow>(
      `SELECT id, attempt_number, started_at, finished_at, outcome, error_code, error_summary
       FROM application_operation_attempts
       WHERE operation_id = $1
       ORDER BY attempt_number DESC`,
      [id],
    );
    return {
      operation: op,
      attempts: attempts.rows.map((a) => ({
        id: a.id,
        attemptNumber: a.attempt_number,
        startedAt: a.started_at.toISOString(),
        ...(a.finished_at ? { finishedAt: a.finished_at.toISOString() } : {}),
        ...(a.outcome ? { outcome: a.outcome } : {}),
        ...(a.error_code ? { errorCode: a.error_code } : {}),
        ...(a.error_summary ? { errorSummary: a.error_summary } : {}),
      })) satisfies OperationAttemptSummaryDto[],
    };
  }

  /** 供重试命令：读取 operation 行，供状态校验与幂等。 */
  async getForRetry(id: string): Promise<OperationRow & { status: string }> {
    const res = await this.pool.query<OperationRow>(`${OPERATION_SELECT} WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) throw new NotFoundException("操作不存在");
    return row;
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super("游标无效");
    this.name = "InvalidCursorError";
  }
}

export function decodeCursor(cursor: string): { time: string; id: string } | null {
  let json: unknown;
  try {
    const buf = Buffer.from(cursor, "base64url");
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  const rec = json as { t?: unknown; id?: unknown } | null;
  if (!rec || typeof rec.t !== "string" || typeof rec.id !== "string") return null;
  if (Number.isNaN(new Date(rec.t).getTime())) return null;
  return { time: rec.t, id: rec.id };
}

export function encodeCursor(time: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: time.toISOString(), id }), "utf8").toString("base64url");
}

/** 目标 ID 安全摘要：只暴露 UUID 前 8 位，避免把完整目标标识当作展示内容。 */
function safeTargetId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function toSummary(row: OperationRow): OperationSummaryDto {
  const status = row.status;
  return {
    id: row.id,
    operationType: row.operation_type,
    operationVersion: row.operation_version,
    targetType: row.target_type,
    targetId: safeTargetId(row.target_id),
    inputVersion: row.input_version,
    status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    retryable: row.retryable,
    canRetry: isRetryEligible(status as OperationStatus),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_summary ? { lastErrorSummary: row.last_error_summary } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
  };
}
