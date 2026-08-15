// 工单 09：可重建学习指标——API 响应 DTO（OpenAPI 可生成）。
//
// 由 NestJS @nestjs/swagger 装饰器产生 JSON Schema。不包含 XP / 排行榜 / CEFR 字段。
// 所有字段都可由 review_events / learning_cards / study_sessions / learning_exposures 完全重建。
import { ApiProperty } from "@nestjs/swagger";

export class MetricScopeDto {
  @ApiProperty({
    description: "指标事实来源表",
    example: "learning_cards,review_events,study_sessions",
  })
  source!: string;
  @ApiProperty({ description: "计算截止时刻（ISO 8601，UTC）" })
  asOf!: string;
  @ApiProperty({ description: "用户 timezone", example: "Asia/Shanghai" })
  timezone!: string;
  @ApiProperty({ description: "去重规则说明" })
  dedup!: string;
}

export class StableWordsDto {
  @ApiProperty({ description: "全局（所有课程）已稳定词项数" })
  globalCount!: number;
  @ApiProperty({ description: "用户 timezone" })
  timezone!: string;
  @ApiProperty({ description: "计算截止时刻" })
  asOf!: string;
}

export class CurrentCourseStableWordsDto {
  @ApiProperty({ description: "主课程 ID" })
  courseId!: string;
  @ApiProperty({ description: "主课程当前 release 中的词项数" })
  courseItemCount!: number;
  @ApiProperty({ description: "已稳定词项数（双向 scheduled_days >= 21）" })
  stableCount!: number;
  @ApiProperty({ description: "用户 timezone" })
  timezone!: string;
  @ApiProperty({ description: "计算截止时刻" })
  asOf!: string;
}

export class DueReviewCountDto {
  @ApiProperty({ description: "当前待复习词项数（去重：每 item 至多计 1）" })
  count!: number;
  @ApiProperty({ description: "计算截止时刻（ISO 8601，UTC）" })
  asOf!: string;
  @ApiProperty({ description: "用户 timezone" })
  timezone!: string;
}

export class DailyRhythmPointDto {
  @ApiProperty({ description: "本地日键 YYYY-MM-DD", example: "2026-08-14" })
  day!: string;
  @ApiProperty({ description: "当日有效 review 事件数（同一 client_event_id 去重）" })
  reviewCount!: number;
}

export class SevenDayRhythmDto {
  @ApiProperty({ description: "用户 timezone" })
  timezone!: string;
  @ApiProperty({ description: "区间最早日（YYYY-MM-DD，用户本地日）" })
  startDay!: string;
  @ApiProperty({ description: "区间最晚日（YYYY-MM-DD，用户本地日）" })
  endDay!: string;
  @ApiProperty({ type: [DailyRhythmPointDto], description: "各日的复习事件数" })
  daily!: DailyRhythmPointDto[];
  @ApiProperty({ description: "区间总复习次数" })
  total!: number;
}

export class SessionsDto {
  @ApiProperty({ description: "历史会话总次数（status IN active/completed/abandoned）" })
  sessionCount!: number;
  @ApiProperty({ description: "已完成（status='completed'）会话数" })
  completedCount!: number;
  @ApiProperty({ description: "已完成会话累计时长（分钟），由 started_at→completed_at 计算" })
  totalDurationMinutes!: number;
  @ApiProperty({ description: "计算截止时刻" })
  asOf!: string;
}

export class CourseCompletionDto {
  @ApiProperty({ description: "主课程 ID" })
  courseId!: string;
  @ApiProperty({ description: "当前 release 中的词项总数" })
  totalItemCount!: number;
  @ApiProperty({ description: "双向首测完成数" })
  initiallyCompletedItemCount!: number;
  @ApiProperty({ description: "完成度 0..1", example: 0.6 })
  ratio!: number;
}

export class LearningMetricsDto {
  @ApiProperty({ type: MetricScopeDto, description: "指标元信息" })
  scope!: MetricScopeDto;
  @ApiProperty({ type: StableWordsDto, description: "全局已稳定词项" })
  stableWords!: StableWordsDto;
  @ApiProperty({ type: CurrentCourseStableWordsDto, description: "当前课程已稳定词项" })
  currentCourseStableWords!: CurrentCourseStableWordsDto;
  @ApiProperty({ type: DueReviewCountDto, description: "待复习词项数" })
  dueReviews!: DueReviewCountDto;
  @ApiProperty({ type: SevenDayRhythmDto, description: "过去 7 日学习节奏" })
  sevenDayRhythm!: SevenDayRhythmDto;
  @ApiProperty({ type: SessionsDto, description: "学习会话统计" })
  sessions!: SessionsDto;
  @ApiProperty({ type: CourseCompletionDto, description: "当前课程完成度" })
  currentCourseCompletion!: CourseCompletionDto;
}
