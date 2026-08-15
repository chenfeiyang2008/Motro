// 工单 09：可重建学习指标——API 服务层。
//
// 所有指标都从现有学习事实（review_events / learning_cards / study_sessions /
// learning_exposures / released_course_items）重建；不新增迁移、不修改任何表。
// 每个指标返回：source、asOf、timezone、dedup 规则，满足工单 09「标明事实来源」要求。
//
// 时区处理：
//   - 日期边界由「用户 timezone」+ PostgreSQL `AT TIME ZONE` 计算，不使用 UTC 日历日。
//   - timezone 来自 users.timezone（NOT NULL，注册时设置）。
//   - 若 timezone 非法，本服务用 PostgreSQL 的 `AT TIME ZONE $1` 本身会抛错，
//     抛给 controller 以 400 回复（绝不回落默认时区，不伪造日期边界）。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import { trailingLocalDayKeys, isIanaTimezone } from "@motro/domain";
import {
  CourseCompletionDto,
  DailyRhythmPointDto,
  LearningMetricsDto,
  SessionsDto,
  SevenDayRhythmDto,
} from "./metrics.dto.js";

interface CourseScope {
  courseId: string;
  releaseId: string;
  releaseNumber: number;
}

@Injectable()
export class MetricsService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async getLearningMetrics(userId: string): Promise<LearningMetricsDto> {
    const tz = await this.loadTimezone(userId);
    const scope = await this.resolvePrimaryScope(userId);
    const now = new Date();
    const asOf = now.toISOString();

    const [
      globalStableCount,
      courseItemCount,
      courseStableCount,
      dueItemCount,
      rhythm,
      sessions,
      completion,
    ] = await Promise.all([
      this.globalStableWordCount(userId),
      this.courseItemCount(scope.releaseId),
      this.courseStableWordCount(userId, scope.releaseId),
      this.dueReviewItemCount(userId, now),
      this.sevenDayRhythm(userId, tz, now),
      this.sessionMetric(userId),
      this.courseCompletionMetric(userId, scope.releaseId),
    ]);

    return {
      scope: {
        source: "learning_cards,review_events,study_sessions,learning_exposures",
        asOf,
        timezone: tz,
        dedup:
          "review_events: UNIQUE(user_id, client_event_id); learning_cards: UNIQUE(user_id, course_item_id, direction); study_sessions: unique active per user",
      },
      stableWords: {
        globalCount: globalStableCount,
        timezone: tz,
        asOf,
      },
      currentCourseStableWords: {
        courseId: scope.courseId,
        courseItemCount,
        stableCount: courseStableCount,
        timezone: tz,
        asOf,
      },
      dueReviews: {
        count: dueItemCount,
        asOf,
        timezone: tz,
      },
      sevenDayRhythm: rhythm,
      sessions,
      currentCourseCompletion: completion,
    };
  }

  private async loadTimezone(userId: string): Promise<string> {
    const r = await this.pool.query<{ timezone: string }>(
      `SELECT timezone FROM users WHERE id = $1 AND status = 'active'`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundException("用户不存在或已停用");
    if (!isIanaTimezone(row.timezone)) {
      throw new NotFoundException("用户 timezone 无效，无法计算日期边界");
    }
    return row.timezone;
  }

  private async resolvePrimaryScope(userId: string): Promise<CourseScope> {
    const r = await this.pool.query<{
      course_id: string;
      release_id: string;
      release_number: number;
    }>(
      `SELECT e.course_id, r.id AS release_id, r.release_number
       FROM course_enrollments e
       JOIN courses c ON c.id = e.course_id AND c.current_release_id IS NOT NULL
       JOIN course_releases r ON r.id = c.current_release_id
       WHERE e.user_id = $1 AND e.active = true AND e.is_primary = true
         AND c.visibility = 'published' AND c.status = 'active'`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundException("尚未设置主课程");
    return {
      courseId: row.course_id,
      releaseId: row.release_id,
      releaseNumber: row.release_number,
    };
  }

  /** 全局已稳定词项数（跨所有课程）：双向 scheduled_days >= 21 的不同 course_item_id 数。 */
  private async globalStableWordCount(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT lc_en.course_item_id)::text AS n
       FROM learning_cards lc_en
       INNER JOIN learning_cards lc_zh
         ON lc_zh.user_id = lc_en.user_id
        AND lc_zh.course_item_id = lc_en.course_item_id
        AND lc_zh.direction = 'zh_to_en'
        AND lc_zh.scheduled_days >= 21
       WHERE lc_en.user_id = $1
         AND lc_en.direction = 'en_to_zh'
         AND lc_en.scheduled_days >= 21`,
      [userId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** 当前 release 词项总数（不含草稿）。 */
  private async courseItemCount(releaseId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM released_course_items WHERE release_id = $1`,
      [releaseId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** 当前课程已稳定词项数（双向 scheduled_days >= 21）。 */
  private async courseStableWordCount(userId: string, releaseId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT rci.course_item_id)::text AS n
       FROM released_course_items rci
       INNER JOIN learning_cards lc_en
         ON lc_en.user_id = $1 AND lc_en.course_item_id = rci.course_item_id AND lc_en.direction = 'en_to_zh'
       INNER JOIN learning_cards lc_zh
         ON lc_zh.user_id = $1 AND lc_zh.course_item_id = rci.course_item_id AND lc_zh.direction = 'zh_to_en'
       WHERE rci.release_id = $2
         AND lc_en.scheduled_days >= 21
         AND lc_zh.scheduled_days >= 21`,
      [userId, releaseId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** 待复习词项数（当前课程 scope）：至少一个方向 state='review' 且 due_at <= now。每 item 至多计 1。 */
  private async dueReviewItemCount(userId: string, now: Date): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT course_item_id)::text AS n
       FROM learning_cards
       WHERE user_id = $1
         AND state = 'review'
         AND due_at <= $2`,
      [userId, now],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** 过去 7 日学习节奏（按用户 timezone 的日历日，review_events 去重后计数）。 */
  private async sevenDayRhythm(
    userId: string,
    timezone: string,
    now: Date,
  ): Promise<SevenDayRhythmDto> {
    // 使用 PostgreSQL AT TIME ZONE 精确按用户 timezone 分组。
    // $2 text 是 timezone；$3 是 server now（timestamptz）。显式 cast 避免 42P18。
    const r = await this.pool.query<{ day: string; review_count: string }>(
      `SELECT
         to_char(reviewed_at AT TIME ZONE $2::text, 'YYYY-MM-DD') AS day,
         count(*)::text AS review_count
       FROM review_events
       WHERE user_id = $1::uuid
         AND reviewed_at >= ($3::timestamptz AT TIME ZONE $2::text - interval '6 days')::timestamptz
       GROUP BY to_char(reviewed_at AT TIME ZONE $2::text, 'YYYY-MM-DD')
       ORDER BY day`,
      [userId, timezone, now],
    );

    const dayMap = new Map<string, number>();
    for (const row of r.rows) {
      dayMap.set(row.day, Number(row.review_count));
    }

    // 生成完整的 7 天序列（含 0 计数的日子），使用 domain 纯函数。
    const dayKeys = trailingLocalDayKeys(now, timezone, 7);
    const daily: DailyRhythmPointDto[] = dayKeys.map((d) => ({
      day: d,
      reviewCount: dayMap.get(d) ?? 0,
    }));
    const total = daily.reduce((s, d) => s + d.reviewCount, 0);

    return {
      timezone,
      startDay: dayKeys[0]!,
      endDay: dayKeys[dayKeys.length - 1]!,
      daily,
      total,
    };
  }

  /** 学习会话统计：总次数、已完成次数、已完成累计时长（分钟）。 */
  private async sessionMetric(userId: string): Promise<SessionsDto> {
    const r = await this.pool.query<{
      total: string;
      completed: string;
      total_minutes: string | null;
    }>(
      `SELECT
         count(*)::text AS total,
         count(*) FILTER (WHERE status = 'completed')::text AS completed,
         COALESCE(sum(
           extract(epoch FROM (completed_at - started_at)) / 60.0
         ) FILTER (WHERE status = 'completed' AND completed_at IS NOT NULL AND started_at IS NOT NULL),
         0)::text AS total_minutes
       FROM study_sessions
       WHERE user_id = $1`,
      [userId],
    );
    const row = r.rows[0]!;
    return {
      sessionCount: Number(row.total),
      completedCount: Number(row.completed),
      totalDurationMinutes: Math.round(Number(row.total_minutes) * 10) / 10,
      asOf: new Date().toISOString(),
    };
  }

  /** 课程完成度：双向首测完成数 / release 词项总数（0..1）。 */
  private async courseCompletionMetric(
    userId: string,
    releaseId: string,
  ): Promise<CourseCompletionDto> {
    const totalR = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM released_course_items WHERE release_id = $1`,
      [releaseId],
    );
    const total = Number(totalR.rows[0]?.n ?? 0);

    const completedR = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM released_course_items rci
       WHERE rci.release_id = $1
         AND EXISTS(
           SELECT 1 FROM review_events re_en
           JOIN learning_cards lc_en ON lc_en.id = re_en.card_id
           WHERE lc_en.user_id = $2 AND lc_en.course_item_id = rci.course_item_id AND lc_en.direction = 'en_to_zh'
             AND re_en.user_id = $2 AND re_en.is_initial_review = true
         )
         AND EXISTS(
           SELECT 1 FROM review_events re_zh
           JOIN learning_cards lc_zh ON lc_zh.id = re_zh.card_id
           WHERE lc_zh.user_id = $2 AND lc_zh.course_item_id = rci.course_item_id AND lc_zh.direction = 'zh_to_en'
             AND re_zh.user_id = $2 AND re_zh.is_initial_review = true
         )`,
      [releaseId, userId],
    );
    const completed = Number(completedR.rows[0]?.n ?? 0);

    const cr = await this.pool.query<{ course_id: string }>(
      `SELECT course_id FROM course_releases WHERE id = $1`,
      [releaseId],
    );
    const courseId = cr.rows[0]?.course_id ?? "";
    return {
      courseId,
      totalItemCount: total,
      initiallyCompletedItemCount: completed,
      ratio: total > 0 ? Math.round((completed / total) * 1000) / 1000 : 0,
    };
  }
}
