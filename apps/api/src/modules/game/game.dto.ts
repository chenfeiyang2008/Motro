// Ticket 09 motivation DTOs: /me/xp, /me/learning-summary, /leaderboard/weekly.
// Response DTOs are OpenAPI-only (no class-validator needed on plain responses).
// Privacy: only display_name is exposed on the leaderboard; never username/user_id.
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from "class-validator";

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
  @ApiProperty({ description: "当前登录用户的公开排名（未上榜/退出则为 null）" })
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
