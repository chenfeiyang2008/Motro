// Ticket 20 · membership service: admin grant/renew/revoke (permission + idempotency +
// append-only audit) and server-side effective status + daily-usage accounting.
// Membership is fully separate from users.role, XP, and daily_budget_minutes.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
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
}

export interface DailyUsageSummary {
  usedMinutes: number;
  limitMinutes: number;
  resetDay: string; // YYYY-MM-DD local-day boundary
  membershipStatus: "member" | "free";
}

@Injectable()
export class MembershipService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** Load the user's membership row (or null). */
  private async loadMembership(userId: string): Promise<MembershipRow | null> {
    const r = await this.pool.query<MembershipRow>(
      `SELECT user_id, plan, status, started_at, expires_at, timezone, last_action, created_at
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
   * admin UI can distinguish 已过期 (member with past expiry) from 免费.
   */
  async getMembershipForUser(userId: string, now = new Date()): Promise<MembershipProjection> {
    return this.getMembershipProjection(userId, now);
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
      entitlement.kind === "member" ? Number.POSITIVE_INFINITY : FREE_DAILY_LIMIT_MINUTES;

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
         (user_id, local_day, review_event_id, source_event_id, minutes_accrued, accrued_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, review_event_id) DO NOTHING`,
      [userId, localDay, reviewEventId, clientEventId, accruedMinutes, now],
    );
  }

  /**
   * Admin: grant membership (idempotent).  Creates/replaces the user's plan row
   * and appends to the immutable audit log.  actorId = applying admin.
   */
  async grantMembership(
    actor: UserRecord,
    userId: string,
    input: { plan: "member"; expiresAt: string | null },
    requestId: string,
  ): Promise<MembershipProjection> {
    const now = new Date();
    const timezone = await this.loadUserTimezone(userId);
    const start = now.toISOString();

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
      [userId, start, input.expiresAt, timezone],
    );

    await this.pool.query(
      `INSERT INTO membership_audit (user_id, actor_id, action, plan, started_at, expired_at, request_id)
       VALUES ($1, $2, 'grant', 'member', $3, $4, $5)`,
      [userId, actor.id, start, input.expiresAt, requestId],
    );

    return this.getMembershipProjection(userId, now);
  }

  /** Admin: renew membership. Keeps started_at; updates expiry. Throws if never granted. */
  async renewMembership(
    actor: UserRecord,
    userId: string,
    expiresAt: string | null,
    requestId: string,
  ): Promise<MembershipProjection> {
    const now = new Date();
    const r = await this.pool.query(
      `UPDATE memberships
         SET plan = 'member', status = 'active', expires_at = $2, last_action = 'renew', updated_at = now()
       WHERE user_id = $1 RETURNING user_id`,
      [userId, expiresAt],
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new UnprocessableEntityException("该用户尚无会员记录，无法续期（请先授予）");
    }
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
    input: { plan: "member"; expiresAt: string | null },
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
    expiresAt: string | null,
    requestId: string,
    idempotencyKey?: string,
  ): Promise<MembershipProjection> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:membership:renew:${actor.id}:${userId}`;
    const claimed = await this.claimIdempotency(
      scope,
      idempotencyKey,
      this.requestHashOf({ expiresAt }),
    );
    if (claimed !== "claimed") return claimed as MembershipProjection;
    try {
      const result = await this.renewMembership(actor, userId, expiresAt, requestId);
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
}
