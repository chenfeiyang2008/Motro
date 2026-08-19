// /admin/users 端点：管理员创建、列表、停用、重置一次性密码（幂等 + 审计）。
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { AuthService, type PublicUser } from "./auth.service.js";
import {
  AdminCreateUserResultDto,
  AdminOkDto,
  AdminUserDto,
  AdminUserListDto,
  CreateUserDto,
  UpdateUserDto,
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
  @ApiOperation({ summary: "列出账号（支持搜索、角色、状态筛选 + keyset 分页）" })
  @ApiOkResponse({ type: AdminUserListDto })
  @ApiQuery({ name: "q", required: false, description: "搜索用户名或显示名" })
  @ApiQuery({ name: "role", required: false, description: "角色筛选：learner/admin" })
  @ApiQuery({ name: "status", required: false, description: "状态筛选：active/disabled" })
  @ApiQuery({ name: "cursor", required: false, description: "keyset 分页游标" })
  @ApiQuery({ name: "limit", required: false, description: "每页数量（1-100，默认 50）" })
  async list(
    @Query("q") q?: string,
    @Query("role") role?: "learner" | "admin",
    @Query("status") status?: "active" | "disabled",
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<{ items: PublicUser[]; nextCursor: string | null; hasMore: boolean }> {
    const parsedLimit = limit ? Math.min(Math.max(Number(limit) || 50, 1), 100) : undefined;
    const opts: {
      q?: string;
      role?: "learner" | "admin";
      status?: "active" | "disabled";
      cursor?: string;
      limit?: number;
    } = {};
    if (q !== undefined && q !== "") opts.q = q;
    if (role !== undefined) opts.role = role;
    if (status !== undefined) opts.status = status;
    if (cursor !== undefined && cursor !== "") opts.cursor = cursor;
    if (parsedLimit !== undefined) opts.limit = parsedLimit;
    return this.authService.listUsers(opts);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "编辑账号显示资料（幂等，需 Idempotency-Key）" })
  @ApiOkResponse({ type: AdminUserDto })
  async update(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: UpdateUserDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<PublicUser> {
    return this.authService.updateUser(req.user, id, body, req.id, idempotencyKey);
  }

  @Post(":id/enable")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "重新启用已停用账号" })
  @ApiOkResponse({ type: AdminUserDto })
  async enable(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.authService.enableUser(req.user, id, req.id);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "删除无业务关联账号（有历史事实时必须停用）" })
  @ApiOkResponse({ type: AdminOkDto, description: "删除成功（OK）" })
  async remove(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    await this.authService.deleteUser(req.user, id, req.id);
    return { ok: true };
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
