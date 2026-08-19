// 认证 DTO。校验失败由全局 ValidationPipe 转为 422 + fieldErrors。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ description: "登录用户名" })
  @IsString()
  @MinLength(1)
  username!: string;

  @ApiProperty({ description: "密码" })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: "当前密码（或一次性密码）" })
  @IsString()
  currentPassword!: string;

  @ApiProperty({ description: "新密码" })
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class CreateUserDto {
  @ApiProperty({ description: "登录用户名（小写）" })
  @IsString()
  @MinLength(3)
  username!: string;

  @ApiProperty({ description: "显示名" })
  @IsString()
  @MinLength(1)
  displayName!: string;

  @ApiProperty({ description: "IANA 时区" })
  @IsString()
  @MinLength(1)
  timezone!: string;

  @ApiProperty({ description: "每日时间预算（分钟）", minimum: 1, maximum: 120 })
  @IsInt()
  @Min(1)
  @Max(120)
  dailyBudgetMinutes!: number;

  // v1 决策（PRODUCT.md §管理员）：不提供细粒度后台角色，管理员账号数量仍可多于一个；
  // 故允许管理员创建管理员，所有内容操作留审计记录（含被创建角色的 after_summary）。
  @ApiProperty({ enum: ["learner", "admin"], default: "learner" })
  @IsOptional()
  @IsIn(["learner", "admin"])
  role?: "learner" | "admin";
}

// ---- 管理账号响应 DTO（契约投影）----
// 只把可安全暴露的账号字段投影给 /admin/users；绝不包含 password_hash / session / OTP / 审计内部字段。
// status 来自真实数据库 users.status；createdAt 来自真实 users.created_at。

export class AdminUserDto {
  @ApiProperty({ description: "账号 UUID" })
  id!: string;

  @ApiProperty({ description: "登录用户名（小写）" })
  username!: string;

  @ApiProperty({ description: "显示名" })
  displayName!: string;

  @ApiProperty({ enum: ["learner", "admin"] })
  role!: "learner" | "admin";

  @ApiProperty({ description: "IANA 时区" })
  timezone!: string;

  @ApiProperty({ description: "每日学习预算（分钟）", minimum: 1, maximum: 120 })
  dailyBudgetMinutes!: number;

  @ApiProperty({ description: "是否首登必须修改密码" })
  mustChangePassword!: boolean;

  @ApiProperty({ enum: ["active", "disabled"], description: "真实数据库账号状态" })
  status!: "active" | "disabled";

  @ApiProperty({ description: "账号创建时间（ISO 字符串）" })
  createdAt!: string;
}

export class AdminUserListDto {
  @ApiProperty({ type: [AdminUserDto] })
  items!: AdminUserDto[];

  @ApiProperty({ description: "下一页游标；null 表示无更多", required: false })
  nextCursor?: string;

  @ApiProperty({ description: "是否还有更多", required: false })
  hasMore?: boolean;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ description: "显示名" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  displayName?: string;

  @ApiPropertyOptional({ enum: ["learner", "admin"], description: "角色" })
  @IsOptional()
  @IsIn(["learner", "admin"])
  role?: "learner" | "admin";

  @ApiPropertyOptional({ description: "IANA 时区" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  timezone?: string;

  @ApiPropertyOptional({ description: "每日学习预算（分钟）", minimum: 1, maximum: 120 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  dailyBudgetMinutes?: number;

  @ApiPropertyOptional({ description: "是否必须修改密码" })
  @IsOptional()
  @IsBoolean()
  mustChangePassword?: boolean;
}

export class AdminOkDto {
  @ApiProperty({ description: "操作成功" })
  ok!: boolean;
}

export class AdminCreateUserResultDto {
  @ApiProperty({ type: AdminUserDto })
  user!: AdminUserDto;

  @ApiProperty({ description: "一次性密码（仅此一次返回，绝不停留）" })
  oneTimePassword!: string;
}
