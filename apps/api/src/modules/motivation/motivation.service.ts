import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { validateMotivationCopy } from "@motro/domain";
import { POOL } from "../../auth/database.provider.js";
import type {
  AdminMotivationCopyDto,
  AdminMotivationListDto,
  BatchCreateMotivationCopyDto,
  BatchCreateMotivationResultDto,
  CreateMotivationCopyDto,
  MotivationResponseDto,
  UpdateMotivationCopyDto,
} from "./motivation.dto.js";

const CATEGORIES = ["poetry_pun", "english_joke", "learning_wit", "encouragement"];

interface CopyRow {
  id: string;
  copy_text: string;
  category: string;
  attribution: string | null;
  is_enabled: boolean;
  created_at: Date;
  updated_at: Date;
  /** 全微秒精度的 updated_at（ISO 字符串）。pg 的 JS Date 只有毫秒精度，
   *  直接用它做 cursor 会让「同一毫秒内批量写入」的下一页丢失行（T25 修复）。 */
  updated_at_us?: string;
}

function toAdmin(row: CopyRow): AdminMotivationCopyDto {
  return {
    id: row.id,
    text: row.copy_text,
    category: row.category,
    attribution: row.attribution,
    isEnabled: row.is_enabled,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toLearner(row: CopyRow): {
  id: string;
  text: string;
  category: string;
  attribution: string | null;
} {
  return { id: row.id, text: row.copy_text, category: row.category, attribution: row.attribution };
}

/**
 * 编码 cursor。updatedAt 使用全微秒 ISO 字符串（来自 SQL to_char(...,'...US...Z')），
 * 保证「同一毫秒内批量写入」的多行可用 (updated_at, id) 正确推进（T25 修复）。
 */
function encodeCursor(row: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updatedAt, id: row.id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (typeof value.updatedAt !== "string" || typeof value.id !== "string") throw new Error();
    if (Number.isNaN(new Date(value.updatedAt).getTime())) throw new Error();
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw new BadRequestException("cursor 无效");
  }
}

@Injectable()
export class MotivationService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async getForLearner(): Promise<MotivationResponseDto> {
    const result = await this.pool.query<CopyRow>(
      `SELECT id, copy_text, category, attribution, is_enabled, created_at, updated_at
       FROM home_motivation_copies WHERE is_enabled = true ORDER BY random() LIMIT 1`,
    );
    return { message: result.rows[0] ? toLearner(result.rows[0]) : null };
  }

  async list(opts: {
    status?: string;
    category?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<AdminMotivationListDto> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.status) {
      if (!["enabled", "disabled"].includes(opts.status))
        throw new BadRequestException("status 无效");
      params.push(opts.status === "enabled");
      where.push(`is_enabled = $${params.length}`);
    }
    if (opts.category) {
      if (!CATEGORIES.includes(opts.category)) throw new BadRequestException("category 无效");
      params.push(opts.category);
      where.push(`category = $${params.length}`);
    }
    if (opts.q && opts.q.trim()) {
      params.push(`%${opts.q.trim()}%`);
      where.push(`copy_text ILIKE $${params.length}`);
    }
    if (opts.cursor) {
      const cursor = decodeCursor(opts.cursor);
      params.push(cursor.updatedAt, cursor.id);
      where.push(
        `(updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    params.push(limit + 1);
    const result = await this.pool.query<CopyRow>(
      `SELECT id, copy_text, category, attribution, is_enabled, created_at, updated_at,
              to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_us
       FROM home_motivation_copies
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toAdmin);
    const last = rows[hasMore ? limit - 1 : rows.length - 1];
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              updatedAt: last.updated_at_us ?? last.updated_at.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async create(
    actorId: string,
    requestId: string,
    dto: CreateMotivationCopyDto,
  ): Promise<AdminMotivationCopyDto> {
    const validated = validateMotivationCopy({
      text: dto.text,
      category: dto.category,
      attribution: dto.attribution ?? null,
    });
    if (!validated.ok || !validated.value) throw new BadRequestException(validated.error);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<CopyRow>(
        `INSERT INTO home_motivation_copies (copy_text, category, attribution)
         VALUES ($1, $2, $3)
         ON CONFLICT (copy_text, category) DO NOTHING
         RETURNING id, copy_text, category, attribution, is_enabled, created_at, updated_at`,
        [validated.value.text, validated.value.category, validated.value.attribution],
      );
      const row = result.rows[0];
      if (!row) throw new BadRequestException("激励文案已存在（同文案同分类）");
      await this.audit(
        client,
        actorId,
        "admin.motivation.create",
        row.id,
        null,
        toAdmin(row),
        requestId,
      );
      await client.query("COMMIT");
      return toAdmin(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createBatch(
    actorId: string,
    requestId: string,
    dto: BatchCreateMotivationCopyDto,
  ): Promise<BatchCreateMotivationResultDto> {
    const validatedItems: Array<{
      text: string;
      category: string;
      attribution: string | null;
    }> = [];
    const skippedTexts: string[] = [];
    const seen = new Set<string>();
    for (const item of dto.items) {
      const validated = validateMotivationCopy({
        text: item.text,
        category: item.category,
        attribution: item.attribution ?? null,
      });
      if (!validated.ok || !validated.value) throw new BadRequestException(validated.error);
      const key = `${validated.value.category}\u0000${validated.value.text}`;
      if (seen.has(key)) {
        if (!skippedTexts.includes(validated.value.text)) skippedTexts.push(validated.value.text);
        continue;
      }
      seen.add(key);
      validatedItems.push(validated.value);
    }

    if (validatedItems.length === 0) {
      return { items: [], createdCount: 0, skippedCount: skippedTexts.length, skippedTexts };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 请求内去重：同一请求内的重复文案只报一次 skipped。
      const dedupeKeys = new Set<string>();
      const created: AdminMotivationCopyDto[] = [];
      for (const item of validatedItems) {
        const key = `${item.category}\u0000${item.text}`;
        if (dedupeKeys.has(key)) {
          if (!skippedTexts.includes(item.text)) skippedTexts.push(item.text);
          continue;
        }
        dedupeKeys.add(key);
        // 原子冲突处理：唯一索引 (copy_text, category) + ON CONFLICT DO NOTHING。
        // 并发请求 / 已有记录 → DO NOTHING RETURNING 空行 → 计 skipped。
        const result = await client.query<CopyRow>(
          `INSERT INTO home_motivation_copies (copy_text, category, attribution)
           VALUES ($1, $2, $3)
           ON CONFLICT (copy_text, category) DO NOTHING
           RETURNING id, copy_text, category, attribution, is_enabled, created_at, updated_at`,
          [item.text, item.category, item.attribution],
        );
        const row = result.rows[0];
        if (!row) {
          if (!skippedTexts.includes(item.text)) skippedTexts.push(item.text);
          continue;
        }
        const after = toAdmin(row);
        await this.audit(
          client,
          actorId,
          "admin.motivation.create",
          row.id,
          null,
          after,
          requestId,
        );
        created.push(after);
      }
      await client.query("COMMIT");
      return {
        items: created,
        createdCount: created.length,
        skippedCount: skippedTexts.length,
        skippedTexts,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    actorId: string,
    requestId: string,
    id: string,
    dto: UpdateMotivationCopyDto,
  ): Promise<AdminMotivationCopyDto> {
    const current = await this.pool.query<CopyRow>(
      `SELECT id, copy_text, category, attribution, is_enabled, created_at, updated_at FROM home_motivation_copies WHERE id = $1`,
      [id],
    );
    const before = current.rows[0];
    if (!before) throw new NotFoundException("激励文案不存在");
    const validated = validateMotivationCopy({
      text: dto.text ?? before.copy_text,
      category: dto.category ?? before.category,
      attribution: dto.attribution === undefined ? before.attribution : dto.attribution,
    });
    if (!validated.ok || !validated.value) throw new BadRequestException(validated.error);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<CopyRow>(
        `UPDATE home_motivation_copies
         SET copy_text = $2, category = $3, attribution = $4,
             is_enabled = COALESCE($5, is_enabled), updated_at = now()
         WHERE id = $1
         RETURNING id, copy_text, category, attribution, is_enabled, created_at, updated_at`,
        [
          id,
          validated.value.text,
          validated.value.category,
          validated.value.attribution,
          dto.isEnabled ?? null,
        ],
      );
      const after = result.rows[0];
      if (!after) throw new Error("激励文案更新失败");
      await this.audit(
        client,
        actorId,
        "admin.motivation.update",
        id,
        toAdmin(before),
        toAdmin(after),
        requestId,
      );
      await client.query("COMMIT");
      return toAdmin(after);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    action: string,
    targetId: string,
    before: unknown,
    after: unknown,
    requestId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
       VALUES ($1, $2, 'home_motivation_copy', $3, $4::jsonb, $5::jsonb, $6)`,
      [
        actorId,
        action,
        targetId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        requestId,
      ],
    );
  }
}
