// 认证 DTO。校验失败由全局 ValidationPipe 转为 422 + fieldErrors。
import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from "class-validator";

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
  @MinLength(10)
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
