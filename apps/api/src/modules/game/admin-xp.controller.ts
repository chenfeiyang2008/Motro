// 管理端 XP ledger 控制器（Ticket 19）：
//   GET  /admin/xp           → 管理员账本查询（用户/kind 筛选 + keyset 分页）
//   GET  /admin/xp/users     → 用户 XP 汇总（供选择器）
//   POST /admin/xp/void      → append-only 作废一条普通 XP entry（插入负向 void 条目，不 UPDATE 原事实）
//   POST /admin/xp/correct   → append-only 补正一条普通 XP entry（插入 correction 条目）
//
// 隐私/安全：仅返回白名单字段（user_id/username/amount/reason/rule_version/…），
// 绝不返回 password_hash、session token、OTP、provider payload 或内部路径。
// 权限由 SessionGuard + RolesGuard(admin) 强制。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Roles, RolesGuard } from "../../auth/roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import {
  AdminXpCorrectionDto,
  AdminXpEntryDto,
  AdminXpListDto,
  AdminXpUserSummaryListDto,
  AdminXpVoidDto,
} from "./game.dto.js";
import { AdminXpService } from "./admin-xp.service.js";

@ApiTags("admin xp")
@Controller("admin/xp")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class AdminXpController {
  constructor(private readonly service: AdminXpService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "管理员 XP 账本（只读；用户/kind 筛选 + keyset 分页）" })
  @ApiQuery({ name: "userId", required: false, description: "按用户 UUID 筛选" })
  @ApiQuery({
    name: "kind",
    required: false,
    description: "entry kind：initial_review/due_review/correction/void",
  })
  @ApiQuery({ name: "cursor", required: false, description: "keyset 分页游标" })
  @ApiQuery({ name: "limit", required: false, description: "每页数量（1-100，默认 50）" })
  @ApiOkResponse({ type: AdminXpListDto })
  async list(
    @Query("userId") userId?: string,
    @Query("kind") kind?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<AdminXpListDto> {
    const parsedLimit = limit ? Math.min(Math.max(Number(limit) || 50, 1), 100) : undefined;
    const opts: { userId?: string; kind?: string; cursor?: string; limit?: number } = {};
    if (userId !== undefined && userId !== "") opts.userId = userId;
    if (kind !== undefined && kind !== "") opts.kind = kind;
    if (cursor !== undefined && cursor !== "") opts.cursor = cursor;
    if (parsedLimit !== undefined) opts.limit = parsedLimit;
    return this.service.list(opts);
  }

  @Get("users")
  @ApiBearerAuth()
  @ApiOperation({ summary: "用户 XP 汇总（含总额与 correction/void 计数，供选择器）" })
  @ApiQuery({ name: "q", required: false, description: "搜索用户名/显示名" })
  @ApiOkResponse({ type: AdminXpUserSummaryListDto })
  async userSummaries(@Query("q") q?: string): Promise<AdminXpUserSummaryListDto> {
    const opts: { q?: string } = {};
    if (q !== undefined && q !== "") opts.q = q;
    return this.service.userSummaries(opts);
  }

  @Post("void")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({
    summary: "append-only 作废一笔 XP entry（插入负向 void 条目；原事实不 UPDATE/DELETE）",
  })
  @ApiOkResponse({ type: AdminXpEntryDto })
  async void(
    @Req() req: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: AdminXpVoidDto,
  ): Promise<AdminXpEntryDto> {
    const opts: {
      actorId: string;
      targetEntryId: string;
      reason: string;
      idempotencyKey?: string;
      requestId: string;
    } = {
      actorId: req.user.id,
      targetEntryId: body.targetEntryId,
      reason: body.reason,
      requestId: req.id,
    };
    if (idempotencyKey !== undefined) opts.idempotencyKey = idempotencyKey;
    return this.service.voidEntry(opts);
  }

  @Post("correct")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({
    summary: "append-only 补正一笔 XP entry（插入 correction 条目；金额可为正或负）",
  })
  @ApiOkResponse({ type: AdminXpEntryDto })
  async correct(
    @Req() req: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: AdminXpCorrectionDto,
  ): Promise<AdminXpEntryDto> {
    const opts: {
      actorId: string;
      targetEntryId: string;
      amount: number;
      reason: string;
      idempotencyKey?: string;
      requestId: string;
    } = {
      actorId: req.user.id,
      targetEntryId: body.targetEntryId,
      amount: body.amount,
      reason: body.reason,
      requestId: req.id,
    };
    if (idempotencyKey !== undefined) opts.idempotencyKey = idempotencyKey;
    return this.service.correctEntry(opts);
  }
}
