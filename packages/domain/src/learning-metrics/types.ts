// 工单 09：可重建学习指标——只读响应类型（纯领域定义，不依赖 Nest）。
//
// 每个指标都标注：来源事实表、asOf（截止时刻）、timezone、去重规则，满足工单 09
// 「所有指标必须标明事实来源、时间范围、timezone、去重规则」。
// 不返回任何 XP / 排行榜 / 会员 / CEFR 字段。

export interface MetricScopeInfo {
  /** 该指标事实来自哪个表系。 */
  source: string;
  /** 计算截止时刻（ISO 8601，UTC）。 */
  asOf: string;
  /** 日期边界所采用的用户 timezone。 */
  timezone: string;
  /** 去重规则：同一 client_event_id / 同一 (user,item,direction) 是否唯一。 */
  dedup: string;
}

export interface StableWordCountMetric {
  globalCount: number;
  timezone: string;
  asOf: string;
}

export interface CurrentCourseStableWordCountMetric {
  courseId: string;
  courseItemCount: number;
  stableCount: number;
  timezone: string;
  asOf: string;
}

export interface DueReviewCountMetric {
  count: number;
  asOf: string;
  timezone: string;
}

export interface DailyRhythmPoint {
  day: string;
  reviewCount: number;
}

export interface SevenDayRhythmMetric {
  timezone: string;
  startDay: string;
  endDay: string;
  daily: DailyRhythmPoint[];
  total: number;
}

export interface SessionMetric {
  sessionCount: number;
  /** 已完成（status='completed'）会话数。 */
  completedCount: number;
  /** 已完成会话总时长（分钟），依据 started_at→completed_at。 */
  totalDurationMinutes: number;
  asOf: string;
}

export interface CourseCompletionMetric {
  courseId: string;
  totalItemCount: number;
  initiallyCompletedItemCount: number;
  /** 0..1 的完成度。 */
  ratio: number;
}

export interface LearningMetrics {
  scope: MetricScopeInfo;
  stableWords: StableWordCountMetric;
  currentCourseStableWords: CurrentCourseStableWordCountMetric;
  dueReviews: DueReviewCountMetric;
  sevenDayRhythm: SevenDayRhythmMetric;
  sessions: SessionMetric;
  currentCourseCompletion: CourseCompletionMetric;
}
