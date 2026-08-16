// Ticket 09 motivation service: /me/xp, /me/learning-summary, /leaderboard/weekly.
// Raw SQL over review_events / xp_entries / challenge_point_entries / learning facts.
// Privacy: leaderboard exposes only display_name; disabled users excluded;
// opt-out users excluded from rows but keep private points/rank.
import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import { getWeeklyChallengeWindow, isChallengeWeekKey, sumXp } from "@motro/domain";
import {
  LeaderboardQueryDto,
  type MeXpDto,
  type LearningSummaryDto,
  type WeeklyLeaderboardDto,
} from "./game.dto.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RULE_VERSION = 1;

interface AggRow {
  user_id: string;
  display_name: string;
  total: string;
  first_reached_at: Date | null;
  disabled: boolean;
  is_public: boolean;
}

@Injectable()
export class GameService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** Personal XP ledger: sum + detail.  Only the current user's rows. */
  async getMeXp(userId: string): Promise<MeXpDto> {
    const r = await this.pool.query<{
      amount: number;
      reason: string;
      rule_version: number;
      earned_at: Date;
    }>(
      `SELECT amount, reason, rule_version, earned_at
       FROM xp_entries WHERE user_id = $1 ORDER BY earned_at DESC, created_at DESC LIMIT 200`,
      [userId],
    );
    const entries = r.rows.map((row) => ({
      amount: Number(row.amount),
      reason: row.reason,
      ruleVersion: Number(row.rule_version),
      earnedAt: row.earned_at.toISOString(),
    }));
    return {
      totalXp: sumXp(r.rows.map((row) => ({ amount: Number(row.amount) }))),
      entries,
      ruleVersion: RULE_VERSION,
      asOf: new Date().toISOString(),
    };
  }

  /** Rebuildable personal learning summary from immutable facts. */
  async getLearningSummary(userId: string): Promise<LearningSummaryDto> {
    const now = new Date().toISOString();
    const [exposed, initiallyReviewed, stable, due] = await Promise.all([
      this.exposedWordCount(userId),
      this.initialReviewItemCount(userId),
      this.stableLexicalEntryCount(userId),
      this.dueReviewCount(userId, now),
    ]);
    return {
      exposedLexicalEntryCount: exposed,
      initiallyReviewedCourseItemCount: initiallyReviewed,
      stableLexicalEntryCount: stable,
      dueReviewCount: due,
      asOf: now,
    };
  }

  private async exposedWordCount(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT lexical_entry_id)::text AS n FROM learning_exposures WHERE user_id = $1`,
      [userId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  private async initialReviewItemCount(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT lc.course_item_id)::text AS n
       FROM learning_cards lc
       JOIN review_events re ON re.card_id = lc.id AND re.user_id = lc.user_id AND re.is_initial_review = true
       WHERE lc.user_id = $1`,
      [userId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  private async stableLexicalEntryCount(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT le.id)::text AS n
       FROM learning_cards en
       JOIN learning_cards zh
         ON zh.user_id = en.user_id AND zh.course_item_id = en.course_item_id AND zh.direction = 'zh_to_en'
       JOIN released_course_items rci ON rci.course_item_id = en.course_item_id
       JOIN lexical_entries le ON le.id = rci.lexical_entry_id
       WHERE en.user_id = $1 AND en.direction = 'en_to_zh'
         AND en.scheduled_days >= 21 AND zh.scheduled_days >= 21`,
      [userId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  private async dueReviewCount(userId: string, nowIso: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM learning_cards
       WHERE user_id = $1 AND state = 'review' AND due_at <= $2::timestamptz`,
      [userId, nowIso],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /**
   * Weekly leaderboard (rebuildable from challenge_point_entries).
   * Only Challenge Points enter the rank; daily XP never does (ADR-0007).
   * Disabled users excluded; opt-out users excluded from rows (private points kept).
   * Dense rank; tie-break: total DESC → first_reached_at ASC → user_id ASC.
   */
  async getWeeklyLeaderboard(
    viewerId: string,
    query: LeaderboardQueryDto,
  ): Promise<WeeklyLeaderboardDto> {
    const window = getWeeklyChallengeWindow(Date.now());
    const weekKey = query.challengeWeek
      ? isChallengeWeekKey(query.challengeWeek)
        ? query.challengeWeek
        : (() => {
            throw new UnprocessableEntityException("challengeWeek 不是有效挑战周键");
          })()
      : window.weekKey;
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = query.cursor ? safeCursorDecode(query.cursor) : 0;

    // Aggregated scores per user-week from the seam ledger, ordered by the
    // deterministic tie-break so dense rank assignment is stable across pages.
    const agg = await this.pool.query<AggRow>(
      `SELECT c.user_id, u.display_name,
              SUM(c.amount)::text AS total,
              MIN(c.awarded_at) AS first_reached_at,
              (u.status = 'disabled') AS disabled,
              COALESCE(p.is_public, true) AS is_public
       FROM challenge_point_entries c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN leaderboard_preferences p ON p.user_id = c.user_id
       WHERE c.challenge_week = $1
       GROUP BY c.user_id, u.display_name, u.status, p.is_public
       ORDER BY total DESC, first_reached_at ASC NULLS LAST, c.user_id ASC`,
      [weekKey],
    );

    const visible = agg.rows.filter((r) => !r.disabled && r.is_public);
    // Public rank over visible (non-disabled, opting-in) users only.
    const denseRanks = assignDenseRanks(visible);
    const paged = visible.slice(offset, offset + limit);
    const hasMore = offset + limit < visible.length;

    const totalR = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT user_id)::text AS n FROM challenge_point_entries WHERE challenge_week = $1`,
      [weekKey],
    );
    const totalParticipants = Number(totalR.rows[0]?.n ?? 0);

    const viewerRow = agg.rows.find((r) => r.user_id === viewerId);
    // Viewer's private rank among ALL non-disabled users (even if the viewer opted
    // out).  Other opted-out users are never shown (not in public rows).
    const privateRank = viewerRow
      ? (assignDenseRanks(agg.rows.filter((r) => !r.disabled)).find((r) => r.user_id === viewerId)
          ?.rank ?? null)
      : null;
    const viewerRank = privateRank;

    const result: WeeklyLeaderboardDto = {
      challengeWeek: weekKey,
      weekStart: window.startIso,
      weekEnd: window.endIso,
      timezone: window.timezone,
      rows: paged.map((r) => ({
        displayName: r.display_name,
        challengePoints: Number(r.total),
        rank: denseRanks.find((d) => d.user_id === r.user_id)!.rank,
      })),
      totalParticipants,
      hasMore,
      viewerRank,
      viewerChallengePoints: viewerRow ? Number(viewerRow.total) : 0,
      asOf: new Date().toISOString(),
    };
    if (hasMore) result.nextCursor = safeCursorEncode(offset + limit);
    return result;
  }

  /**
   * Persist the viewer's public-rank preference (opt-out), idempotently keyed by
   * (viewer, Idempotency-Key).  Replay of the same key+payload returns the frozen
   * first response; same key + different payload → 409.
   */
  async setLeaderboardVisibility(
    userId: string,
    isPublic: boolean,
    idempotencyKey?: string,
  ): Promise<{ isPublic: boolean }> {
    const requestHash = createHash("sha256").update(JSON.stringify({ isPublic })).digest("hex");
    const scope = `leaderboard:visibility:${userId}`;

    if (idempotencyKey) {
      const claim = await this.pool.query<{ response_json: unknown; request_hash: string }>(
        `INSERT INTO idempotency_keys (scope, key, request_hash, response_json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING RETURNING response_json, request_hash`,
        [scope, idempotencyKey, requestHash, JSON.stringify({ pending: true })],
      );
      if (claim.rowCount === 0) {
        const existing = await this.pool.query<{ response_json: unknown; request_hash: string }>(
          `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
          [scope, idempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) {
          // Race: claimed row vanished; fall through to normal (re)apply.
          return this.pool
            .query(
              `INSERT INTO leaderboard_preferences (user_id, is_public, updated_at)
             VALUES ($1, $2, now())
             ON CONFLICT (user_id) DO UPDATE SET is_public = EXCLUDED.is_public, updated_at = now()`,
              [userId, isPublic],
            )
            .then(() => ({ isPublic }));
        }
        if (row.request_hash !== requestHash) {
          throw new ConflictException("IDEMPOTENCY_CONFLICT：该请求键已用于不同的请求内容");
        }
        // Replay: return the frozen response.
        const frozen = row.response_json as { isPublic?: boolean } | null;
        return { isPublic: frozen?.isPublic ?? isPublic };
      }
    }

    await this.pool.query(
      `INSERT INTO leaderboard_preferences (user_id, is_public, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET is_public = EXCLUDED.is_public, updated_at = now()`,
      [userId, isPublic],
    );

    if (idempotencyKey) {
      await this.pool.query(
        `UPDATE idempotency_keys SET response_json = $3 WHERE scope = $1 AND key = $2`,
        [scope, idempotencyKey, JSON.stringify({ isPublic })],
      );
    }
    return { isPublic };
  }
}

/** Dense rank over rows already ordered by the deterministic tie-break. */
function assignDenseRanks(rows: AggRow[]): Array<AggRow & { rank: number }> {
  const out: Array<AggRow & { rank: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const prev = i > 0 ? out[i - 1]! : undefined;
    const sameAsPrev =
      prev !== undefined &&
      prev.total === row.total &&
      (prev.first_reached_at?.getTime() ?? null) === (row.first_reached_at?.getTime() ?? null);
    const rank = prev === undefined ? 1 : sameAsPrev ? prev.rank : prev.rank + 1;
    out.push({ ...row, rank });
  }
  return out;
}

function safeCursorDecode(cursor: string): number {
  let decoded: number;
  try {
    decoded = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return 0;
  }
  return Number.isNaN(decoded) || decoded < 0 ? 0 : decoded;
}

function safeCursorEncode(offset: number): string {
  return Buffer.from(String(offset)).toString("base64url");
}
