// /admin/users 端点：管理员创建、列表、停用、重置一次性密码（幂等 + 审计）。
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { AuthService, type PublicUser } from "./auth.service.js";
import {
  AdminCreateUserResultDto,
  AdminOkDto,
  AdminUserDto,
  AdminUserListDto,
  CreateUserDto,
} from "./dto.js";
import { Roles, RolesGuard } from "./roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "./session.guard.js";

@ApiTags("admin users")
@Controller("admin/users")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class AdminUsersController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: "创建受邀账号，返回一次性密码（仅此一次）" })
  @ApiCreatedResponse({ type: AdminCreateUserResultDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateUserDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.authService.createUserIdempotent(
      req.user,
      {
        username: dto.username,
        displayName: dto.displayName,
        timezone: dto.timezone,
        dailyBudgetMinutes: dto.dailyBudgetMinutes,
        role: dto.role ?? "learner",
      },
      req.id,
      idempotencyKey,
    );
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "列出账号" })
  @ApiOkResponse({ type: AdminUserListDto })
  async list(): Promise<{ items: PublicUser[] }> {
    const items = await this.authService.listUsers();
    return { items };
  }

  @Get(":id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "查看账号安全字段" })
  @ApiOkResponse({ type: AdminUserDto })
  get(@Param("id") id: string): Promise<PublicUser> {
    return this.authService.getUserPublic(id);
  }

  @Post(":id/disable")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "停用账号并撤销其全部会话" })
  @ApiOkResponse({ type: AdminOkDto, description: "停用成功（OK）" })
  async disable(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    await this.authService.disableUser(req.user, id, req.id);
    return { ok: true };
  }

  @Post(":id/reset-password")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "重置一次性密码并撤销全部会话" })
  @ApiOkResponse({ type: AdminCreateUserResultDto })
  reset(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.authService.resetPasswordIdempotent(req.user, id, req.id, idempotencyKey);
  }
}
