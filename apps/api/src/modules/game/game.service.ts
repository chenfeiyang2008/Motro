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
import {
  MOTIVATION_RULE_VERSION,
  getWeeklyChallengeWindow,
  isChallengeWeekKey,
  rankProgressForXp,
  reachedRanksForXp,
} from "@motro/domain";
import {
  LeaderboardQueryDto,
  type MeXpDto,
  type LearningSummaryDto,
  type WeeklyLeaderboardDto,
} from "./game.dto.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RULE_VERSION = MOTIVATION_RULE_VERSION;

interface AggRow {
  user_id: string;
  display_name: string;
  total: string;
  total_numeric: number; // numeric sort key; `total` is the text transport form
  first_reached_at: Date | null;
  disabled: boolean;
  is_public: boolean;
  is_member: boolean;
}

@Injectable()
export class GameService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** Personal XP ledger: sum + detail.  Only the current user's rows. */
  async getMeXp(userId: string): Promise<MeXpDto> {
    const [r, totalResult] = await Promise.all([
      this.pool.query<{
        amount: number;
        reason: string;
        rule_version: number;
        earned_at: Date;
      }>(
        `SELECT amount, reason, rule_version, earned_at
         FROM xp_entries WHERE user_id = $1 ORDER BY earned_at DESC, created_at DESC LIMIT 200`,
        [userId],
      ),
      this.pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM xp_entries WHERE user_id = $1`,
        [userId],
      ),
    ]);
    const entries = r.rows.map((row) => ({
      amount: Number(row.amount),
      reason: row.reason,
      ruleVersion: Number(row.rule_version),
      earnedAt: row.earned_at.toISOString(),
    }));
    const totalXp = Number(totalResult.rows[0]?.total ?? 0);
    const permanentLevel = await this.ensureLevelAwards(userId, totalXp);
    const rank = rankProgressForXp(totalXp, permanentLevel);
    return {
      totalXp,
      entries,
      ruleVersion: RULE_VERSION,
      level: rank.level,
      title: rank.title,
      titleKey: rank.titleKey,
      levelThreshold: rank.threshold,
      nextLevel: rank.nextLevel,
      nextLevelThreshold: rank.nextThreshold,
      progressXp: rank.progressXp,
      progressPercent: rank.progressPercent,
      asOf: new Date().toISOString(),
    };
  }

  /** Backfill legacy users and return the highest permanently awarded level. */
  private async ensureLevelAwards(userId: string, totalXp: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reached = reachedRanksForXp(totalXp);
      for (const rank of reached) {
        await client.query(
          `INSERT INTO level_awards
             (user_id, level, title_key, rule_version, qualified_xp, reason, awarded_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (user_id, level) DO NOTHING`,
          [userId, rank.level, rank.titleKey, RULE_VERSION, rank.threshold, "legacy_backfill"],
        );
      }
      const max = await client.query<{ level: number }>(
        `SELECT COALESCE(MAX(level), 1)::int AS level FROM level_awards WHERE user_id = $1`,
        [userId],
      );
      await client.query("COMMIT");
      return Number(max.rows[0]?.level ?? 1);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
   * Dense rank: SAME score → SAME rank (并列共享名次), regardless of award time.
   * Stable tie ORDER within the same score: total DESC → first_reached_at ASC → user_id ASC.
   *
   * Public rows and the viewer summary are derived from the SAME aggregated,
   * ordered universe with the SAME dense-rank assignment, so a viewer who appears
   * on the public board always has viewerRank === rows.rank and
   * viewerChallengePoints === rows.challengePoints.
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

    // Aggregated scores per user-week from the seam ledger.  ORDER BY total DESC
    // establishes the rank; first_reached_at ASC + user_id ASC are ONLY stable
    // within-tie secondary ordering (never change an equal-score rank).
    // NOTE: `SUM(amount)` is cast to numeric for ORDER BY — a `::text` column would
    // sort lexicographically ('5' > '10') and break ranking.  `total` stays text only
    // for transport (TO_DATE-free numeric compare; see assignDenseRanks).
    const agg = await this.pool.query<AggRow>(
      `SELECT c.user_id, u.display_name,
              SUM(c.amount)::text AS total,
              SUM(c.amount) AS total_numeric,
              MIN(c.awarded_at) AS first_reached_at,
              (u.status = 'disabled') AS disabled,
              COALESCE(p.is_public, true) AS is_public,
              (m.plan = 'member' AND m.status = 'active'
               AND (m.expires_at IS NULL OR m.expires_at > now())) AS is_member
       FROM challenge_point_entries c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN leaderboard_preferences p ON p.user_id = c.user_id
       LEFT JOIN memberships m ON m.user_id = c.user_id
       WHERE c.challenge_week = $1
       GROUP BY c.user_id, u.display_name, u.status, p.is_public, m.plan, m.status, m.expires_at
       ORDER BY total_numeric DESC, first_reached_at ASC NULLS LAST, c.user_id ASC`,
      [weekKey],
    );

    // Universe for PUBLIC rows: non-disabled AND opted-in (is_public).  Dense rank
    // is assigned to this exact ordered list, so rows' rank only ever reflects
    // score ties (equal score → equal rank).
    const visible = agg.rows.filter((r) => !r.disabled && r.is_public);
    const rankedVisible = assignDenseRanks(visible);
    const paged = rankedVisible.slice(offset, offset + limit);
    const hasMore = offset + limit < rankedVisible.length;

    const totalR = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT user_id)::text AS n FROM challenge_point_entries WHERE challenge_week = $1`,
      [weekKey],
    );
    const totalParticipants = Number(totalR.rows[0]?.n ?? 0);

    const viewerRow = agg.rows.find((r) => r.user_id === viewerId) ?? null;
    // Viewer summary:
    //  - If the viewer is on the PUBLIC board (non-disabled + opted-in), reuse the
    //    exact public row (rank + points) so the two can never diverge.
    //  - If the viewer opted out / is disabled, keep the PRIVATE rank among all
    //    NON-disabled users (opted-out peers do not appear in public rows but DO
    //    still rank privately per product contract).  Other opted-out users'
    //    identities are never exposed.
    const visibleViewerRank =
      viewerRow && !viewerRow.disabled && viewerRow.is_public
        ? (rankedVisible.find((r) => r.user_id === viewerId)?.rank ?? null)
        : null;
    const viewerRank =
      visibleViewerRank !== null
        ? visibleViewerRank
        : viewerRow
          ? (assignDenseRanks(agg.rows.filter((r) => !r.disabled)).find(
              (r) => r.user_id === viewerId,
            )?.rank ?? null)
          : null;

    const result: WeeklyLeaderboardDto = {
      challengeWeek: weekKey,
      weekStart: window.startIso,
      weekEnd: window.endIso,
      timezone: window.timezone,
      rows: paged.map((r) => ({
        displayName: r.display_name,
        challengePoints: Number(r.total),
        rank: r.rank,
        isMember: r.is_member,
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

/**
 * Dense rank over rows already ordered by the deterministic tie-break
 * (total DESC → first_reached_at ASC → user_id ASC).
 *
 * DENSE-RANK SEMANTICS: rank is based on SCORE ALONE.  Equal scores share the
 * same rank (并列共享名次), regardless of award time or user id.  The input order
 * only makes the tie ORDER stable; it never changes an equal-score rank.
 */
function assignDenseRanks(rows: AggRow[]): Array<AggRow & { rank: number }> {
  const out: Array<AggRow & { rank: number }> = [];
  let lastTotal: string | null = null;
  let currentRank = 0;
  for (const row of rows) {
    // Equal score → same dense rank; score change (DESC order) → next rank.
    // Note rows are pre-ordered DESC by total, so a change in total strictly
    // means the score went DOWN (a lower rank number than peers above).
    if (lastTotal === null || row.total !== lastTotal) {
      currentRank += 1;
      lastTotal = row.total;
    }
    out.push({ ...row, rank: currentRank });
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
