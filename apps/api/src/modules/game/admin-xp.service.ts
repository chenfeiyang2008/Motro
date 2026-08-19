// 管理端 XP ledger 服务（Ticket 19）。
// 读：只读账本查询 + 用户汇总。
// 写：correction/void 均以【新 append-only xp_entries 行】表达，绝不 UPDATE/DELETE 原事实。
//   - void：插入 reason='void'、amount=-abs(target)、references_xp_entry=target 的新行；
//   - correct：插入 reason='correction'、amount=给定正负、references_xp_entry=target 的新行；
//   - 被作废/补正的目标必须是普通 award（initial_review/due_review，即 references_xp_entry IS NULL）；
//     对已有 correction/void 条目再次操作 → 409（避免连锁修改）。
//   - review_event_id 继承自目标行（NOT NULL + RESTRICT，指向原不可变 review event）。
//   - rule_version 复制目标行（绝不发明新规则版本）。
// 幂等：scope `admin:xp:{op}:{actorId}:{targetId}` + Idempotency-Key 冻结首响应。
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import type { AdminXpEntryDto, AdminXpListDto, AdminXpUserSummaryListDto } from "./game.dto.js";

interface XpRow {
  id: string;
  user_id: string;
  username: string | null;
  review_event_id: string;
  rule_version: number;
  amount: number;
  reason: string;
  references_xp_entry: string | null;
  source_event_id: string;
  earned_at: Date;
  created_at: Date;
}

function toXpEntry(row: XpRow): AdminXpEntryDto {
  const out: AdminXpEntryDto = {
    id: row.id,
    userId: row.user_id,
    reviewEventId: row.review_event_id,
    ruleVersion: Number(row.rule_version),
    amount: Number(row.amount),
    reason: row.reason,
    sourceEventId: row.source_event_id,
    earnedAt: row.earned_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
  if (row.username) out.username = row.username;
  if (row.references_xp_entry) out.referencesXpEntryId = row.references_xp_entry;
  return out;
}

@Injectable()
export class AdminXpService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** 只读账本：按时间倒序；支持 userId/kind 筛选 + keyset 分页。 */
  async list(opts: {
    userId?: string;
    kind?: string;
    cursor?: string;
    limit?: number;
  }): Promise<AdminXpListDto> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.userId) {
      params.push(opts.userId);
      where.push(`xe.user_id = $${params.length}`);
    }
    if (opts.kind) {
      const reasons = ["initial_review", "due_review", "correction", "void"];
      if (!reasons.includes(opts.kind)) {
        throw new UnprocessableEntityException({ message: "kind 非法" });
      }
      params.push(opts.kind);
      where.push(`xe.reason = $${params.length}`);
    }
    if (opts.cursor) {
      const key = decodeXpCursor(opts.cursor);
      params.push(key.createdAt, key.id);
      const last = params.length;
      where.push(`(xe.created_at, xe.id) < ($${last - 1}, $${last})`);
    }
    params.push(limit + 1);
    const sql = `
      SELECT xe.id, xe.user_id, xe.review_event_id, xe.rule_version, xe.amount, xe.reason,
             xe.references_xp_entry, xe.source_event_id, xe.earned_at, xe.created_at,
             u.username
      FROM xp_entries xe
      LEFT JOIN users u ON u.id = xe.user_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY xe.created_at DESC, xe.id DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query<XpRow>(sql, params);
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const out: AdminXpListDto = { items: pageRows.map(toXpEntry), hasMore };
    if (hasMore && last) {
      out.nextCursor = encodeXpCursor({
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }
    return out;
  }

  /** 用户 XP 汇总（供选择器）。 */
  async userSummaries(opts: { q?: string }): Promise<AdminXpUserSummaryListDto> {
    const params: unknown[] = [];
    const where: string[] = [];
    const q = (opts.q ?? "").trim();
    if (q.length > 0) {
      const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
      params.push(`%${escaped}%`);
      const idx = params.length;
      where.push(
        `(u.username ILIKE $${idx} ESCAPE '\\' OR u.display_name ILIKE $${idx} ESCAPE '\\')`,
      );
    }
    params.push(400);
    const sql = `
      SELECT u.id AS user_id, u.username, u.display_name,
             COALESCE(SUM(xe.amount) FILTER (WHERE xe.references_xp_entry IS NULL), 0)::bigint AS gross_xp,
             COALESCE(SUM(xe.amount), 0)::bigint AS net_xp,
             COALESCE(SUM(xe.amount) FILTER (WHERE xe.reason IN ('correction','void')), 0)::bigint AS adjustment_xp,
             count(xe.id)::bigint AS entry_count
      FROM users u
      LEFT JOIN xp_entries xe ON xe.user_id = u.id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY u.id, u.username, u.display_name
      ORDER BY net_xp DESC, u.username ASC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query<{
      user_id: string;
      username: string;
      display_name: string;
      gross_xp: string;
      net_xp: string;
      adjustment_xp: string;
      entry_count: string;
    }>(sql, params);
    return {
      items: result.rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        grossXp: Number(r.gross_xp),
        netXp: Number(r.net_xp),
        adjustmentXp: Number(r.adjustment_xp),
        entryCount: Number(r.entry_count),
      })),
    };
  }

  /** append-only 作废：插入负向 void 条目。 */
  async voidEntry(input: {
    actorId: string;
    targetEntryId: string;
    reason: string;
    idempotencyKey?: string;
    requestId: string;
  }): Promise<AdminXpEntryDto> {
    const reason = input.reason.trim();
    if (!reason) throw new UnprocessableEntityException({ message: "必须填写作废理由" });
    if (reason.length > 500) throw new UnprocessableEntityException({ message: "理由过长" });

    const scope = `admin:xp:void:${input.actorId}:${input.targetEntryId}`;
    const claimed = await this.claimXpIdempotency(scope, input.idempotencyKey, {
      op: "void",
      targetEntryId: input.targetEntryId,
      reason,
    });
    if (claimed !== "claimed") return claimed as AdminXpEntryDto;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await this.loadAwardEntry(client, input.targetEntryId);
      // 目标必须是普通 award（无 references）且 reason 为 initial_review/due_review。
      if (
        target.references_xp_entry !== null ||
        (target.reason !== "initial_review" && target.reason !== "due_review")
      ) {
        throw new ConflictException("只能作废一笔正向获奖的 XP 记录");
      }
      // 防止重复作废：同一目标已存在 void → 409。
      const existingVoid = await client.query(
        `SELECT id FROM xp_entries WHERE references_xp_entry = $1 AND reason = 'void' LIMIT 1`,
        [input.targetEntryId],
      );
      const existingVoidRow = existingVoid.rows[0] as { id: string } | undefined;
      if (existingVoidRow) {
        throw new ConflictException("该条目已被作废");
      }
      const amount = -Math.abs(Number(target.amount));
      const inserted = await client.query(
        `INSERT INTO xp_entries
           (user_id, review_event_id, rule_version, amount, reason, references_xp_entry, source_event_id, earned_at)
         VALUES ($1, $2, $3, $4, 'void', $5, $6, now())
         RETURNING id, user_id, review_event_id, rule_version, amount, reason, references_xp_entry, source_event_id, earned_at, created_at`,
        [
          target.user_id,
          target.review_event_id,
          target.rule_version,
          amount,
          target.id,
          randomUUID(),
        ],
      );
      const row = inserted.rows[0] as XpRow | undefined;
      if (!row) throw new Error("XP 作废条目插入失败");
      await this.audit(input.actorId, "admin.xp.void", input.targetEntryId, {
        targetEntryId: input.targetEntryId,
        amount,
        reason,
        userId: target.user_id,
      });
      await client.query("COMMIT");
      const withUsername = await this.attachUsername(client, row);
      await this.completeXpIdempotency(scope, input.idempotencyKey, withUsername);
      return withUsername;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        err instanceof ConflictException ||
        err instanceof NotFoundException ||
        err instanceof UnprocessableEntityException
      ) {
        await this.releaseXpIdempotency(scope, input.idempotencyKey);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** append-only 补正：插入 correction 条目（金额正负均可，指向目标 award）。 */
  async correctEntry(input: {
    actorId: string;
    targetEntryId: string;
    amount: number;
    reason: string;
    idempotencyKey?: string;
    requestId: string;
  }): Promise<AdminXpEntryDto> {
    if (!Number.isFinite(input.amount) || input.amount === 0) {
      throw new UnprocessableEntityException({ message: "补正金额必须为非零整数" });
    }
    if (!Number.isInteger(input.amount)) {
      throw new UnprocessableEntityException({ message: "补正金额必须为整数" });
    }
    const reason = input.reason.trim();
    if (!reason) throw new UnprocessableEntityException({ message: "必须填写补正理由" });
    if (reason.length > 500) throw new UnprocessableEntityException({ message: "理由过长" });

    const scope = `admin:xp:correct:${input.actorId}:${input.targetEntryId}`;
    const claimed = await this.claimXpIdempotency(scope, input.idempotencyKey, {
      op: "correct",
      targetEntryId: input.targetEntryId,
      amount: input.amount,
      reason,
    });
    if (claimed !== "claimed") return claimed as AdminXpEntryDto;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await this.loadAwardEntry(client, input.targetEntryId);
      if (
        target.references_xp_entry !== null ||
        (target.reason !== "initial_review" && target.reason !== "due_review")
      ) {
        throw new ConflictException("只能补正一笔正向获奖的 XP 记录");
      }
      const inserted = await client.query(
        `INSERT INTO xp_entries
           (user_id, review_event_id, rule_version, amount, reason, references_xp_entry, source_event_id, earned_at)
         VALUES ($1, $2, $3, $4, 'correction', $5, $6, now())
         RETURNING id, user_id, review_event_id, rule_version, amount, reason, references_xp_entry, source_event_id, earned_at, created_at`,
        [
          target.user_id,
          target.review_event_id,
          target.rule_version,
          input.amount,
          target.id,
          randomUUID(),
        ],
      );
      const row = inserted.rows[0] as XpRow | undefined;
      if (!row) throw new Error("XP 补正条目插入失败");
      await this.audit(input.actorId, "admin.xp.correct", input.targetEntryId, {
        targetEntryId: input.targetEntryId,
        amount: input.amount,
        reason,
        userId: target.user_id,
      });
      await client.query("COMMIT");
      const withUsername = await this.attachUsername(client, row);
      await this.completeXpIdempotency(scope, input.idempotencyKey, withUsername);
      return withUsername;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        err instanceof ConflictException ||
        err instanceof NotFoundException ||
        err instanceof UnprocessableEntityException
      ) {
        await this.releaseXpIdempotency(scope, input.idempotencyKey);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- helpers ----

  private async loadAwardEntry(
    client: { query: (q: string, p?: unknown[]) => Promise<{ rows: XpRow[] }> },
    entryId: string,
  ): Promise<XpRow> {
    const r = await client.query(
      `SELECT id, user_id, review_event_id, rule_version, amount, reason, references_xp_entry, source_event_id, earned_at, created_at
       FROM xp_entries WHERE id = $1`,
      [entryId],
    );
    const row0 = r.rows[0];
    if (!row0) throw new NotFoundException("目标 XP 记录不存在");
    return row0;
  }

  private async attachUsername(
    client: { query: (q: string, p?: unknown[]) => Promise<{ rows: XpRow[] }> },
    row: XpRow,
  ): Promise<AdminXpEntryDto> {
    const r = await client.query(`SELECT username FROM users WHERE id = $1`, [row.user_id]);
    const username = (r.rows[0] as { username: string | null } | undefined)?.username ?? null;
    return toXpEntry({ ...row, username });
  }

  private async audit(
    actorId: string,
    action: string,
    targetId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
       VALUES ($1, $2, 'xp_entry', $3, NULL, $4::jsonb, NULL)`,
      [actorId, action, targetId, JSON.stringify(after)],
    );
  }

  private async claimXpIdempotency(
    scope: string,
    key: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<unknown | "claimed"> {
    if (!key) throw new UnprocessableEntityException({ message: "缺少 Idempotency-Key 请求头" });
    const requestHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const claim = await this.pool.query<{ response_json: unknown; request_hash: string }>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, response_json)
       VALUES ($1, $2, $3, $4) ON CONFLICT (scope, key) DO NOTHING RETURNING response_json, request_hash`,
      [scope, key, requestHash, JSON.stringify({ pending: true })],
    );
    if (claim.rowCount === 0) {
      const existing = await this.pool.query<{ response_json: unknown; request_hash: string }>(
        `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      const row = existing.rows[0];
      if (!row) return null;
      if (row.request_hash !== requestHash) {
        throw new ConflictException("IDEMPOTENCY_CONFLICT：该请求键已用于不同的请求内容");
      }
      return row.response_json;
    }
    return "claimed";
  }

  private async completeXpIdempotency(
    scope: string,
    key: string | undefined,
    response: AdminXpEntryDto,
  ): Promise<void> {
    if (!key) return;
    await this.pool.query(
      `UPDATE idempotency_keys SET response_json = $3 WHERE scope = $1 AND key = $2`,
      [scope, key, JSON.stringify(response)],
    );
  }

  private async releaseXpIdempotency(scope: string, key: string | undefined): Promise<void> {
    if (!key) return;
    await this.pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
      scope,
      key,
    ]);
  }
}

// ---- cursor ----

function encodeXpCursor(key: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeXpCursor(cursor: string): { createdAt: string; id: string } {
  let parsed: { createdAt?: string; id?: string };
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: string;
      id?: string;
    };
  } catch {
    throw new UnprocessableEntityException({ message: "游标无效" });
  }
  if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
    throw new UnprocessableEntityException({ message: "游标非法" });
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}
