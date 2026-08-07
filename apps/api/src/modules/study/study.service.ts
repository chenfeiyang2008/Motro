// 学习模块服务（阶段 5 工单 01/03/04：学习卡、学习展示、每日计划与学习会话、评分提交与进度）。
// 只操作 current release 的 released_course_items，绝不读草稿表；只作用于当前登录用户。
// 卡片创建是幂等的按需同步（ensureCourseCards）：把作用域课程的 current release 词项补齐双向卡，
// 课程版本变更/指针切换不破坏历史卡。学习展示幂等且不可变，不改变任何卡状态。
// 会话创建用数据库部分唯一索引作最终并发防线：一个用户至多一个 active 会话。
// 评分提交在一笔事务内完成结算：幂等键去重 + 事务 + 卡乐观版本 + FSRS 纯函数原子写，全程原子推进；
// 并发/重复提交绝不产生第二条 ReviewEvent、绝不清 FSRS 更新、advance cursor 或 completed。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  buildDailyPlan,
  CARD_DIRECTIONS,
  classifyPlanItem,
  defaultFsrsParameters,
  deriveHighestUnlockedUnitPosition,
  deriveUnitUnlocked,
  directionStable,
  itemInitialCompleted,
  PLAN_RULE_VERSION,
  scheduleNextLearningCard,
  validateCardDirection,
  type CardDirection,
  type NextScheduleCard,
  type PlanCardCandidate,
  type PlanItem,
  type UnitProgressItem,
} from "@motro/domain";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import type {
  LearningCardListItemDto,
  LearningCardListDto,
  LearningCardSummaryDto,
  LearningExposureDto,
  ProgressDto,
  ProgressItemStateDto,
  RevealResultDto,
  StudySessionDetailDto,
  StudySessionDto,
  SubmitReviewResultDto,
  TodayDto,
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

/** 计划请求：预算 + 候选计数（每日计划 v1）。 */
interface PlanRequest {
  budgetMinutes: number;
  counts: { due: number; initial: number; new: number };
  /** 按预算截断后的实际计划项（会话快照使用）。 */
  items: PlanItem[];
}

/** 计划候选卡行：学习卡 + current release 的单元/词项位置。 */
interface PlanCardRow {
  card_id: string;
  course_item_id: string;
  direction: CardDirection;
  state: string;
  due_at: Date;
  unit_position: number | null;
  item_position: number | null;
}

/**
 * PlanCardRow → PlanCardCandidate。
 * releasedUnitPosition / releasedItemPosition 仅 new 卡需要；
 * exactOptionalPropertyTypes 下显式 undefined 会破坏可选类型，因此只在有值时写字段。
 */
function toPlanCardCandidate(row: PlanCardRow): PlanCardCandidate {
  const base: PlanCardCandidate = {
    cardId: row.card_id,
    courseItemId: row.course_item_id,
    direction: row.direction,
    state: row.state as "new" | "learning" | "review",
    dueAt: row.due_at.toISOString(),
  };
  if (row.unit_position !== null && row.unit_position !== undefined) {
    base.releasedUnitPosition = row.unit_position;
  }
  if (row.item_position !== null && row.item_position !== undefined) {
    base.releasedItemPosition = row.item_position;
  }
  return base;
}

/** active 会话行（含计划项数与 release 快照）。 */
interface ActiveSessionRow {
  session_id: string;
  course_id: string;
  release_id: string;
  release_number: number;
  status: string;
  daily_budget_minutes: number;
  plan_rule_version: string;
  planned_at: Date;
  started_at: Date;
  cursor: number;
  item_count: number;
}

/** 会话计划项行。 */
interface SessionItemRow {
  item_id: string;
  position: number;
  card_id: string;
  course_item_id: string;
  course_id: string;
  item_kind: string;
  state: string;
}

// ---- 评分/进度领域错误 ----
// 遵循 course.service 的 DraftVersionConflictError 模式：类型化错误在控制器 catch 后转换为
// 统一错误信封中的自定义 code（409 IDEMPOTENCY_CONFLICT、404 REVIEW_ACCESS_* 等）。

/** 幂等键冲突：同一 (user, client_event_id) 已被不同评分占用。→ 409 IDEMPOTENCY_CONFLICT。 */
export class IdempotencyConflictError extends Error {
  constructor() {
    super("幂等键已被其他评分占用");
    this.name = "IdempotencyConflictError";
  }
}

/** 评分前置条件失败（未 reveal、卡不匹配、非当前项、会话项不存在等）。→ 对应 4xx。 */
export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

/** 会话/计划项不存在或不属于当前用户/不是 active。→ 404 REVIEW_ITEM_NOT_FOUND。 */
export class ReviewItemNotFoundError extends Error {
  constructor(message = "会话计划项不存在或不属于当前 active 会话") {
    super(message);
    this.name = "ReviewItemNotFoundError";
  }
}

/** 评分事务内锁定的学习卡行（含调度所需列 + 乐观版本）。 */
interface LockedCardRow {
  card_id: string;
  user_id: string;
  course_id: string;
  course_item_id: string;
  direction: CardDirection;
  state: "new" | "learning" | "review";
  stability: string;
  difficulty: string;
  scheduled_days: number;
  elapsed_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  last_review_at: Date | null;
  due_at: Date;
  scheduler_version: string;
  scheduler_parameters_version: string;
  state_version: number;
}

/** 评分内派生的会话项状态负荷（写入 response_json）。 */
interface ReviewSessionStatePayload {
  itemId: string;
  itemState: string;
  newCursor: number | null;
  sessionCompleted: boolean;
}

/** 评分内派生（以 session 当前 cursor）的下一项安全摘要。 */
interface ReviewNextPayload {
  itemId: string | null;
  position: number | null;
  courseItemId: string | null;
  itemKind: string | null;
}

/** buildReviewResponse 的输入：所有用于派生响应负荷的当前事实。 */
interface ReviewResponseInput {
  sessionId: string;
  courseId: string;
  releaseId: string;
  courseItemId: string;
  direction: CardDirection;
  rating: string;
  isInitialReview: boolean;
  itemId: string;
  itemState: string;
  newCursor: number | null;
  sessionCompleted: boolean;
  memorySummary: NextScheduleCard;
}

/**
 * 「投影首测」事实：本次尚未提交的评分事件在事务内当作已发生事实参与单元解锁派生。
 * 因 ReviewEvent 先于 response_json 在**同一事务**写入，读投影时事件尚未可见；
 * 用本投影把本次 `is_initial_review=true` 方向叠加到 DB 计数上，即可让响应代表“提交后”的真实解锁状态，
 * 而不必先把不可变事件写成半成品再 UPDATE response_json。
 */
interface ProjectedInitialReview {
  /** 本次评分的词项（current release course_item_id）。 */
  courseItemId: string;
  /** 本次评分的卡方向。 */
  direction: CardDirection;
  /** 本次是否首测（is_initial_review）。非首测不参与投影。 */
  isInitialReview: boolean;
}

/** buildReviewResponse 的产物：直接 JSON 化写入 review_events.response_json 的负荷。 */
interface ReviewResponsePayload {
  memorySummary: {
    state: string;
    stability: number;
    difficulty: number;
    scheduledDays: number;
    dueAt: string;
    stateVersion: number;
    schedulerVersion: string;
    schedulerParametersVersion: string;
  };
  sessionItem: ReviewSessionStatePayload;
  newCursor: number | null;
  sessionCompleted: boolean;
  unlock: {
    highestUnlockedUnit: number;
    units: {
      position: number;
      unlocked: boolean;
      requiredItemCount: number;
      initialCompletedItemCount: number;
    }[];
  };
  next: ReviewNextPayload;
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

  /**
   * 今日概览：主课程、预算、计划候选数（due/initial/new）、是否有 active 会话、是否无任务。
   * 只读，不创建会话、不改任何卡 FSRS 状态。无主课程/不可见 → 404。
   */
  async getToday(userId: string): Promise<TodayDto> {
    const scope = await this.resolvePrimaryScope(userId);
    // 与 getCardSummary/listCards 一致：先幂等补齐主课程 current release 双向卡，
    // 否则刚设主课程的新学习者会看到 0 张候选卡（noWork）——新卡根本不存在。
    await this.ensureCourseCards(userId, scope.courseId, scope.releaseId);
    const plan = await this.loadPlanRequest(userId, scope);
    const active = await this.findActiveSession(userId);
    return {
      courseId: scope.courseId,
      releaseId: scope.releaseId,
      releaseNumber: scope.releaseNumber,
      dailyBudgetMinutes: plan.budgetMinutes,
      counts: {
        dueCount: plan.counts.due,
        initialCount: plan.counts.initial,
        newCount: plan.counts.new,
      },
      hasActiveSession: active !== null,
      noWork: plan.counts.due === 0 && plan.counts.initial === 0 && plan.counts.new === 0,
    };
  }

  /**
   * 创建或恢复当前用户唯一 active 会话。
   * - 已有 active 会话 → 原样返回同一个会话（刷新/重复调用幂等），不重建。
   * - 无 active 会话 → 在单事务内：二次检查 active 会话 → 读锁主课程 current release →
   *   幂等补齐卡 → 读候选/构建计划 → 插入 session 与 items；无候选卡时返回 noWork（不创建空会话）。
   * - 并发两个 POST：只允许一个 active 会话（数据库部分唯一索引兜底，返回同一个会话）。
   */
  async createOrResumeSession(userId: string): Promise<StudySessionDto | { noWork: boolean }> {
    const existing = await this.findActiveSession(userId);
    if (existing) return existing;

    // 全部在单事务内完成，保证「计划读取」与「会话写入」来自同一个 release 快照：
    // 事务内读锁主课程 current_release_id，发布切换在同一行锁上排队，无法造成半成品。
    return this.createSessionInTxn(userId);
  }

  /** 读取当前用户 active 会话详情（含有序计划项）。无 active 会话 → 404。 */
  async getActiveSessionDetail(userId: string): Promise<StudySessionDetailDto> {
    const session = await this.findActiveSession(userId);
    if (!session) throw new NotFoundException("没有 active 学习会话");

    const items = await this.pool.query<SessionItemRow>(
      `SELECT ssi.id AS item_id, ssi.position, ssi.card_id, ssi.course_item_id,
              ssi.item_kind, ssi.state, ss.course_id
       FROM study_session_items ssi
       JOIN study_sessions ss ON ss.id = ssi.session_id
       WHERE ssi.session_id = $1
       ORDER BY ssi.position ASC`,
      [session.sessionId],
    );
    return {
      session,
      items: items.rows.map((r) => ({
        itemId: r.item_id,
        position: r.position,
        cardId: r.card_id,
        courseItemId: r.course_item_id,
        courseId: r.course_id,
        itemKind: r.item_kind,
        state: r.state,
      })),
    };
  }

  /**
   * 展示确认：把当前 cursor 所指的 pending item 标记为 shown（幂等）。
   * 只允许当前用户自己的 active session；只允许 cursor 所指的 pending item；
   * 重复 reveal 返回当前状态（alreadyShown），不创建 ReviewEvent、不改 FSRS、不推进 cursor。
   * 对 new_learning，确认学习面实际展示时写入/复用 LearningExposure。
   */
  async revealItem(userId: string, sessionId: string, itemId: string): Promise<RevealResultDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const row = await client.query<{
        item_id: string;
        position: number;
        card_id: string;
        course_item_id: string;
        item_kind: string;
        state: string;
        session_cursor: number;
        course_id: string;
        release_id: string;
        released_item_id: string;
        lexical_entry_id: string;
      }>(
        `SELECT ssi.id AS item_id, ssi.position, ssi.card_id, ssi.course_item_id,
                ssi.item_kind, ssi.state, ss.cursor AS session_cursor,
                ss.course_id, ss.release_id, rci.id AS released_item_id, rci.lexical_entry_id
         FROM study_sessions ss
         JOIN study_session_items ssi ON ssi.session_id = ss.id
         LEFT JOIN released_course_items rci
           ON rci.release_id = ss.release_id AND rci.course_item_id = ssi.course_item_id
         WHERE ss.user_id = $1 AND ss.id = $2 AND ss.status = 'active' AND ssi.id = $3
         FOR UPDATE OF ssi`,
        [userId, sessionId, itemId],
      );
      const item = row.rows[0];
      if (!item) {
        await client.query("ROLLBACK");
        throw new NotFoundException("会话计划项不存在或不属于当前 active 会话");
      }

      // 必须是 cursor 所指的当前项；不允许跳题顺序 reveal。
      if (item.position !== item.session_cursor) {
        await client.query("ROLLBACK");
        throw new NotFoundException("计划项不是当前待展示项（不允许跳题 reveal）");
      }

      let alreadyShown = false;
      if (item.state === "pending") {
        await client.query(`UPDATE study_session_items SET state = 'shown' WHERE id = $1`, [
          item.item_id,
        ]);
      } else if (item.state === "shown") {
        alreadyShown = true;
      } else {
        // completed / skipped_by_server 项不能被 reveal。
        await client.query("ROLLBACK");
        throw new NotFoundException("计划项已完成或被跳过，不可 reveal");
      }

      // new_learning：确认学习面实际展示时幂等写入 LearningExposure（不产生 ReviewEvent / 不动 FSRS）。
      if (item.item_kind === "new_learning") {
        if (!item.released_item_id || !item.lexical_entry_id) {
          await client.query("ROLLBACK");
          throw new NotFoundException("new_learning 的学习面缺少当前版本词项信息");
        }
        await client.query(
          `INSERT INTO learning_exposures
             (user_id, course_item_id, lexical_entry_id, course_id, release_id, released_item_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, course_item_id) DO NOTHING`,
          [
            userId,
            item.course_item_id,
            item.lexical_entry_id,
            item.course_id,
            item.release_id,
            item.released_item_id,
          ],
        );
      }

      await client.query("COMMIT");
      return {
        itemId: item.item_id,
        position: item.position,
        courseItemId: item.course_item_id,
        state: "shown",
        alreadyShown,
        itemKind: item.item_kind,
        isNewLearning: item.item_kind === "new_learning",
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 进度概览（只读）：主课程 current release 各单元的解锁 + 首测完成 + 稳定派生状态。
   * 完全由 current release 快照 + ReviewEvent(首测) + learning_cards 派生重建，无缓存表。
   */
  async getProgress(userId: string): Promise<ProgressDto> {
    const scope = await this.resolvePrimaryScope(userId);
    await this.ensureCourseCards(userId, scope.courseId, scope.releaseId);

    const unitRows = await this.pool.query<{ position: number; title: string }>(
      `SELECT ru.position, ru.title FROM released_units ru
       WHERE ru.release_id = $1
       ORDER BY ru.position ASC`,
      [scope.releaseId],
    );

    const derivedUnits: {
      position: number;
      title: string;
      requiredItemCount: number;
      initialCompletedItemCount: number;
      cards: ProgressItemStateDto[];
    }[] = [];

    for (const unitRow of unitRows.rows) {
      const cards = await this.pool.query<{
        course_item_id: string;
        en_initial: boolean;
        zh_initial: boolean;
        en_scheduled_days: number;
        zh_scheduled_days: number;
        en_state: string;
        zh_state: string;
      }>(
        `SELECT rci.course_item_id,
                EXISTS(
                  SELECT 1 FROM review_events re
                  JOIN learning_cards lc ON lc.id = re.card_id
                  WHERE lc.course_item_id = rci.course_item_id
                    AND lc.user_id = $2 AND lc.direction = 'en_to_zh'
                    AND re.user_id = $2 AND re.is_initial_review = true
                ) AS en_initial,
                EXISTS(
                  SELECT 1 FROM review_events re
                  JOIN learning_cards lc ON lc.id = re.card_id
                  WHERE lc.course_item_id = rci.course_item_id
                    AND lc.user_id = $2 AND lc.direction = 'zh_to_en'
                    AND re.user_id = $2 AND re.is_initial_review = true
                ) AS zh_initial,
                COALESCE(
                  (SELECT lcs.scheduled_days FROM learning_cards lcs
                   WHERE lcs.course_item_id = rci.course_item_id
                     AND lcs.user_id = $2 AND lcs.direction = 'en_to_zh'), 0) AS en_scheduled_days,
                COALESCE(
                  (SELECT lcs.scheduled_days FROM learning_cards lcs
                   WHERE lcs.course_item_id = rci.course_item_id
                     AND lcs.user_id = $2 AND lcs.direction = 'zh_to_en'), 0) AS zh_scheduled_days,
                COALESCE(
                  (SELECT lcs.state FROM learning_cards lcs
                   WHERE lcs.course_item_id = rci.course_item_id
                     AND lcs.user_id = $2 AND lcs.direction = 'en_to_zh'), 'new') AS en_state,
                COALESCE(
                  (SELECT lcs.state FROM learning_cards lcs
                   WHERE lcs.course_item_id = rci.course_item_id
                     AND lcs.user_id = $2 AND lcs.direction = 'zh_to_en'), 'new') AS zh_state
         FROM released_course_items rci
         JOIN released_units ru ON ru.id = rci.released_unit_id
         WHERE rci.release_id = $1 AND ru.position = $3
         ORDER BY rci.position ASC`,
        [scope.releaseId, userId, unitRow.position],
      );

      const unitCards: ProgressItemStateDto[] = [];
      let initialCompletedItemCount = 0;
      for (const c of cards.rows) {
        const enReviewed = c.en_initial;
        const zhReviewed = c.zh_initial;
        if (itemInitialCompleted(enReviewed, zhReviewed)) initialCompletedItemCount++;
        unitCards.push({
          courseItemId: c.course_item_id,
          direction: "en_to_zh",
          initialReviewed: enReviewed,
          scheduledDays: c.en_scheduled_days,
          stable: directionStable(c.en_scheduled_days),
          state: c.en_state,
        });
        unitCards.push({
          courseItemId: c.course_item_id,
          direction: "zh_to_en",
          initialReviewed: zhReviewed,
          scheduledDays: c.zh_scheduled_days,
          stable: directionStable(c.zh_scheduled_days),
          state: c.zh_state,
        });
      }

      derivedUnits.push({
        position: unitRow.position,
        title: unitRow.title,
        requiredItemCount: cards.rows.length,
        initialCompletedItemCount,
        cards: unitCards,
      });
    }

    // 由纯函数派生解锁状态（首个单元默认解锁，连续解锁不变量）。
    const derived = deriveUnitUnlocked(
      derivedUnits.map((u) => ({
        position: u.position,
        requiredItemCount: u.requiredItemCount,
        initialCompletedItemCount: u.initialCompletedItemCount,
      })),
    );
    const unlockedByPosition = new Map(derived.map((d) => [d.position, d.unlocked]));
    const highest = deriveHighestUnlockedUnitPosition(
      derivedUnits.map((u) => ({
        position: u.position,
        requiredItemCount: u.requiredItemCount,
        initialCompletedItemCount: u.initialCompletedItemCount,
      })),
    );

    return {
      courseId: scope.courseId,
      releaseId: scope.releaseId,
      releaseNumber: scope.releaseNumber,
      highestUnlockedUnit: highest,
      units: derivedUnits.map((u) => ({
        position: u.position,
        title: u.title,
        unlocked: unlockedByPosition.get(u.position) ?? false,
        itemCount: u.requiredItemCount,
        initialCompletedItemCount: u.initialCompletedItemCount,
        cards: u.cards,
      })),
    };
  }

  /**
   * 评分提交：对当前 cursor 所指、已 reveal 的计划项提交四级评分。
   * 在一笔事务内原子完成：
   *   1) 事务级 advisory lock 按 (user_id, client_event_id) 串行化同键请求；
   *      锁后重查 review_events：同 request_hash → 幂等重放返回已存 response_json；
   *      不同 request_hash → 抛 IDEMPOTENCY_CONFLICT（整笔回滚）；不存在才继续。
   *   2) 锁 session item/卡 → 校验 active/cursor/shown/card 匹配/release 快照一致。
   *   3) 构造 FSRS 输入并调用 scheduleNextLearningCard（绝不复制 FSRS 公式）。
   *   4) 推导 is_initial_review（该方向在本次有效评分前没有有效 ReviewEvent 则 true）。
   *   5) 写不可变 ReviewEvent；乐观更新 learning_cards；item → completed；advance cursor；
   *      最后一项 → session completed。
   *   6) 由当前事实派生 progress/unlock（含本次首测投影），生成 response_json 并原子提交。
   */
  async submitReview(
    userId: string,
    sessionId: string,
    input: { sessionItemId: string; cardId: string; rating: string; clientEventId: string },
  ): Promise<SubmitReviewResultDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 0) 事务级 advisory lock：按 (user_id, client_event_id) 串行化同键评分。
      //    两个相同请求并发时，第二个在锁上排队，直到第一笔提交后才继续，
      //    从而在“任何状态校验/FSRS/写入之前”就能看到第一笔已落盘事件 → 幂等重放，
      //    而不是撞见 item 已 completed 得到验证错误。pg_advisory_xact_lock 随事务自动释放，
      //    不依赖进程内内存锁。
      const lockKey = this.reviewIdempotencyLockKey(userId, input.clientEventId);
      await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);

      const requestHash = this.reviewRequestHash(input);

      // 1) 幂等键去重（advisory lock 已串行化；锁后重查，看到第一笔已提交事件）。
      const existing = await client.query<{
        id: string;
        request_hash: string;
        response_json: unknown;
      }>(
        `SELECT id, request_hash, response_json FROM review_events
         WHERE user_id = $1 AND client_event_id = $2`,
        [userId, input.clientEventId],
      );
      if (existing.rows[0]) {
        const stored = existing.rows[0];
        if (stored.request_hash !== requestHash) {
          throw new IdempotencyConflictError();
        }
        // 幂等重放：同请求 → 返回首次已存 response_json，不再调用 FSRS、不再推进 cursor。
        await client.query("ROLLBACK");
        return {
          idempotentReplay: true,
          reviewEventId: stored.id,
          ...(stored.response_json as object),
        } as SubmitReviewResultDto;
      }

      // 2) 锁并校验 session item / card / session（活跃且属于当前用户；校验失败抛领域错误）。
      const { item, card, session } = await this.loadReviewTargets(
        client,
        userId,
        sessionId,
        input.sessionItemId,
      );

      // card 必须等于请求 cardId，且属于该用户会话绑定的课程/release。
      if (item.card_id !== input.cardId || card.card_id !== input.cardId) {
        throw new ReviewValidationError("评分卡与计划项绑定卡不一致");
      }

      // 3) 评分必须已 reveal（shown）；尚未 reveal 不允许评分。
      if (item.state !== "shown") {
        throw new ReviewValidationError("计划项尚未 reveal，无法评分");
      }

      // 4) 构造 FSRS 输入并调度。服务器 is the sole clock authority。
      const now = new Date();
      const params = defaultFsrsParameters();
      const scheduled: NextScheduleCard = scheduleNextLearningCard({
        card: {
          state: card.state,
          stability: Number(card.stability),
          difficulty: Number(card.difficulty),
          scheduledDays: card.scheduled_days,
          elapsedDays: card.elapsed_days,
          reps: card.reps,
          lapses: card.lapses,
          learningSteps: card.learning_steps,
          lastReviewAt: card.last_review_at ? card.last_review_at.toISOString() : null,
          dueAt: card.due_at.toISOString(),
          schedulerVersion: card.scheduler_version,
          schedulerParametersVersion: card.scheduler_parameters_version,
          stateVersion: card.state_version,
        },
        now,
        rating: input.rating as "again" | "hard" | "good" | "easy",
        parameters: params,
      });

      // 5) is_initial_review：该方向在本次有效评分前没有任何有效 ReviewEvent 则为 true。
      const priorReview = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM review_events WHERE user_id = $1 AND card_id = $2`,
        [userId, card.card_id],
      );
      const isInitialReview = Number(priorReview.rows[0]?.n ?? 0) === 0;

      // new_learning 首次评分前必须已有 LearningExposure（确认学习面实际展示）。
      if (item.item_kind === "new_learning") {
        const exposureCheck = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM learning_exposures
           WHERE user_id = $1 AND course_item_id = $2`,
          [userId, item.course_item_id],
        );
        if (Number(exposureCheck.rows[0]?.n ?? 0) === 0) {
          throw new ReviewValidationError("new_learning 首次评分前必须先 reveal（确认学习面展示）");
        }
      }

      // 6) 完整 state_before / state_after 快照（审计与重建依据）。
      const state_before = this.cardStateToJson(card);
      const state_after = {
        state: scheduled.state,
        stability: scheduled.stability,
        difficulty: scheduled.difficulty,
        scheduledDays: scheduled.scheduledDays,
        elapsedDays: scheduled.elapsedDays,
        reps: scheduled.reps,
        lapses: scheduled.lapses,
        learningSteps: scheduled.learningSteps,
        lastReviewAt: scheduled.lastReviewAt,
        dueAt: scheduled.dueAt,
        schedulerVersion: scheduled.schedulerVersion,
        schedulerParametersVersion: scheduled.schedulerParametersVersion,
        stateVersion: scheduled.stateVersion,
      };

      // 8) 写不可变 ReviewEvent（幂等键唯一；并发冲突则回滚返回既有结果）。
      //     response_json 必须先于事件写入派生完成 → 因此移到 cursor 推进之后。
      // 9) 乐观更新 learning_cards（以锁定的 state_version 为前置条件）。
      const updateResult = await client.query(
        `UPDATE learning_cards SET
           state = $2, stability = $3, difficulty = $4, scheduled_days = $5, elapsed_days = $6,
           reps = $7, lapses = $8, learning_steps = $9, last_review_at = $10, due_at = $11,
           scheduler_version = $12, scheduler_parameters_version = $13, state_version = $14,
           updated_at = now()
         WHERE id = $1 AND state_version = $15`,
        [
          card.card_id,
          scheduled.state,
          scheduled.stability,
          scheduled.difficulty,
          scheduled.scheduledDays,
          scheduled.elapsedDays,
          scheduled.reps,
          scheduled.lapses,
          scheduled.learningSteps,
          scheduled.lastReviewAt,
          scheduled.dueAt,
          scheduled.schedulerVersion,
          scheduled.schedulerParametersVersion,
          scheduled.stateVersion,
          card.state_version,
        ],
      );
      if ((updateResult.rowCount ?? 0) === 0) {
        // 卡版本已被并发修改：本事务回滚（不 prop 半成品）。
        throw new ReviewValidationError("并发修改了学习卡状态，评分未被接受");
      }

      // 10) item → completed；advance cursor；无下一项则 session completed。
      await client.query(`UPDATE study_session_items SET state = 'completed' WHERE id = $1`, [
        item.item_id,
      ]);
      const nextPosition = await this.advanceCursor(client, session.session_id, item.position);
      const sessionCompleted = nextPosition === null;
      if (sessionCompleted) {
        await client.query(
          `UPDATE study_sessions SET status = 'completed', completed_at = now()
           WHERE id = $1 AND status = 'active'`,
          [session.session_id],
        );
      }

      // 7b) 由推进后的 cursor / 解锁事实派生响应负荷（response_json 完全由当前事实构建）。
      //     投影把本次首测当作已提交事实参与单元解锁派生，使响应代表“提交后”的真实状态。
      const response_json = await this.buildReviewResponse(
        client,
        userId,
        session,
        {
          sessionId: session.session_id,
          courseId: session.course_id,
          releaseId: session.release_id,
          courseItemId: item.course_item_id,
          direction: card.direction,
          rating: input.rating,
          isInitialReview,
          itemId: item.item_id,
          itemState: "completed",
          newCursor: nextPosition,
          sessionCompleted,
          memorySummary: scheduled,
        },
        {
          courseItemId: item.course_item_id,
          direction: card.direction,
          isInitialReview,
        },
      );

      // 12) 写不可变 ReviewEvent（幂等键唯一；并发冲突则回滚返回既有结果）。
      const eventInsert = await client.query<{ id: string }>(
        `INSERT INTO review_events
           (user_id, session_id, session_item_id, card_id, client_event_id, request_hash, rating,
            is_initial_review, scheduler_version, scheduler_parameters_version,
            state_before, state_after, reviewed_at, response_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb)
         ON CONFLICT (user_id, client_event_id) DO NOTHING
         RETURNING id`,
        [
          userId,
          session.session_id,
          item.item_id,
          card.card_id,
          input.clientEventId,
          requestHash,
          input.rating,
          isInitialReview,
          scheduled.schedulerVersion,
          scheduled.schedulerParametersVersion,
          JSON.stringify(state_before),
          JSON.stringify(state_after),
          now,
          JSON.stringify(response_json),
        ],
      );
      if ((eventInsert.rowCount ?? 0) === 0) {
        // 并发同 key 先写入：返回既有结果（幂等重放），不二次调度、二推进。
        const replayed = await client.query<{ id: string; response_json: unknown }>(
          `SELECT id, response_json FROM review_events
           WHERE user_id = $1 AND client_event_id = $2`,
          [userId, input.clientEventId],
        );
        await client.query("ROLLBACK");
        return {
          idempotentReplay: true,
          reviewEventId: replayed.rows[0]?.id,
          ...((replayed.rows[0]?.response_json as object) ?? {}),
        } as SubmitReviewResultDto;
      }
      const eventId = eventInsert.rows[0]!.id;

      await client.query("COMMIT");

      return {
        idempotentReplay: false,
        reviewEventId: eventId,
        rating: input.rating as "again" | "hard" | "good" | "easy",
        isInitialReview,
        ...(response_json as object),
      } as SubmitReviewResultDto;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- 内部 ----

  /** 评分请求规范化哈希：同一 (sessionItemId, cardId, rating, clientEventId) 得到同一哈希。 */
  private reviewRequestHash(input: {
    sessionItemId: string;
    cardId: string;
    rating: string;
    clientEventId: string;
  }): string {
    const canonical = [
      "review",
      input.sessionItemId,
      input.cardId,
      input.rating,
      input.clientEventId,
    ].join("\u0000");
    return createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * 评分幂等键的事务级 advisory 锁 key：由 (user_id, client_event_id) 哈希为单个 bigint。
   * 两个相同键的评分请求在同一 key 上串行化；锁随事务自动释放，不用跨请求内存状态。
   */
  private reviewIdempotencyLockKey(userId: string, clientEventId: string): bigint {
    const digest = createHash("sha256").update(`review-idem:${userId}:${clientEventId}`).digest();
    // 取前 8 字节为大端无符号 bigint，再清最高位（& 0x7fff...），落到有符号 bigint 正数范围，
    // 避免 pg_advisory_xact_lock 参数（bigint）因满 uint64 越界。
    const u64 = digest.subarray(0, 8).readBigUInt64BE(0);
    return u64 & 0x7fffffffffffffffn;
  }

  /** 锁并校验评分目标：active 会话 + 当前 cursor 项 + 绑定的学习卡（同事务 FOR UPDATE）。 */
  private async loadReviewTargets(
    client: import("pg").PoolClient,
    userId: string,
    sessionId: string,
    sessionItemId: string,
  ): Promise<{
    item: SessionItemRow;
    card: LockedCardRow;
    session: { session_id: string; course_id: string; release_id: string };
  }> {
    // 锁会话与计划项：FOR UPDATE 防止同一 session item 被并发评分推进两次。
    // 只允许当前用户自己的 active 会话；item 必须属于该会话且为当前 cursor 所指。
    const itemRow = await client.query<{
      item_id: string;
      position: number;
      card_id: string;
      course_item_id: string;
      course_id: string;
      item_kind: string;
      state: string;
      session_cursor: number;
      session_release_id: string;
      session_course_id: string;
      session_status: string;
    }>(
      `SELECT ssi.id AS item_id, ssi.position, ssi.card_id, ssi.course_item_id,
              ssi.item_kind, ssi.state, ss.cursor AS session_cursor,
              ss.release_id AS session_release_id, ss.course_id AS session_course_id,
              ss.status AS session_status
       FROM study_sessions ss
       JOIN study_session_items ssi ON ssi.session_id = ss.id
       WHERE ss.user_id = $1 AND ss.id = $2 AND ss.status = 'active' AND ssi.id = $3
       FOR UPDATE OF ssi`,
      [userId, sessionId, sessionItemId],
    );
    const item = itemRow.rows[0];
    if (!item) {
      throw new ReviewItemNotFoundError("会话计划项不存在或不属于当前 active 会话");
    }

    // 必须是 cursor 所指的当前项；不允许跳题评分。
    if (item.position !== item.session_cursor) {
      throw new ReviewValidationError("计划项不是当前待评分项（不允许跳题评分）");
    }

    // 锁并读取绑定的学习卡（校验归属 + 当前 release 快照一致性）。
    const cardRow = await client.query<LockedCardRow>(
      `SELECT lc.id AS card_id, lc.user_id, lc.course_id, lc.course_item_id, lc.direction,
              lc.state, lc.stability, lc.difficulty, lc.scheduled_days, lc.elapsed_days,
              lc.reps, lc.lapses, lc.learning_steps, lc.last_review_at, lc.due_at,
              lc.scheduler_version, lc.scheduler_parameters_version, lc.state_version
       FROM learning_cards lc
       JOIN released_course_items rci
         ON rci.release_id = $3 AND rci.course_item_id = lc.course_item_id
       WHERE lc.id = $1 AND lc.user_id = $2
       FOR UPDATE OF lc`,
      [item.card_id, userId, item.session_release_id],
    );
    const card = cardRow.rows[0];
    if (!card) {
      throw new ReviewItemNotFoundError("依据会话绑定的 release 快照找不到该学习卡");
    }

    return {
      item,
      card,
      session: {
        session_id: sessionId,
        course_id: item.session_course_id,
        release_id: item.session_release_id,
      },
    };
  }

  /** 从锁定的卡行序列化完整 state_before 快照（审计 + 重建依据）。 */
  private cardStateToJson(card: LockedCardRow): object {
    return {
      state: card.state,
      stability: Number(card.stability),
      difficulty: Number(card.difficulty),
      scheduledDays: card.scheduled_days,
      elapsedDays: card.elapsed_days,
      reps: card.reps,
      lapses: card.lapses,
      learningSteps: card.learning_steps,
      lastReviewAt: card.last_review_at ? card.last_review_at.toISOString() : null,
      dueAt: card.due_at.toISOString(),
      schedulerVersion: card.scheduler_version,
      schedulerParametersVersion: card.scheduler_parameters_version,
      stateVersion: card.state_version,
    };
  }

  /**
   * 推进会话 cursor 到下一个 `pending`/`shown` 项；无下一项返回 null（会话已完成）。
   * 只前进不后退；只指向尚未评分的项。
   */
  private async advanceCursor(
    client: import("pg").PoolClient,
    sessionId: string,
    currentPosition: number,
  ): Promise<number | null> {
    const next = await client.query<{ position: number }>(
      `SELECT position FROM study_session_items
       WHERE session_id = $1 AND position > $2 AND state IN ('pending', 'shown')
       ORDER BY position ASC LIMIT 1`,
      [sessionId, currentPosition],
    );
    if (next.rows.length === 0) {
      await client.query(`UPDATE study_sessions SET cursor = $2 WHERE id = $1 AND cursor = $2`, [
        sessionId,
        currentPosition + 1,
      ]);
      return null;
    }
    const pos = next.rows[0]!.position;
    await client.query(`UPDATE study_sessions SET cursor = $2 WHERE id = $1`, [sessionId, pos]);
    return pos;
  }

  /**
   * 构建评分响应的完整负荷（response_json）：由当前事实派生
   * 会话项状态 / 新 cursor / 完成状态 / 单元解锁 / 下一项安全摘要。
   */
  private async buildReviewResponse(
    client: import("pg").PoolClient,
    userId: string,
    session: { course_id: string; release_id: string },
    input: ReviewResponseInput,
    projection?: ProjectedInitialReview,
  ): Promise<ReviewResponsePayload> {
    const [sessionItem, next, unlock] = await Promise.all([
      this.buildReviewSessionState(input),
      this.buildReviewNext(client, input),
      this.deriveUnlockState(client, userId, session.release_id, projection),
    ]);
    return {
      memorySummary: {
        state: input.memorySummary.state,
        stability: input.memorySummary.stability,
        difficulty: input.memorySummary.difficulty,
        scheduledDays: input.memorySummary.scheduledDays,
        dueAt: input.memorySummary.dueAt,
        stateVersion: input.memorySummary.stateVersion,
        schedulerVersion: input.memorySummary.schedulerVersion,
        schedulerParametersVersion: input.memorySummary.schedulerParametersVersion,
      },
      sessionItem,
      newCursor: sessionItem.newCursor,
      sessionCompleted: sessionItem.sessionCompleted,
      unlock,
      next,
    };
  }

  private buildReviewSessionState(input: ReviewResponseInput): ReviewSessionStatePayload {
    return {
      itemId: input.itemId,
      itemState: input.itemState,
      newCursor: input.newCursor,
      sessionCompleted: input.sessionCompleted,
    };
  }

  /** 由推进后的会话 cursor 派生下一项安全摘要（无答案内容）。 */
  private async buildReviewNext(
    client: import("pg").PoolClient,
    input: ReviewResponseInput,
  ): Promise<ReviewNextPayload> {
    if (input.newCursor === null) {
      return { itemId: null, position: null, courseItemId: null, itemKind: null };
    }
    const next = await client.query<{
      item_id: string;
      position: number;
      course_item_id: string;
      item_kind: string;
    }>(
      `SELECT ssi.id AS item_id, ssi.position, ssi.course_item_id, ssi.item_kind
       FROM study_session_items ssi
       WHERE ssi.session_id = $1 AND ssi.position = $2 AND ssi.state IN ('pending', 'shown')
       LIMIT 1`,
      [input.sessionId, input.newCursor],
    );
    const row = next.rows[0];
    if (!row) return { itemId: null, position: null, courseItemId: null, itemKind: null };
    return {
      itemId: row.item_id,
      position: row.position,
      courseItemId: row.course_item_id,
      itemKind: row.item_kind,
    };
  }

  /**
   * 派生 current release 各单元的解锁状态（由 ReviewEvent 首测事实完全重建）。
   * @param projected 本次尚未落盘的首测投影；叠加在 DB 计数上，使派生结果代表“本次提交后”的真实解锁。
   */
  private async deriveUnlockState(
    client: import("pg").PoolClient,
    userId: string,
    releaseId: string,
    projection?: ProjectedInitialReview,
  ): Promise<{
    highestUnlockedUnit: number;
    units: {
      position: number;
      unlocked: boolean;
      requiredItemCount: number;
      initialCompletedItemCount: number;
    }[];
  }> {
    const unitRows = await client.query<{ position: number }>(
      `SELECT ru.position FROM released_units ru
       WHERE ru.release_id = $1
       ORDER BY ru.position ASC`,
      [releaseId],
    );
    const positions = unitRows.rows.map((r) => r.position);
    if (positions.length === 0) {
      return { highestUnlockedUnit: 1, units: [] };
    }

    // 每单元：requiredItemCount（release 快照）+ 已完成双向首测的词项数（ReviewEvent 派生）。
    const units: UnitProgressItem[] = [];
    for (const position of positions) {
      const required = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM released_course_items rci
         JOIN released_units ru ON ru.id = rci.released_unit_id
         WHERE ru.release_id = $1 AND ru.position = $2`,
        [releaseId, position],
      );
      // 单元内双向首测完成的词项：两方向各至少一条 is_initial_review=true 事件。
      const completed = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM released_course_items rci
         JOIN released_units ru ON ru.id = rci.released_unit_id
         WHERE ru.release_id = $1 AND ru.position = $2
           AND EXISTS (
             SELECT 1 FROM review_events re_en
             JOIN learning_cards le ON le.id = re_en.card_id
             WHERE le.course_item_id = rci.course_item_id
               AND le.direction = 'en_to_zh'
               AND re_en.user_id = $3 AND re_en.is_initial_review = true
           )
           AND EXISTS (
             SELECT 1 FROM review_events re_zh
             JOIN learning_cards lz ON lz.id = re_zh.card_id
             WHERE lz.course_item_id = rci.course_item_id
               AND lz.direction = 'zh_to_en'
               AND re_zh.user_id = $3 AND re_zh.is_initial_review = true
           )`,
        [releaseId, position, userId],
      );
      let initialCompletedItemCount = Number(completed.rows[0]?.n ?? 0);
      // 投影叠加：若本次评分就是本单元内某词项的首测，把该词的“完成”事实（另一方向已首测）计数进来。
      if (projection?.isInitialReview) {
        initialCompletedItemCount = await this.deriveProjectedCompletedCount(
          client,
          userId,
          releaseId,
          position,
          projection,
          initialCompletedItemCount,
        );
      }
      units.push({
        position,
        requiredItemCount: Number(required.rows[0]?.n ?? 0),
        initialCompletedItemCount,
      });
    }

    const derived = deriveUnitUnlocked(units);
    return {
      highestUnlockedUnit: deriveHighestUnlockedUnitPosition(units),
      units: derived.map((u) => ({
        position: u.position,
        unlocked: u.unlocked,
        requiredItemCount: u.requiredItemCount,
        initialCompletedItemCount: u.initialCompletedItemCount,
      })),
    };
  }

  /**
   * 投影首测后，重算某单元“已完成双向首测的词项数”。
   * DB 计数反映提交前的已提交事件；本方法把本次 `is_initial_review=true` 的词项（若位于该单元、
   * 且对向已首测）补计 1，使响应代表提交后的真实解锁状态。
   * 注：is_initial_review=true 意味着该方向在提交前没有任何已提交首测，故不会重复计数。
   */
  private async deriveProjectedCompletedCount(
    client: import("pg").PoolClient,
    userId: string,
    releaseId: string,
    unitPosition: number,
    projection: ProjectedInitialReview,
    committed: number,
  ): Promise<number> {
    if (!projection.isInitialReview) return committed;
    // 该词项必须属于本单元，才计入本单元。
    const inUnit = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM released_course_items rci
       JOIN released_units ru ON ru.id = rci.released_unit_id
       WHERE ru.release_id = $1 AND ru.position = $2 AND rci.course_item_id = $3`,
      [releaseId, unitPosition, projection.courseItemId],
    );
    if (Number(inUnit.rows[0]?.n ?? 0) === 0) return committed;
    // 对向必须已有首测事件，词项才因本次首测而完成双向。
    const otherDir = projection.direction === "en_to_zh" ? "zh_to_en" : "en_to_zh";
    const otherDone = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM review_events re
       JOIN learning_cards lc ON lc.id = re.card_id
       WHERE lc.course_item_id = $2 AND lc.direction = $3
         AND re.user_id = $1 AND re.is_initial_review = true`,
      [userId, projection.courseItemId, otherDir],
    );
    if (Number(otherDone.rows[0]?.n ?? 0) === 0) return committed;
    return committed + 1;
  }

  /**
   * 派生「计划允许进入的最大单元 position」（最高已解锁单元）。
   * 取代硬编码 firstUnitPosition=1：new_learning 卡按解锁进度放行。
   * 复用 deriveUnlockState 的派生输入（不含卡明细，只取 required/initial 计数）。
   */
  private async derivePlanningFirstUnit(
    client: import("pg").PoolClient | Pool,
    userId: string,
    releaseId: string,
  ): Promise<number> {
    const unitRows = await client.query<{ position: number }>(
      `SELECT ru.position FROM released_units ru
       WHERE ru.release_id = $1
       ORDER BY ru.position ASC`,
      [releaseId],
    );
    const positions = unitRows.rows.map((r) => r.position);
    if (positions.length === 0) return 1;

    const units: UnitProgressItem[] = [];
    for (const position of positions) {
      const required = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM released_course_items rci
         JOIN released_units ru ON ru.id = rci.released_unit_id
         WHERE ru.release_id = $1 AND ru.position = $2`,
        [releaseId, position],
      );
      const completed = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM released_course_items rci
         JOIN released_units ru ON ru.id = rci.released_unit_id
         WHERE ru.release_id = $1 AND ru.position = $2
           AND EXISTS (
             SELECT 1 FROM review_events re
             JOIN learning_cards le ON le.id = re.card_id
             WHERE le.course_item_id = rci.course_item_id
               AND le.direction = 'en_to_zh' AND re.user_id = $3
               AND re.is_initial_review = true
           )
           AND EXISTS (
             SELECT 1 FROM review_events re
             JOIN learning_cards lz ON lz.id = re.card_id
             WHERE lz.course_item_id = rci.course_item_id
               AND lz.direction = 'zh_to_en' AND re.user_id = $3
               AND re.is_initial_review = true
           )`,
        [releaseId, position, userId],
      );
      units.push({
        position,
        requiredItemCount: Number(required.rows[0]?.n ?? 0),
        initialCompletedItemCount: Number(completed.rows[0]?.n ?? 0),
      });
    }
    return deriveHighestUnlockedUnitPosition(units);
  }

  /** 当前用户的 active 会话（含计划项数）。无 → null。 */
  private async findActiveSession(userId: string): Promise<StudySessionDto | null> {
    const result = await this.pool.query<ActiveSessionRow>(
      `SELECT ss.id AS session_id, ss.course_id, ss.release_id, cr.release_number,
              ss.status, ss.daily_budget_minutes, ss.plan_rule_version,
              ss.planned_at, ss.started_at, ss.cursor,
              (SELECT count(*)::int FROM study_session_items ssi WHERE ssi.session_id = ss.id) AS item_count
       FROM study_sessions ss
       JOIN course_releases cr ON cr.id = ss.release_id
       WHERE ss.user_id = $1 AND ss.status = 'active'
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.toSessionDto(row);
  }

  /** 加载计划请求：预算 + 候选计数 + 截断后的计划项。 */
  private async loadPlanRequest(userId: string, scope: CourseScope): Promise<PlanRequest> {
    const usersResult = await this.pool.query<{ daily_budget_minutes: number }>(
      "SELECT daily_budget_minutes FROM users WHERE id = $1",
      [userId],
    );
    const budgetMinutes = usersResult.rows[0]?.daily_budget_minutes ?? 0;

    const cards = await this.pool.query<PlanCardRow>(
      `SELECT lc.id AS card_id, lc.course_item_id, lc.direction, lc.state, lc.due_at,
              ru.position AS unit_position, rci.position AS item_position
       FROM learning_cards lc
       JOIN released_course_items rci
         ON rci.release_id = $3 AND rci.course_item_id = lc.course_item_id
       JOIN released_units ru ON ru.id = rci.released_unit_id
       WHERE lc.user_id = $1 AND lc.course_id = $2`,
      [userId, scope.courseId, scope.releaseId],
    );

    const candidates = cards.rows.map((r) => toPlanCardCandidate(r));
    const now = new Date();
    // 派生最大可进入计划的单元（最高已解锁）；供 new 卡过滤与计数。
    const firstUnitPosition = await this.derivePlanningFirstUnit(
      this.pool,
      userId,
      scope.releaseId,
    );

    // 候选计数来自「全部符合规则的候选卡」，不受预算截断：
    // dueCount/initialCount/newCount 反映当前主课程 current release 中所有可调度卡，
    // noWork 只有当没有任何合格候选才为 true；预算只截断真正生成的计划项。
    const counts = { due: 0, initial: 0, new: 0 };
    for (const c of candidates) {
      const kind = classifyPlanItem(c, now, firstUnitPosition);
      if (kind === "due_review") counts.due++;
      else if (kind === "initial_review") counts.initial++;
      else if (kind === "new_learning") counts.new++;
    }

    // 计划项按预算截断（对应会话快照的实际项）。
    const plan = buildDailyPlan({
      cards: candidates,
      now,
      budgetMinutes,
      firstUnitPosition,
    });

    return { budgetMinutes, counts, items: plan };
  }

  /** 在单事务内完成：读锁主课程、补齐卡、读候选/构建计划、插入 session 与 items。 */
  private async createSessionInTxn(userId: string): Promise<StudySessionDto | { noWork: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. 锁定主课程 current release：FOR UPDATE 确保同一事务内读到一致的 release，
      //    发布切换（UPDATE courses SET current_release_id）在此行上排队，
      //    不会出现「计划读 v1、session 写 v2」的半成品快照。
      const lockResult = await client.query<{
        course_id: string;
        release_id: string;
        release_number: number;
      }>(
        `SELECT c.id AS course_id, r.id AS release_id, r.release_number
         FROM course_enrollments e
         JOIN courses c ON c.id = e.course_id AND c.current_release_id IS NOT NULL
         JOIN course_releases r ON r.id = c.current_release_id
         WHERE e.user_id = $1 AND e.active = true AND e.is_primary = true
           AND c.visibility = 'published' AND c.status = 'active'
         FOR UPDATE OF c`,
        [userId],
      );
      const row = lockResult.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        throw new NotFoundException("尚未设置主课程");
      }
      const scope: CourseScope = {
        courseId: row.course_id,
        releaseId: row.release_id,
        releaseNumber: row.release_number,
      };

      // 2. 幂等补齐双向卡（同一事务内，保证 3. 的候选卡查询能看到刚插入的行）。
      for (const direction of CARD_DIRECTIONS) {
        const errors = validateCardDirection(direction);
        if (errors.length > 0) throw new Error(`无效方向：${errors.join("；")}`);
        await client.query(
          `INSERT INTO learning_cards (user_id, course_id, course_item_id, direction)
           SELECT $1, $2, rci.course_item_id, $3
           FROM released_course_items rci
           WHERE rci.release_id = $4
           ON CONFLICT (user_id, course_item_id, direction) DO NOTHING`,
          [userId, scope.courseId, direction, scope.releaseId],
        );
      }

      // 3. 读预算 + 候选卡（均在锁保护内）。
      const usersResult = await client.query<{ daily_budget_minutes: number }>(
        "SELECT daily_budget_minutes FROM users WHERE id = $1",
        [userId],
      );
      const budgetMinutes = usersResult.rows[0]?.daily_budget_minutes ?? 0;

      const cards = await client.query<PlanCardRow>(
        `SELECT lc.id AS card_id, lc.course_item_id, lc.direction, lc.state, lc.due_at,
                ru.position AS unit_position, rci.position AS item_position
         FROM learning_cards lc
         JOIN released_course_items rci
           ON rci.release_id = $3 AND rci.course_item_id = lc.course_item_id
         JOIN released_units ru ON ru.id = rci.released_unit_id
         WHERE lc.user_id = $1 AND lc.course_id = $2`,
        [userId, scope.courseId, scope.releaseId],
      );

      const plan = buildDailyPlan({
        cards: cards.rows.map((r) => toPlanCardCandidate(r)),
        now: new Date(),
        budgetMinutes,
        firstUnitPosition: await this.derivePlanningFirstUnit(client, userId, scope.releaseId),
      });

      // 无候选 → 不创建空 active 会话。
      if (plan.length === 0) {
        await client.query("ROLLBACK");
        return { noWork: true };
      }

      // 4. 插入会话与计划项（同一事务、同一 release 快照）。
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO study_sessions
           (user_id, course_id, release_id, status, daily_budget_minutes, plan_rule_version, cursor)
         VALUES ($1, $2, $3, 'active', $4, $5, 1)
         ON CONFLICT (user_id) WHERE status = 'active' DO NOTHING
         RETURNING id`,
        [userId, scope.courseId, scope.releaseId, budgetMinutes, PLAN_RULE_VERSION],
      );
      const sessionId = inserted.rows[0]?.id;
      if (!sessionId) {
        // 并发：另一个会话已创建。回滚本事务，返回既有 active 会话。
        await client.query("ROLLBACK");
        const fallback = await this.findActiveSession(userId);
        if (fallback) return fallback;
        throw new NotFoundException("会话创建冲突且无既有会话");
      }

      for (let i = 0; i < plan.length; i++) {
        const item = plan[i] as (typeof plan)[number];
        await client.query(
          `INSERT INTO study_session_items
             (session_id, position, card_id, course_item_id, item_kind)
           VALUES ($1, $2, $3, $4, $5)`,
          [sessionId, i + 1, item.cardId, item.courseItemId, item.itemKind],
        );
      }

      await client.query("COMMIT");

      // 5. 读取完整会话（含计划项数）返回。
      return await this.findOneActiveSession(userId, sessionId);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** 按会话 ID 读取刚创建的 active 会话（供 createSessionInTxn 返回）。 */
  private async findOneActiveSession(userId: string, sessionId: string): Promise<StudySessionDto> {
    const result = await this.pool.query<ActiveSessionRow>(
      `SELECT ss.id AS session_id, ss.course_id, ss.release_id, cr.release_number,
              ss.status, ss.daily_budget_minutes, ss.plan_rule_version,
              ss.planned_at, ss.started_at, ss.cursor,
              (SELECT count(*)::int FROM study_session_items ssi WHERE ssi.session_id = ss.id) AS item_count
       FROM study_sessions ss
       JOIN course_releases cr ON cr.id = ss.release_id
       WHERE ss.user_id = $1 AND ss.id = $2 AND ss.status = 'active'
       LIMIT 1`,
      [userId, sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("会话不存在");
    return this.toSessionDto(row);
  }

  private toSessionDto(row: ActiveSessionRow): StudySessionDto {
    return {
      sessionId: row.session_id,
      courseId: row.course_id,
      releaseId: row.release_id,
      releaseNumber: row.release_number,
      status: row.status,
      dailyBudgetMinutes: row.daily_budget_minutes,
      planRuleVersion: row.plan_rule_version,
      plannedAt: row.planned_at.toISOString(),
      startedAt: row.started_at.toISOString(),
      itemCount: row.item_count,
      cursor: row.cursor,
    };
  }

  // ---- 原内部 helper ----

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

  /** 用户 active primary 报名 + 该课程 current release；无主课程或不可见 → 404。 */
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
       WHERE e.user_id = $1 AND e.active = true AND e.is_primary = true
         AND c.visibility = 'published' AND c.status = 'active'`,
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
