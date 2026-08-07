// 学习模块服务（阶段 5 工单 01：学习卡与学习展示）。
// 只操作 current release 的 released_course_items，绝不读草稿表；只作用于当前登录用户。
// 卡片创建是幂等的按需同步（ensureCourseCards）：把作用域课程的 current release 词项补齐双向卡，
// 课程版本变更/指针切换不破坏历史卡。学习展示幂等且不可变，不改变任何卡状态。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CARD_DIRECTIONS, validateCardDirection, type CardDirection } from "@motro/domain";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import type {
  LearningCardListItemDto,
  LearningCardListDto,
  LearningCardSummaryDto,
  LearningExposureDto,
} from "./dto.js";

interface CourseScope {
  courseId: string;
  releaseId: string;
  releaseNumber: number;
}

interface CardRow {
  card_id: string;
  course_id: string;
  course_item_id: string;
  direction: CardDirection;
  state: string;
  stability: string;
  difficulty: string;
  scheduled_days: number;
  elapsed_days: number;
  reps: number;
  lapses: number;
  last_review_at: Date | null;
  due_at: Date;
  scheduler_version: string;
  unit_position: number;
  position: number;
  english_spelling: string;
  meaning: string;
  exposed: boolean;
}

interface ExposureInsertRow {
  id: string;
  first_exposed_at: Date;
}

@Injectable()
export class StudyService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** 主课程学习卡摘要：幂等补齐主课程 current release 的双向卡后统计计数。 */
  async getCardSummary(userId: string): Promise<LearningCardSummaryDto> {
    const scope = await this.resolvePrimaryScope(userId);
    await this.ensureCourseCards(userId, scope.courseId, scope.releaseId);

    const counts = await this.pool.query<{ direction: string; state: string; n: number }>(
      `SELECT lc.direction, lc.state, count(*)::int AS n
       FROM learning_cards lc
       JOIN released_course_items rci
         ON rci.release_id = $3 AND rci.course_item_id = lc.course_item_id
       WHERE lc.user_id = $1 AND lc.course_id = $2
       GROUP BY lc.direction, lc.state`,
      [userId, scope.courseId, scope.releaseId],
    );
    let total = 0;
    let enToZh = 0;
    let zhToEn = 0;
    const byState: Record<string, number> = {};
    for (const row of counts.rows) {
      total += row.n;
      if (row.direction === "en_to_zh") enToZh += row.n;
      if (row.direction === "zh_to_en") zhToEn += row.n;
      byState[row.state] = (byState[row.state] ?? 0) + row.n;
    }

    const items = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM released_course_items WHERE release_id = $1`,
      [scope.releaseId],
    );
    // exposedItemCount 与 cards 统计同一边界：只统计当前 current release 仍包含的词项。
    // learning_exposures 历史行保留；已从当前版本移除词项的展示记录不计入。
    const exposed = await this.pool.query<{ n: number }>(
      `SELECT count(DISTINCT le.course_item_id)::int AS n
       FROM learning_exposures le
       JOIN released_course_items rci
         ON rci.release_id = $3 AND rci.course_item_id = le.course_item_id
       WHERE le.user_id = $1 AND le.course_id = $2`,
      [userId, scope.courseId, scope.releaseId],
    );

    return {
      courseId: scope.courseId,
      releaseId: scope.releaseId,
      releaseNumber: scope.releaseNumber,
      itemCount: items.rows[0]?.n ?? 0,
      cards: {
        total,
        new: byState["new"] ?? 0,
        learning: byState["learning"] ?? 0,
        review: byState["review"] ?? 0,
        enToZh,
        zhToEn,
      },
      exposedItemCount: exposed.rows[0]?.n ?? 0,
    };
  }

  /** 当前用户自己的学习卡状态列表：默认主课程，可按已报名课程过滤；先幂等补齐双向卡。 */
  async listCards(userId: string, courseId?: string): Promise<LearningCardListDto> {
    const scope = courseId
      ? await this.resolveEnrolledScope(userId, courseId)
      : await this.resolvePrimaryScope(userId);
    await this.ensureCourseCards(userId, scope.courseId, scope.releaseId);

    const result = await this.pool.query<CardRow>(
      `SELECT lc.id AS card_id, lc.course_id, lc.course_item_id, lc.direction, lc.state,
              lc.stability, lc.difficulty, lc.scheduled_days, lc.elapsed_days, lc.reps, lc.lapses,
              lc.last_review_at, lc.due_at, lc.scheduler_version,
              ru.position AS unit_position, rci.position, rci.english_spelling, rci.meaning,
              (le.id IS NOT NULL) AS exposed
       FROM learning_cards lc
       JOIN released_course_items rci
         ON rci.release_id = $3 AND rci.course_item_id = lc.course_item_id
       JOIN released_units ru ON ru.id = rci.released_unit_id
       LEFT JOIN learning_exposures le
         ON le.user_id = lc.user_id AND le.course_item_id = lc.course_item_id
       WHERE lc.user_id = $1 AND lc.course_id = $2
       ORDER BY ru.position ASC, rci.position ASC, lc.course_item_id ASC, lc.direction ASC`,
      [userId, scope.courseId, scope.releaseId],
    );

    const items: LearningCardListItemDto[] = result.rows.map((r) => ({
      cardId: r.card_id,
      courseId: r.course_id,
      releaseId: scope.releaseId,
      courseItemId: r.course_item_id,
      direction: r.direction,
      state: r.state,
      stability: Number(r.stability),
      difficulty: Number(r.difficulty),
      scheduledDays: r.scheduled_days,
      elapsedDays: r.elapsed_days,
      reps: r.reps,
      lapses: r.lapses,
      lastReviewAt: r.last_review_at ? r.last_review_at.toISOString() : null,
      dueAt: r.due_at.toISOString(),
      schedulerVersion: r.scheduler_version,
      englishSpelling: r.english_spelling,
      meaning: r.meaning,
      exposed: r.exposed,
    }));
    return { items };
  }

  /**
   * 幂等记录学习面展示：只允许当前登录用户已报名课程 current release 中的课程词项。
   * 首次写入即不可变事实；重复提交返回首次记录（alreadyExisted=true），不改 FSRS、不产生 ReviewEvent/XP。
   */
  async recordExposure(
    userId: string,
    courseItemId: string,
    requestId: string,
  ): Promise<LearningExposureDto> {
    const item = await this.pool.query<{
      course_id: string;
      release_id: string;
      released_item_id: string;
      lexical_entry_id: string;
    }>(
      `SELECT c.id AS course_id, r.id AS release_id, rci.id AS released_item_id,
              rci.lexical_entry_id
       FROM released_course_items rci
       JOIN course_releases r ON r.id = rci.release_id
       JOIN courses c ON c.id = r.course_id AND c.current_release_id = r.id
       JOIN course_enrollments e ON e.course_id = c.id AND e.user_id = $1 AND e.active = true
       WHERE rci.course_item_id = $2 AND c.visibility = 'published' AND c.status = 'active'`,
      [userId, courseItemId],
    );
    const row = item.rows[0];
    if (!row) {
      // 草稿词项、非当前版本词项、未报名课程的词项统一安全 404。
      throw new NotFoundException("课程词项不存在或不属于已报名课程的当前版本");
    }

    const inserted = await this.pool.query<ExposureInsertRow>(
      `INSERT INTO learning_exposures
         (user_id, course_item_id, lexical_entry_id, course_id, release_id, released_item_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, course_item_id) DO NOTHING
       RETURNING id, first_exposed_at`,
      [
        userId,
        courseItemId,
        row.lexical_entry_id,
        row.course_id,
        row.release_id,
        row.released_item_id,
        requestId || null,
      ],
    );
    if ((inserted.rowCount ?? 0) > 0 && inserted.rows[0]) {
      return this.toExposureDto(inserted.rows[0], row, courseItemId, false);
    }
    // 重复展示：返回首次事实（不可变）。必须从已保存的 learning_exposures 行读取，
    // release_id / lexical_entry_id / course_id 均为首次展示时冻结的值，
    // 绝不能使用当前 release 查询结果（否则版本迭代后重放会返回新 releaseId）。
    const existing = await this.pool.query<
      ExposureInsertRow & {
        course_id: string;
        release_id: string;
        lexical_entry_id: string;
      }
    >(
      `SELECT id, first_exposed_at, course_id, release_id, lexical_entry_id, released_item_id
       FROM learning_exposures
       WHERE user_id = $1 AND course_item_id = $2`,
      [userId, courseItemId],
    );
    const first = existing.rows[0];
    if (!first) throw new NotFoundException("学习展示记录不存在");
    return this.toExposureDto(
      {
        id: first.id,
        first_exposed_at: first.first_exposed_at,
      },
      {
        course_id: first.course_id,
        release_id: first.release_id,
        lexical_entry_id: first.lexical_entry_id,
      },
      courseItemId,
      true,
    );
  }

  // ---- 内部 ----

  private toExposureDto(
    record: ExposureInsertRow,
    item: { course_id: string; release_id: string; lexical_entry_id: string },
    courseItemId: string,
    alreadyExisted: boolean,
  ): LearningExposureDto {
    return {
      exposureId: record.id,
      courseItemId,
      lexicalEntryId: item.lexical_entry_id,
      courseId: item.course_id,
      releaseId: item.release_id,
      firstExposedAt: record.first_exposed_at.toISOString(),
      alreadyExisted,
    };
  }

  /** 用户 active primary 报名 + 该课程 current release；无主课程 → 404。 */
  private async resolvePrimaryScope(userId: string): Promise<CourseScope> {
    const result = await this.pool.query<{
      course_id: string;
      release_id: string;
      release_number: number;
    }>(
      `SELECT e.course_id, r.id AS release_id, r.release_number
       FROM course_enrollments e
       JOIN courses c ON c.id = e.course_id AND c.current_release_id IS NOT NULL
       JOIN course_releases r ON r.id = c.current_release_id
       WHERE e.user_id = $1 AND e.active = true AND e.is_primary = true`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("尚未设置主课程");
    return {
      courseId: row.course_id,
      releaseId: row.release_id,
      releaseNumber: row.release_number,
    };
  }

  /** 用户已报名的课程（active）current release；不是本人报名课程或不可见 → 404。 */
  private async resolveEnrolledScope(userId: string, courseId: string): Promise<CourseScope> {
    const result = await this.pool.query<{
      course_id: string;
      release_id: string;
      release_number: number;
    }>(
      `SELECT e.course_id, r.id AS release_id, r.release_number
       FROM course_enrollments e
       JOIN courses c ON c.id = e.course_id AND c.current_release_id IS NOT NULL
       JOIN course_releases r ON r.id = c.current_release_id
       WHERE e.user_id = $1 AND e.active = true AND e.course_id = $2
         AND c.visibility = 'published' AND c.status = 'active'`,
      [userId, courseId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("课程不存在或未报名");
    return {
      courseId: row.course_id,
      releaseId: row.release_id,
      releaseNumber: row.release_number,
    };
  }

  /** 幂等补齐：把 release 中每个词项的两个方向卡插入，已存在则跳过（保留历史卡）。 */
  private async ensureCourseCards(
    userId: string,
    courseId: string,
    releaseId: string,
  ): Promise<void> {
    for (const direction of CARD_DIRECTIONS) {
      const errors = validateCardDirection(direction);
      if (errors.length > 0) throw new Error(`无效方向：${errors.join("；")}`);
      await this.pool.query(
        `INSERT INTO learning_cards (user_id, course_id, course_item_id, direction)
         SELECT $1, $2, rci.course_item_id, $3
         FROM released_course_items rci
         WHERE rci.release_id = $4
         ON CONFLICT (user_id, course_item_id, direction) DO NOTHING`,
        [userId, courseId, direction, releaseId],
      );
    }
  }
}
