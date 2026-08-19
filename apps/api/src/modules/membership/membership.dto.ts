// Ticket 20 · membership DTOs (public contract). No password/session/audit secrets.
import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsISO8601, IsOptional } from "class-validator";

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

export class GrantMembershipDto {
  @ApiProperty({ enum: ["member", "free"], default: "member" })
  @IsIn(["member"])
  plan!: "member";

  @ApiProperty({ description: "过期时间（ISO8601；null=不限）", required: false, nullable: true })
  @IsOptional()
  @IsISO8601()
  expiresAt!: string | null;
}

export class RenewMembershipDto {
  @ApiProperty({
    description: "新的过期时间（ISO8601；null=不限）",
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  expiresAt!: string | null;
}

export class AdminMembershipResultDto {
  @ApiProperty({ type: MembershipStatusDto })
  membership!: MembershipStatusDto;
}

/** 管理员：读取指定用户的会员投影（只读；与 /me/membership 同一服务端计算源）。 */
export class AdminMembershipReadDto extends MembershipStatusDto {}

export class AdminOkDto {
  @ApiProperty({ description: "操作成功" })
  ok!: boolean;
}
