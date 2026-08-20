// Ticket 20 · membership service: admin grant/renew/revoke (permission + idempotency +
// append-only audit) and server-side effective status + daily-usage accounting.
// Membership is fully separate from users.role, XP, and daily_budget_minutes.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  effectiveEntitlement,
  FREE_DAILY_LIMIT_MINUTES,
  type MembershipProjection,
} from "@motro/domain";
import { localDayKey } from "@motro/domain";
import { POOL } from "../../auth/database.provider.js";
import type { UserRecord } from "../../auth/session.service.js";

/** 免费用户每日有效学习时长已达上限。→ 409 DAILY_USAGE_LIMIT_REACHED。 */
export class DailyUsageLimitError extends Error {
  constructor(
    readonly usedMinutes: number,
    readonly limitMinutes: number,
    readonly resetDay: string,
  ) {
    super("今日学习时长已达上限，请明天继续。");
    this.name = "DailyUsageLimitError";
  }
}

export interface MembershipRow {
  user_id: string;
  plan: "member" | "free";
  status: "active" | "expired";
  started_at: Date;
  expires_at: Date | null;
  timezone: string;
  last_action: "grant" | "renew" | "revoke";
  created_at: Date;
  free_daily_limit_minutes: number;
}

/** Admin read projection: MembershipProjection + per-user free daily limit for direct display. */
export interface AdminMembershipReadProjection extends MembershipProjection {
  dailyLimitMinutes: number;
}

export interface DailyUsageSummary {
  usedMinutes: number;
  limitMinutes: number;
  resetDay: string; // YYYY-MM-DD local-day boundary
  membershipStatus: "member" | "free";
}

export interface MembershipScheduleInput {
  mode?: "duration" | "until" | "indefinite" | undefined;
  durationDays?: number | undefined;
  expiresAt?: string | null | undefined;
}

const ADMIN_MEMBERSHIP_DEFAULT_LIMIT = 50;
const ADMIN_MEMBERSHIP_MAX_LIMIT = 50;
const MEMBERSHIP_CURSOR_VERSION = "motro.admin.membership.v1";

type MembershipListState = "free" | "member" | "expired";

interface MembershipCursor {
  v: string;
  sortAt: string;
  userId: string;
  q: string;
  state: MembershipListState | "";
}

@Injectable()
export class MembershipService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** Load the user's membership row (or null). */
  private async loadMembership(userId: string): Promise<MembershipRow | null> {
    const r = await this.pool.query<MembershipRow>(
      `SELECT user_id, plan, status, started_at, expires_at, timezone, last_action, created_at
              , free_daily_limit_minutes
       FROM memberships WHERE user_id = $1`,
      [userId],
    );
    return r.rows[0] ?? null;
  }

  /** Load the user's timezone (fallback boundary source). */
  private async loadUserTimezone(userId: string): Promise<string> {
    const r = await this.pool.query<{ timezone: string }>(
      `SELECT timezone FROM users WHERE id = $1`,
      [userId],
    );
    return r.rows[0]?.timezone ?? "Asia/Shanghai";
  }

  /** Effective membership projection for /auth/me. Fail-closed → free. */
  async getMembershipProjection(userId: string, now = new Date()): Promise<MembershipProjection> {
    const row = await this.loadMembership(userId);
    if (row === null) {
      return { plan: "free", status: "free", expiresAt: null };
    }
    const entitlement = effectiveEntitlement(
      {
        plan: row.plan,
        status: row.status,
        startedAt: row.started_at.toISOString(),
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      },
      now,
    );
    return {
      plan: row.plan,
      status: entitlement.kind === "member" ? "member" : "free",
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    };
  }

  /**
   * Admin: read a user's membership projection (admin-only via RolesGuard).
   * Same server-computed source as /me/membership; returns raw expiresAt so the
   * admin UI can distinguish 已过期 (member with past expiry) from 免费, plus the
   * user's per-day free budget for direct display in the management table.
   */
  async getMembershipForUser(
    userId: string,
    now = new Date(),
  ): Promise<AdminMembershipReadProjection> {
    const row = await this.loadMembership(userId);
    const projection = await this.getMembershipProjection(userId, now);
    return {
      ...projection,
      dailyLimitMinutes: row?.free_daily_limit_minutes ?? FREE_DAILY_LIMIT_MINUTES,
    };
  }

  private encodeMembershipCursor(cursor: Omit<MembershipCursor, "v">): string {
    return Buffer.from(
      JSON.stringify({ v: MEMBERSHIP_CURSOR_VERSION, ...cursor }),
      "utf8",
    ).toString("base64url");
  }

  private decodeMembershipCursor(value: string | undefined): MembershipCursor | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      ) as MembershipCursor;
      if (
        parsed.v !== MEMBERSHIP_CURSOR_VERSION ||
        !parsed.sortAt ||
        !parsed.userId ||
        typeof parsed.q !== "string" ||
        !["", "free", "member", "expired"].includes(parsed.state)
      ) {
        throw new Error("invalid cursor");
      }
      return parsed;
    } catch {
      throw new UnprocessableEntityException("游标无效，请重新加载列表");
    }
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
  }

  /** Admin table projection. One parameterized aggregate query avoids N+1 membership reads. */
  async listMemberships(options: {
    q?: string;
    state?: MembershipListState;
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: Array<{
      userId: string;
      username: string;
      displayName: string;
      role: "learner" | "admin";
      accountStatus: "active" | "disabled";
      state: MembershipListState;
      plan: "free" | "member";
      startedAt: string | null;
      expiresAt: string | null;
      lastAction: "grant" | "renew" | "revoke" | null;
      dailyLimitMinutes: number;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const limit = Math.min(
      Math.max(options.limit ?? ADMIN_MEMBERSHIP_DEFAULT_LIMIT, 1),
      ADMIN_MEMBERSHIP_MAX_LIMIT,
    );
    const q = (options.q ?? "").trim();
    const state = options.state ?? "";
    const cursor = this.decodeMembershipCursor(options.cursor);
    if (cursor && (cursor.q !== q || cursor.state !== state)) {
      throw new UnprocessableEntityException("筛选条件已变化，请从第一页开始");
    }

    const values: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (q) {
      const qParam = add(`%${this.escapeLikePattern(q)}%`);
      where.push(
        `(u.username ILIKE ${qParam} ESCAPE '\\' OR u.display_name ILIKE ${qParam} ESCAPE '\\')`,
      );
    }
    const stateExpression = `CASE
      WHEN m.user_id IS NULL OR m.plan = 'free' THEN 'free'
      WHEN m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > now()) THEN 'member'
      ELSE 'expired'
    END`;
    if (state) where.push(`${stateExpression} = ${add(state)}`);
    if (cursor) {
      const sortAtParam = add(cursor.sortAt);
      const userIdParam = add(cursor.userId);
      where.push(`(COALESCE(m.updated_at, u.created_at) < ${sortAtParam}
        OR (COALESCE(m.updated_at, u.created_at) = ${sortAtParam} AND u.id > ${userIdParam}))`);
    }
    const limitParam = add(limit + 1);
    const result = await this.pool.query<{
      user_id: string;
      username: string;
      display_name: string;
      role: "learner" | "admin";
      account_status: "active" | "disabled";
      state: MembershipListState;
      plan: "free" | "member";
      started_at: Date | null;
      expires_at: Date | null;
      last_action: "grant" | "renew" | "revoke" | null;
      sort_at: Date;
      free_daily_limit_minutes: number;
    }>(
      `SELECT u.id AS user_id, u.username, u.display_name, u.role,
              u.status AS account_status, ${stateExpression} AS state,
              COALESCE(m.plan, 'free') AS plan, m.started_at, m.expires_at,
              m.last_action, COALESCE(m.free_daily_limit_minutes, 15) AS free_daily_limit_minutes,
              COALESCE(m.updated_at, u.created_at) AS sort_at
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(m.updated_at, u.created_at) DESC, u.id ASC
        LIMIT ${limitParam}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const items = rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      accountStatus: row.account_status,
      state: row.state,
      plan: row.plan,
      startedAt: row.started_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      lastAction: row.last_action,
      dailyLimitMinutes: Number(row.free_daily_limit_minutes),
    }));
    const last = rows.at(-1);
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last
          ? this.encodeMembershipCursor({
              sortAt: last.sort_at.toISOString(),
              userId: last.user_id,
              q,
              state,
            })
          : null,
    };
  }

  private resolveSchedule(
    input: MembershipScheduleInput,
    now: Date,
    currentExpiresAt?: Date | null,
  ): string | null {
    // Ticket 20 accepted an explicit expiresAt (including a past timestamp) so
    // existing automation can deliberately create an expired membership. Keep
    // that compatibility path; new `mode: until` requests are fail-closed.
    if (input.mode === undefined && input.expiresAt !== undefined) {
      return input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
    }
    const mode =
      input.mode ??
      (input.expiresAt === null || input.expiresAt === undefined ? "indefinite" : "until");
    if (mode === "indefinite") return null;
    if (mode === "duration") {
      if (
        !Number.isInteger(input.durationDays) ||
        input.durationDays! < 1 ||
        input.durationDays! > 3650
      ) {
        throw new UnprocessableEntityException("会员时长必须是 1 至 3650 天");
      }
      const base =
        currentExpiresAt && currentExpiresAt.getTime() > now.getTime() ? currentExpiresAt : now;
      return new Date(base.getTime() + input.durationDays! * 86_400_000).toISOString();
    }
    if (!input.expiresAt) throw new UnprocessableEntityException("请提供会员到期时间");
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      throw new UnprocessableEntityException("会员到期时间必须晚于当前时间");
    }
    if (currentExpiresAt && currentExpiresAt.getTime() > expiresAt.getTime()) {
      throw new UnprocessableEntityException("续期到期时间不能早于当前有效到期时间");
    }
    return expiresAt.toISOString();
  }

  /**
   * Daily usage summary: accrued accepted-minutes for the user's current local
   * day + the effective limit.  Member → limit Infinity. Fail-closed → 15.
   */
  async getDailyUsageSummary(userId: string, now = new Date()): Promise<DailyUsageSummary> {
    const memberships = await this.loadMembership(userId);
    const tz = await this.loadUserTimezone(userId);
    const resetDay = localDayKey(now, tz);
    const entitlement = effectiveEntitlement(
      memberships
        ? {
            plan: memberships.plan,
            status: memberships.status,
            startedAt: memberships.started_at.toISOString(),
            expiresAt: memberships.expires_at ? memberships.expires_at.toISOString() : null,
          }
        : null,
      now,
    );
    const limitMinutes =
      entitlement.kind === "member"
        ? Number.POSITIVE_INFINITY
        : (memberships?.free_daily_limit_minutes ?? FREE_DAILY_LIMIT_MINUTES);

    let usedMinutes = 0;
    if (Number.isFinite(limitMinutes)) {
      const used = await this.pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(minutes_accrued), 0)::text AS total
         FROM daily_usage WHERE user_id = $1 AND local_day = $2`,
        [userId, resetDay],
      );
      usedMinutes = Number(used.rows[0]?.total ?? 0);
    }

    return {
      usedMinutes,
      limitMinutes,
      resetDay,
      membershipStatus: entitlement.kind === "member" ? "member" : "free",
    };
  }

  /**
   * Enforce the daily study-time limit before a NEW accepted learning activity
   * can be recorded.  Throws when a free user is already at/over the limit.
   * Members and not-yet-reached free users pass through.
   */
  async assertCanAccrue(userId: string, now = new Date()): Promise<DailyUsageSummary> {
    const summary = await this.getDailyUsageSummary(userId, now);
    if (summary.membershipStatus === "member") return summary;
    if (summary.usedMinutes >= summary.limitMinutes) {
      throw new DailyUsageLimitError(summary.usedMinutes, summary.limitMinutes, summary.resetDay);
    }
    return summary;
  }

  /**
   * Record an accepted review event's accrued minutes (immutable, idempotent per
   * review_event).  Must be called AFTER the review event row exists, inside the
   * same transaction as the review commit.  Returns nothing.
   */
  async recordAccruedMinutes(
    client: Pick<Pool, "query">,
    userId: string,
    reviewEventId: string,
    clientEventId: string,
    accruedMinutes: number,
    now = new Date(),
  ): Promise<void> {
    const tz =
      (
        await client.query<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [
          userId,
        ])
      ).rows[0]?.timezone ?? "Asia/Shanghai";
    const localDay = localDayKey(now, tz);
    await client.query(
      `INSERT INTO daily_usage
         (user_id, local_day, review_event_id, source_event_id, source_type,
          minutes_accrued, accrued_at)
       VALUES ($1, $2, $3, $4, 'review', $5, $6)
       ON CONFLICT (user_id, review_event_id) DO NOTHING`,
      [userId, localDay, reviewEventId, clientEventId, accruedMinutes, now],
    );
  }

  /**
   * Record challenge answer participation toward the daily study-time budget.
   * Each accepted challenge answer accrues 1 minute (same as a study review).
   * Idempotent per (user_id, challenge_answer_id) via partial unique index.
   */
  async recordChallengeMinutes(
    client: Pick<Pool, "query">,
    userId: string,
    challengeAnswerId: string,
    accruedMinutes: number,
    now = new Date(),
  ): Promise<void> {
    const tz =
      (
        await client.query<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [
          userId,
        ])
      ).rows[0]?.timezone ?? "Asia/Shanghai";
    const localDay = localDayKey(now, tz);
    await client.query(
      `INSERT INTO daily_usage
         (user_id, local_day, challenge_answer_id, source_event_id, source_type,
          minutes_accrued, accrued_at)
       VALUES ($1, $2, $3, $4, 'challenge_answer', $5, $6)
       ON CONFLICT (user_id, challenge_answer_id) DO NOTHING`,
      [userId, localDay, challengeAnswerId, challengeAnswerId, accruedMinutes, now],
    );
  }

  /**
   * Admin: grant membership (idempotent).  Creates/replaces the user's plan row
   * and appends to the immutable audit log.  actorId = applying admin.
   */
  async grantMembership(
    actor: UserRecord,
    userId: string,
    input: { plan: "member" } & MembershipScheduleInput,
    requestId: string,
  ): Promise<MembershipProjection> {
    const now = new Date();
    const timezone = await this.loadUserTimezone(userId);
    const start = now.toISOString();
    const expiresAt = this.resolveSchedule(input, now);

    await this.pool.query(
      `INSERT INTO memberships (user_id, plan, status, started_at, expires_at, timezone, last_action)
       VALUES ($1, 'member', 'active', $2, $3, $4, 'grant')
       ON CONFLICT (user_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         status = 'active',
         started_at = EXCLUDED.started_at,
         expires_at = EXCLUDED.expires_at,
         timezone = EXCLUDED.timezone,
         last_action = 'grant',
         updated_at = now()
      `,
      [userId, start, expiresAt, timezone],
    );

    await this.pool.query(
      `INSERT INTO membership_audit (user_id, actor_id, action, plan, started_at, expired_at, request_id)
       VALUES ($1, $2, 'grant', 'member', $3, $4, $5)`,
      [userId, actor.id, start, expiresAt, requestId],
    );

    return this.getMembershipProjection(userId, now);
  }

  /** Admin: renew membership. Keeps started_at; updates expiry. Throws if never granted. */
  async renewMembership(
    actor: UserRecord,
    userId: string,
    input: MembershipScheduleInput,
    requestId: string,
  ): Promise<MembershipProjection> {
    const now = new Date();
    const existing = await this.pool.query<{ expires_at: Date | null }>(
      `SELECT expires_at FROM memberships WHERE user_id = $1`,
      [userId],
    );
    if (existing.rowCount === 0) {
      throw new UnprocessableEntityException("该用户尚无会员记录，无法续期（请先授予）");
    }
    const expiresAt = this.resolveSchedule(input, now, existing.rows[0]?.expires_at);
    await this.pool.query(
      `UPDATE memberships
         SET plan = 'member', status = 'active', expires_at = $2, last_action = 'renew', updated_at = now()
       WHERE user_id = $1`,
      [userId, expiresAt],
    );
    await this.insertAudit(
      userId,
      actor.id,
      "renew",
      "member",
      now.toISOString(),
      expiresAt,
      requestId,
    );
    return this.getMembershipProjection(userId, now);
  }

  /** Admin: revoke membership → downgrade to free (fail-closed applies). */
  async revokeMembership(
    actor: UserRecord,
    userId: string,
    requestId: string,
  ): Promise<MembershipProjection> {
    const now = new Date();
    await this.pool.query(
      `UPDATE memberships
         SET plan = 'free', status = 'active', expires_at = NULL, last_action = 'revoke', updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );
    await this.insertAudit(userId, actor.id, "revoke", "free", now.toISOString(), null, requestId);
    return { plan: "free", status: "free", expiresAt: null };
  }

  /** Admin: set the per-user non-member daily limit. Zero disables free study. */
  async setDailyLimit(
    actor: UserRecord,
    userId: string,
    minutes: number,
    requestId: string,
  ): Promise<{ dailyLimitMinutes: number }> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      throw new UnprocessableEntityException("每日时长必须是 0 至 1440 分钟");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1) Ensure target user exists (fail-fast with a clear 404, not an FK error).
      const userCheck = await client.query<{ id: string; timezone: string }>(
        `SELECT id, timezone FROM users WHERE id = $1`,
        [userId],
      );
      const targetUser = userCheck.rows[0];
      if (!targetUser) {
        throw new NotFoundException("用户不存在");
      }
      const timezone = targetUser.timezone;

      // 2) Upsert the membership projection (creates a free/active row for users
      //    that never had a membership; updates daily limit for existing rows).
      const now = new Date();
      await client.query(
        `INSERT INTO memberships
           (user_id, plan, status, started_at, expires_at, timezone, last_action, free_daily_limit_minutes)
         VALUES ($1, 'free', 'active', $2, NULL, $3, 'revoke', $4)
         ON CONFLICT (user_id) DO UPDATE SET
           free_daily_limit_minutes = EXCLUDED.free_daily_limit_minutes,
           updated_at = now()`,
        [userId, now.toISOString(), timezone, minutes],
      );

      // 3) Append an immutable audit fact capturing the current plan + expiry snapshot
      //    from the membership row we just wrote (or updated).
      await client.query(
        `INSERT INTO membership_audit
           (user_id, actor_id, action, plan, started_at, expired_at, daily_limit_minutes, request_id)
         SELECT user_id, $2, 'daily_limit', plan, $3, expires_at, $4, $5
           FROM memberships WHERE user_id = $1`,
        [userId, actor.id, now.toISOString(), minutes, requestId],
      );

      await client.query("COMMIT");
      return { dailyLimitMinutes: minutes };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertAudit(
    userId: string,
    actorId: string,
    action: "grant" | "renew" | "revoke",
    plan: "member" | "free",
    startedAtIso: string,
    expiredAtIso: string | null,
    requestId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO membership_audit (user_id, actor_id, action, plan, started_at, expired_at, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, actorId, action, plan, startedAtIso, expiredAtIso, requestId],
    );
  }

  // ---------------------------------------------------------------------------
  // Idempotency (mirrors auth.service idempotency_keys usage)
  // ---------------------------------------------------------------------------
  private requestHashOf(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private async claimIdempotency(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<unknown | "claimed"> {
    const claim = await this.pool.query<{ response_json: unknown }>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, response_json) VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, key) DO NOTHING RETURNING response_json`,
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

  private async completeIdempotency(scope: string, key: string, response: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_keys SET response_json = $3 WHERE scope = $1 AND key = $2`,
      [scope, key, JSON.stringify(response)],
    );
  }

  async grantMembershipIdempotent(
    actor: UserRecord,
    userId: string,
    input: { plan: "member" } & MembershipScheduleInput,
    requestId: string,
    idempotencyKey?: string,
  ): Promise<MembershipProjection> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:membership:grant:${actor.id}:${userId}`;
    const claimed = await this.claimIdempotency(scope, idempotencyKey, this.requestHashOf(input));
    if (claimed !== "claimed") return claimed as MembershipProjection;
    try {
      const result = await this.grantMembership(actor, userId, input, requestId);
      await this.completeIdempotency(scope, idempotencyKey, result);
      return result;
    } catch (err) {
      await this.pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
        scope,
        idempotencyKey,
      ]);
      throw err;
    }
  }

  async renewMembershipIdempotent(
    actor: UserRecord,
    userId: string,
    input: MembershipScheduleInput,
    requestId: string,
    idempotencyKey?: string,
  ): Promise<MembershipProjection> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:membership:renew:${actor.id}:${userId}`;
    const claimed = await this.claimIdempotency(scope, idempotencyKey, this.requestHashOf(input));
    if (claimed !== "claimed") return claimed as MembershipProjection;
    try {
      const result = await this.renewMembership(actor, userId, input, requestId);
      await this.completeIdempotency(scope, idempotencyKey, result);
      return result;
    } catch (err) {
      await this.pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
        scope,
        idempotencyKey,
      ]);
      throw err;
    }
  }

  async revokeMembershipIdempotent(
    actor: UserRecord,
    userId: string,
    requestId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:membership:revoke:${actor.id}:${userId}`;
    const claimed = await this.claimIdempotency(
      scope,
      idempotencyKey,
      this.requestHashOf({ userId }),
    );
    if (claimed !== "claimed") return;
    try {
      await this.revokeMembership(actor, userId, requestId);
      await this.completeIdempotency(scope, idempotencyKey, { ok: true });
    } catch (err) {
      await this.pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
        scope,
        idempotencyKey,
      ]);
      throw err;
    }
  }

  async setDailyLimitIdempotent(
    actor: UserRecord,
    userId: string,
    minutes: number,
    requestId: string,
    idempotencyKey?: string,
  ): Promise<{ dailyLimitMinutes: number }> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:membership:daily-limit:${actor.id}:${userId}`;
    const payload = { userId, minutes };
    const claimed = await this.claimIdempotency(scope, idempotencyKey, this.requestHashOf(payload));
    if (claimed !== "claimed") return claimed as { dailyLimitMinutes: number };
    try {
      const result = await this.setDailyLimit(actor, userId, minutes, requestId);
      await this.completeIdempotency(scope, idempotencyKey, result);
      return result;
    } catch (err) {
      await this.pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
        scope,
        idempotencyKey,
      ]);
      throw err;
    }
  }

  /**
   * 批量设置**全体非会员**用户的每日免费学习时长。
   * "非会员" = 无 membership 行 / plan='free' / 会员已过期/失效。
   * 有效会员（plan='member' 且 active 且未过期）不触碰。
   * 操作原子：先 UPSERT 现有非会员行，再补审计记录。
   */
  async setBulkDailyLimit(
    actor: UserRecord,
    minutes: number,
    requestId: string,
  ): Promise<{ dailyLimitMinutes: number; affected: number }> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      throw new UnprocessableEntityException("每日时长必须是 0 至 1440 分钟");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = new Date();

      // ---- 1) UPSERT 非会员行（含无 membership 行的用户） ----
      // 用 users 完整集合 LEFT JOIN 来识别"非会员"，然后按需创建/更新。
      // last_action 受 CHECK 约束（grant/renew/revoke），与单用户 setDailyLimit
      // 保持一致使用 'revoke'（该操作把用户降级为 free 并更新时长）。
      // affected = 所有被 UPSERT 的非会员用户数（无论值是否变化，均计入批量操作影响范围）。
      const upsertResult = await client.query<{
        user_id: string;
      }>(
        `WITH target_users AS (
           SELECT u.id, u.timezone
             FROM users u
            WHERE NOT EXISTS (
              SELECT 1 FROM memberships m
               WHERE m.user_id = u.id
                 AND m.plan = 'member'
                 AND m.status = 'active'
                 AND (m.expires_at IS NULL OR m.expires_at >= $2)
            )
         )
         INSERT INTO memberships
           (user_id, plan, status, started_at, expires_at, timezone, last_action, free_daily_limit_minutes)
         SELECT id, 'free', 'active', $2, NULL, timezone, 'revoke', $1
           FROM target_users
         ON CONFLICT (user_id) DO UPDATE SET
           free_daily_limit_minutes = EXCLUDED.free_daily_limit_minutes,
           last_action = 'revoke',
           updated_at = now()
         RETURNING user_id`,
        [minutes, now.toISOString()],
      );

      const affected = upsertResult.rows.length;

      // ---- 2) 批量审计（仅对"实际变化"的行插入，无变化不重复写审计） ----
      if (upsertResult.rows.length > 0) {
        await client.query(
          `INSERT INTO membership_audit
             (user_id, actor_id, action, plan, started_at, expired_at, daily_limit_minutes, request_id)
           SELECT m.user_id, $2, 'daily_limit', 'free', $3, NULL, $1, $4
             FROM memberships m
            WHERE m.user_id = ANY($5::uuid[])
              AND m.free_daily_limit_minutes = $1`,
          [
            minutes,
            actor.id,
            now.toISOString(),
            requestId,
            upsertResult.rows.map((r) => r.user_id),
          ],
        );
      }

      await client.query("COMMIT");
      return { dailyLimitMinutes: minutes, affected };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
