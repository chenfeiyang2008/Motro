// Ticket 20 · membership DTOs (public contract). No password/session/audit secrets.
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsISO8601, IsInt, IsOptional, Max, Min } from "class-validator";

export class MembershipStatusDto {
  @ApiProperty({ enum: ["member", "free"], description: "有效会员方案（服务端计算）" })
  plan!: "member" | "free";

  @ApiProperty({
    enum: ["member", "free"],
    description: "有效会员状态：member=active 且未过期；free=无会员/过期/未知（fail-closed）",
  })
  status!: "member" | "free";

  @ApiProperty({
    type: String,
    description: "过期时间（ISO；null=不限）",
    nullable: true,
    required: false,
  })
  expiresAt!: string | null;
}

export class MeDto {
  @ApiProperty({ description: "当前用户 UUID" })
  id!: string;

  @ApiProperty({ description: "登录用户名" })
  username!: string;

  @ApiProperty({ description: "显示名" })
  displayName!: string;

  @ApiProperty({ enum: ["learner", "admin"] })
  role!: "learner" | "admin";

  @ApiProperty({ description: "IANA 时区" })
  timezone!: string;

  @ApiProperty({ enum: ["active", "disabled"] })
  status!: "active" | "disabled";

  @ApiProperty({ description: "是否首登必须改密" })
  mustChangePassword!: boolean;

  @ApiProperty({ type: MembershipStatusDto, description: "会员投影（服务端计算，不返回敏感字段）" })
  membership!: MembershipStatusDto;
}

// ---- 管理员：授予/续期/撤销 ----

/**
 * Server-normalized membership schedule. `expiresAt` remains accepted for
 * backwards compatibility with Ticket 20 clients; new callers should send a
 * mode so the server, rather than the browser clock, owns duration semantics.
 */
export class MembershipScheduleDto {
  @ApiPropertyOptional({ enum: ["duration", "until", "indefinite"] })
  @IsOptional()
  @IsIn(["duration", "until", "indefinite"])
  mode?: "duration" | "until" | "indefinite";

  @ApiPropertyOptional({ description: "时长天数（1-3650）", minimum: 1, maximum: 3650 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

export class GrantMembershipDto extends MembershipScheduleDto {
  @ApiProperty({ enum: ["member"], default: "member" })
  @IsIn(["member"])
  plan!: "member";
}

export class RenewMembershipDto extends MembershipScheduleDto {}

export class SetDailyLimitDto {
  @ApiProperty({ description: "非会员每日学习时长（分钟，0-1440）", minimum: 0, maximum: 1440 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  minutes!: number;
}

export class AdminMembershipResultDto {
  @ApiProperty({ type: MembershipStatusDto })
  membership!: MembershipStatusDto;
}

export class AdminDailyLimitResultDto {
  @ApiProperty({ description: "保存后的非会员每日学习时长（分钟）" })
  dailyLimitMinutes!: number;
}

/** 管理员：读取指定用户的会员投影（只读；与 /me/membership 同一服务端计算源）。 */
export class AdminMembershipReadDto extends MembershipStatusDto {
  @ApiProperty({ description: "非会员每日学习时长（分钟）" })
  dailyLimitMinutes!: number;
}

export class AdminOkDto {
  @ApiProperty({ description: "操作成功" })
  ok!: boolean;
}

export class AdminMembershipListQueryDto {
  @ApiPropertyOptional({ description: "搜索用户名或显示名" })
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ enum: ["free", "member", "expired"] })
  @IsOptional()
  @IsIn(["free", "member", "expired"])
  state?: "free" | "member" | "expired";

  @ApiPropertyOptional({ description: "不透明 keyset 游标" })
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class AdminMembershipListItemDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ enum: ["learner", "admin"] })
  role!: "learner" | "admin";

  @ApiProperty({ enum: ["active", "disabled"] })
  accountStatus!: "active" | "disabled";

  @ApiProperty({ enum: ["free", "member", "expired"] })
  state!: "free" | "member" | "expired";

  @ApiProperty({ enum: ["free", "member"] })
  plan!: "free" | "member";

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ enum: ["grant", "renew", "revoke"], nullable: true })
  lastAction!: "grant" | "renew" | "revoke" | null;

  @ApiProperty({ description: "非会员每日学习时长（分钟）" })
  dailyLimitMinutes!: number;
}

export class AdminMembershipListDto {
  @ApiProperty({ type: () => [AdminMembershipListItemDto] })
  items!: AdminMembershipListItemDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;
}

export class DailyUsageSummaryDto {
  @ApiProperty({ description: "今日已计入学习时长（分钟）" })
  usedMinutes!: number;

  @ApiProperty({ type: Number, description: "每日上限；会员为 null", nullable: true })
  limitMinutes!: number | null;

  @ApiProperty({ type: Number, description: "今日剩余时长；会员为 null", nullable: true })
  remainingMinutes!: number | null;

  @ApiProperty({ description: "按用户时区计算的本地日期" })
  resetDay!: string;

  @ApiProperty({ enum: ["member", "free"] })
  membershipStatus!: "member" | "free";
}
