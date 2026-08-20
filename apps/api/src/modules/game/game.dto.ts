// Ticket 09 motivation DTOs: /me/xp, /me/learning-summary, /leaderboard/weekly.
// Response DTOs are OpenAPI-only (no class-validator needed on plain responses).
// Privacy: only display_name is exposed on the leaderboard; never username/user_id.
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class XpSummaryEntryDto {
  @ApiProperty({ description: "XP 事实金额（correction/void 可为负）" })
  amount!: number;
  @ApiProperty({ description: "原因：initial_review / due_review / correction / void" })
  reason!: string;
  @ApiProperty({ description: "规则版本" })
  ruleVersion!: number;
  @ApiProperty({ description: "获得时间（ISO 8601 UTC）" })
  earnedAt!: string;
}

export class MeXpDto {
  @ApiProperty({ description: "个人学习 XP 总额（只属个人，不参与排行榜）" })
  totalXp!: number;
  @ApiProperty({ type: [XpSummaryEntryDto], description: "XP 明细（按时间倒序）" })
  entries!: XpSummaryEntryDto[];
  @ApiProperty({ description: "当前规则版本" })
  ruleVersion!: number;
  @ApiProperty({ description: "当前永久段位" })
  level!: number;
  @ApiProperty({ description: "当前段位头衔" })
  title!: string;
  @ApiProperty({ description: "当前段位稳定键" })
  titleKey!: string;
  @ApiProperty({ description: "当前段位门槛 XP" })
  levelThreshold!: number;
  @ApiProperty({ nullable: true, type: Number, description: "下一段位；最高段位为 null" })
  nextLevel!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: "下一段位门槛；最高段位为 null" })
  nextLevelThreshold!: number | null;
  @ApiProperty({ description: "当前段位内进度 XP" })
  progressXp!: number;
  @ApiProperty({ description: "当前段位内进度百分比" })
  progressPercent!: number;
  @ApiProperty({ description: "计算截止时刻" })
  asOf!: string;
}

export class LearningSummaryDto {
  @ApiProperty({ description: "已接触全局词条数（来自 learning_exposures，去重）" })
  exposedLexicalEntryCount!: number;
  @ApiProperty({ description: "已完成双向首测的课程词项数" })
  initiallyReviewedCourseItemCount!: number;
  @ApiProperty({ description: "已稳定全局词条数（双向 scheduled_days ≥21）" })
  stableLexicalEntryCount!: number;
  @ApiProperty({ description: "到期复习负荷（当前主课程 state=review 且 due ≤ now）" })
  dueReviewCount!: number;
  @ApiProperty({ description: "计算截止时刻" })
  asOf!: string;
}

export class LeaderboardRowDto {
  @ApiProperty({ description: "参与者显示名（安全别名；非 username / user_id）" })
  displayName!: string;
  @ApiProperty({ description: "本周挑战积分（仅挑战积分，非日常 XP）" })
  challengePoints!: number;
  @ApiProperty({ description: "dense rank（并列者共享名次）" })
  rank!: number;
  @ApiProperty({ description: "该参与者是否为有效会员（VIP 标识，服务端计算）" })
  isMember!: boolean;
}

export class WeeklyLeaderboardDto {
  @ApiProperty({ description: "挑战周键，例如 cw-2026-08-11" })
  challengeWeek!: string;
  @ApiProperty({ description: "周期起点（Asia/Shanghai 周一 00:00 UTC ISO）" })
  weekStart!: string;
  @ApiProperty({ description: "周期终点（下一周一 00:00 UTC ISO，开区间）" })
  weekEnd!: string;
  @ApiProperty({ description: "固定挑战周时区" })
  timezone!: string;
  @ApiProperty({ type: [LeaderboardRowDto], description: "当前周公开行（分页）" })
  rows!: LeaderboardRowDto[];
  @ApiProperty({ description: "当周参与用户总数（含退出公开榜者）" })
  totalParticipants!: number;
  @ApiProperty({ description: "是否有下一页（游标分页）" })
  hasMore!: boolean;
  @ApiPropertyOptional({ description: "下一页游标" })
  nextCursor?: string;
  @ApiProperty({
    description:
      "当前登录用户的排名。可见（未退出 + 未停用）时与公开 rows 中该用户行完全一致；退出/停用时为私有名次（不公开）",
    nullable: true,
  })
  viewerRank!: number | null;
  @ApiProperty({ description: "当前登录用户的挑战积分" })
  viewerChallengePoints!: number;
  @ApiProperty({ description: "计算截止时刻" })
  asOf!: string;
}

/** 排行榜查询参数（可选周期键 + 游标分页）。 */
export class LeaderboardQueryDto {
  @ApiPropertyOptional({
    description: "挑战周键（默认当前周）；非法时返回 422",
    example: "cw-2026-08-11",
  })
  @IsOptional()
  @IsString()
  @Matches(/^cw-\d{4}-\d{2}-\d{2}$/, { message: "challengeWeek 格式应为 cw-YYYY-MM-DD" })
  challengeWeek?: string;

  @ApiPropertyOptional({ description: "游标分页键（上一次响应返回）" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  cursor?: string;

  @ApiPropertyOptional({ description: "每页行数，默认 20，最大 100" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** 排行榜可见性（opt-in/out 官方占位；当前规格允许时实现）。 */
export class LeaderboardVisibilityDto {
  @ApiProperty({ description: "true=公开参与（默认）；false=退出公开榜单" })
  @IsIn([true, false])
  public!: boolean;
}

// ---- 管理端 XP ledger DTOs（Ticket 19） ----

export class AdminXpEntryDto {
  @ApiProperty({ description: "XP entry ID" })
  id!: string;

  @ApiProperty({ description: "用户 ID" })
  userId!: string;

  @ApiProperty({ description: "用户名" })
  username?: string;

  @ApiProperty({ description: "关联的 review event ID" })
  reviewEventId!: string;

  @ApiProperty({ description: "规则版本" })
  ruleVersion!: number;

  @ApiProperty({ description: "XP 金额（correction/void 为负）" })
  amount!: number;

  @ApiProperty({ description: "reason：initial_review / due_review / correction / void" })
  reason!: string;

  @ApiProperty({ description: "关联的目标 XP entry ID（correction/void 时存在）" })
  referencesXpEntryId?: string;

  @ApiProperty({ description: "来源事件 ID" })
  sourceEventId!: string;

  @ApiProperty({ description: "获得时间" })
  earnedAt!: string;

  @ApiProperty({ description: "记录创建时间" })
  createdAt!: string;
}

export class AdminXpListDto {
  @ApiProperty({ type: [AdminXpEntryDto] })
  items!: AdminXpEntryDto[];

  @ApiProperty({ description: "下一页游标；null 表示无更多" })
  nextCursor?: string;

  @ApiProperty({ description: "是否还有更多" })
  hasMore!: boolean;
}

export class AdminXpUserSummaryDto {
  @ApiProperty({ description: "用户 ID" })
  userId!: string;

  @ApiProperty({ description: "用户名" })
  username!: string;

  @ApiProperty({ description: "显示名" })
  displayName!: string;

  @ApiProperty({ description: "累计获奖 XP（不含 correction/void）" })
  grossXp!: number;

  @ApiProperty({ description: "净 XP（含 correction/void 调整）" })
  netXp!: number;

  @ApiProperty({ description: "correction/void 调整合计" })
  adjustmentXp!: number;

  @ApiProperty({ description: "XP entry 总数" })
  entryCount!: number;
}

export class AdminXpUserSummaryListDto {
  @ApiProperty({ type: [AdminXpUserSummaryDto] })
  items!: AdminXpUserSummaryDto[];
}

export class AdminXpVoidDto {
  @ApiProperty({ description: "目标 XP entry ID（必须是正向获奖 entry）" })
  targetEntryId!: string;

  @ApiProperty({ description: "作废理由" })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AdminXpCorrectionDto {
  @ApiProperty({ description: "目标 XP entry ID（必须是正向获奖 entry）" })
  targetEntryId!: string;

  @ApiProperty({ description: "补正金额（正数=增加，负数=减少）" })
  @IsInt()
  amount!: number;

  @ApiProperty({ description: "补正理由" })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
