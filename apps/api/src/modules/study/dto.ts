// 学习模块 DTO（阶段 5 工单 01/03：学习卡与学习展示、每日计划与学习会话）。
// 请求校验（ValidationPipe → 422 fieldErrors）与 OpenAPI 响应形状。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MinLength } from "class-validator";

// ---- 请求 ----

export class CreateExposureDto {
  @ApiProperty({
    description: "已发布课程词项的稳定 course_item_id（必须是已报名课程 current release 中的词项）",
  })
  @IsString()
  @MinLength(1)
  courseItemId!: string;
}

export class LearningCardListQueryDto {
  @ApiPropertyOptional({
    description: "按已报名课程过滤；省略时默认主课程。必须属于当前用户，否则 404",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  courseId?: string;
}

// ---- 响应（OpenAPI 形状） ----

export class LearningCardSummaryCountsDto {
  @ApiProperty({ description: "卡总数" })
  total!: number;

  @ApiProperty({ description: "new 状态卡数（待首测）" })
  new!: number;

  @ApiProperty({ description: "learning 状态卡数" })
  learning!: number;

  @ApiProperty({ description: "review 状态卡数" })
  review!: number;

  @ApiProperty({ description: "英文→中文方向卡数" })
  enToZh!: number;

  @ApiProperty({ description: "中文→英文方向卡数" })
  zhToEn!: number;
}

export class LearningCardSummaryDto {
  @ApiProperty({ description: "主课程 ID" })
  courseId!: string;

  @ApiProperty({ description: "主课程当前版本 release ID" })
  releaseId!: string;

  @ApiProperty({ description: "主课程当前版本号" })
  releaseNumber!: number;

  @ApiProperty({ description: "当前版本课程词项数" })
  itemCount!: number;

  @ApiProperty({ type: LearningCardSummaryCountsDto, description: "学习卡计数（按方向/状态）" })
  cards!: LearningCardSummaryCountsDto;

  @ApiProperty({ description: "已记录学习展示的词项数（每词项至多一次）" })
  exposedItemCount!: number;
}

export class LearningCardListItemDto {
  @ApiProperty({ description: "学习卡 ID" })
  cardId!: string;

  @ApiProperty({ description: "课程 ID" })
  courseId!: string;

  @ApiProperty({ description: "查询时刻课程的 current release ID" })
  releaseId!: string;

  @ApiProperty({ description: "稳定课程词项 ID" })
  courseItemId!: string;

  @ApiProperty({ enum: ["en_to_zh", "zh_to_en"], description: "卡方向" })
  direction!: string;

  @ApiProperty({ enum: ["new", "learning", "review"], description: "记忆状态" })
  state!: string;

  @ApiProperty({ description: "FSRS 稳定性" })
  stability!: number;

  @ApiProperty({ description: "FSRS 难度" })
  difficulty!: number;

  @ApiProperty({ description: "预计间隔天数" })
  scheduledDays!: number;

  @ApiProperty({ description: "距上次复习经过天数" })
  elapsedDays!: number;

  @ApiProperty({ description: "复习次数" })
  reps!: number;

  @ApiProperty({ description: "遗忘次数" })
  lapses!: number;

  @ApiProperty({ type: String, nullable: true, description: "上次复习时间（new 卡为 null）" })
  lastReviewAt!: string | null;

  @ApiProperty({ description: "到期时间（new 卡为创建时刻，待首测）" })
  dueAt!: string;

  @ApiProperty({ description: "调度器版本（阶段 5 工单 01 恒为 fsrs-v6）" })
  schedulerVersion!: string;

  @ApiProperty({ description: "词项英文拼写（来自 current release 快照）" })
  englishSpelling!: string;

  @ApiProperty({ description: "词项中文释义（来自 current release 快照）" })
  meaning!: string;

  @ApiProperty({ description: "该词项是否已记录学习展示" })
  exposed!: boolean;
}

export class LearningCardListDto {
  @ApiProperty({ type: [LearningCardListItemDto], description: "按单元/词项位置排序的学习卡状态" })
  items!: LearningCardListItemDto[];
}

export class LearningExposureDto {
  @ApiProperty({ description: "学习展示记录 ID" })
  exposureId!: string;

  @ApiProperty({ description: "稳定课程词项 ID" })
  courseItemId!: string;

  @ApiProperty({ description: "引用的全局词条 ID" })
  lexicalEntryId!: string;

  @ApiProperty({ description: "课程 ID" })
  courseId!: string;

  @ApiProperty({ description: "首次展示时该课程的 current release ID（首次事实不可变）" })
  releaseId!: string;

  @ApiProperty({ description: "首次展示时间（重复提交返回原值）" })
  firstExposedAt!: string;

  @ApiProperty({ description: "本次是否为幂等重放（false=首次写入，true=已存在）" })
  alreadyExisted!: boolean;
}

// ---- 每日计划（工单 03） ----

export class TodayCountsDto {
  @ApiProperty({ description: "到期复习卡数（state=review 且 due_at <= now）" })
  dueCount!: number;

  @ApiProperty({ description: "首次复习卡数（state=learning）" })
  initialCount!: number;

  @ApiProperty({ description: "新卡数（state=new，仅 first unit 内）" })
  newCount!: number;
}

export class TodayDto {
  @ApiProperty({ description: "主课程 ID" })
  courseId!: string;

  @ApiProperty({ description: "主课程当前版本 release ID" })
  releaseId!: string;

  @ApiProperty({ description: "主课程当前版本号" })
  releaseNumber!: number;

  @ApiProperty({ description: "用户每日预算（分钟）" })
  dailyBudgetMinutes!: number;

  @ApiProperty({ type: TodayCountsDto, description: "计划候选数" })
  counts!: TodayCountsDto;

  @ApiProperty({ description: "当前是否存在可恢复的 active 会话" })
  hasActiveSession!: boolean;

  @ApiProperty({ description: "true 表示本次查询下无任何候选卡（预算和卡计数为 0）" })
  noWork!: boolean;
}

export class StudySessionItemDto {
  @ApiProperty({ description: "计划项 ID" })
  itemId!: string;

  @ApiProperty({ description: "会话内展示顺序位置" })
  position!: number;

  @ApiProperty({ description: "学习卡 ID" })
  cardId!: string;

  @ApiProperty({ description: "稳定课程词项 ID" })
  courseItemId!: string;

  @ApiProperty({ description: "课程 ID" })
  courseId!: string;

  @ApiProperty({
    enum: ["due_review", "initial_review", "new_learning"],
    description: "计划项分类",
  })
  itemKind!: string;

  @ApiProperty({
    enum: ["pending", "shown", "completed", "skipped_by_server"],
    description: "计划项状态",
  })
  state!: string;
}

export class StudySessionDto {
  @ApiProperty({ description: "会话 ID" })
  sessionId!: string;

  @ApiProperty({ description: "课程 ID" })
  courseId!: string;

  @ApiProperty({ description: "会话创建时冻结的 current release ID" })
  releaseId!: string;

  @ApiProperty({ description: "主课程当前版本号" })
  releaseNumber!: number;

  @ApiProperty({ enum: ["active", "completed", "abandoned"], description: "会话状态" })
  status!: string;

  @ApiProperty({ description: "用户每日预算（分钟）" })
  dailyBudgetMinutes!: number;

  @ApiProperty({ description: "计划规则版本" })
  planRuleVersion!: string;

  @ApiProperty({ description: "计划创建时间" })
  plannedAt!: string;

  @ApiProperty({ description: "会话开始时间" })
  startedAt!: string;

  @ApiProperty({ description: "计划项数（总预算截断后的实际项数）" })
  itemCount!: number;

  @ApiProperty({ description: "当前 cursor（下一个待展示项的 position）" })
  cursor!: number;
}

export class StudySessionDetailDto {
  @ApiProperty({ type: StudySessionDto, description: "会话头" })
  session!: StudySessionDto;

  @ApiProperty({ type: [StudySessionItemDto], description: "按 position 排序的计划项" })
  items!: StudySessionItemDto[];
}
