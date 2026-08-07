// 学习模块服务（阶段 5 工单 01/03：学习卡、学习展示、每日计划与学习会话）。
// 只操作 current release 的 released_course_items，绝不读草稿表；只作用于当前登录用户。
// 卡片创建是幂等的按需同步（ensureCourseCards）：把作用域课程的 current release 词项补齐双向卡，
// 课程版本变更/指针切换不破坏历史卡。学习展示幂等且不可变，不改变任何卡状态。
// 会话创建用数据库部分唯一索引作最终并发防线：一个用户至多一个 active 会话。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  buildDailyPlan,
  CARD_DIRECTIONS,
  classifyPlanItem,
  PLAN_RULE_VERSION,
  validateCardDirection,
  type CardDirection,
  type PlanCardCandidate,
  type PlanItem,
} from "@motro/domain";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import type {
  LearningCardListItemDto,
  LearningCardListDto,
  LearningCardSummaryDto,
  LearningExposureDto,
  StudySessionDetailDto,
  StudySessionDto,
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

  // ---- 内部 ----

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

    // 候选计数来自「全部符合规则的候选卡」，不受预算截断：
    // dueCount/initialCount/newCount 反映当前主课程 current release 中所有可调度卡，
    // noWork 只有当没有任何合格候选才为 true；预算只截断真正生成的计划项。
    const counts = { due: 0, initial: 0, new: 0 };
    for (const c of candidates) {
      const kind = classifyPlanItem(c, now, 1);
      if (kind === "due_review") counts.due++;
      else if (kind === "initial_review") counts.initial++;
      else if (kind === "new_learning") counts.new++;
    }

    // 计划项按预算截断（对应会话快照的实际项）。
    const plan = buildDailyPlan({
      cards: candidates,
      now,
      budgetMinutes,
      firstUnitPosition: 1,
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
        firstUnitPosition: 1,
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
