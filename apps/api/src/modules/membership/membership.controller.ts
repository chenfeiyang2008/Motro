// Ticket 20 · membership controller: learner projection + admin grant/renew/revoke.
import {
  Body,
  Controller,
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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles, RolesGuard } from "../../auth/roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import {
  AdminMembershipReadDto,
  AdminDailyLimitResultDto,
  AdminMembershipListDto,
  AdminMembershipListQueryDto,
  AdminMembershipResultDto,
  AdminOkDto,
  DailyUsageSummaryDto,
  GrantMembershipDto,
  MembershipStatusDto,
  RenewMembershipDto,
  SetDailyLimitDto,
} from "./membership.dto.js";
import { MembershipService } from "./membership.service.js";

@ApiTags("membership")
@Controller()
@UseGuards(SessionGuard)
export class MembershipController {
  constructor(private readonly membershipService: MembershipService) {}

  @Get("me/membership")
  @ApiBearerAuth()
  @ApiOperation({ summary: "当前账号会员投影（服务端计算，无敏感字段）" })
  @ApiOkResponse({ type: MembershipStatusDto })
  myMembership(@Req() req: AuthenticatedRequest): Promise<MembershipStatusDto> {
    return this.membershipService.getMembershipProjection(req.user.id);
  }

  @Get("me/daily-usage")
  @ApiBearerAuth()
  @ApiOperation({ summary: "当前账号今日学习时长摘要（服务端事实）" })
  @ApiOkResponse({ type: DailyUsageSummaryDto })
  async dailyUsage(@Req() req: AuthenticatedRequest): Promise<DailyUsageSummaryDto> {
    const summary = await this.membershipService.getDailyUsageSummary(req.user.id);
    const limitMinutes = Number.isFinite(summary.limitMinutes) ? summary.limitMinutes : null;
    return {
      usedMinutes: summary.usedMinutes,
      limitMinutes,
      remainingMinutes:
        limitMinutes === null ? null : Math.max(limitMinutes - summary.usedMinutes, 0),
      resetDay: summary.resetDay,
      membershipStatus: summary.membershipStatus,
    };
  }
}

@ApiTags("admin membership")
@Controller("admin/memberships")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class AdminMembershipController {
  constructor(private readonly membershipService: MembershipService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "会员管理列表（脱敏聚合投影 + 游标分页）" })
  @ApiOkResponse({ type: AdminMembershipListDto })
  list(@Query() query: AdminMembershipListQueryDto): Promise<AdminMembershipListDto> {
    return this.membershipService.listMemberships(query);
  }

  @Get(":userId")
  @ApiBearerAuth()
  @ApiOperation({ summary: "读取指定用户的会员投影（只读；与 /me/membership 同一服务端计算源）" })
  @ApiOkResponse({ type: AdminMembershipReadDto })
  async readMembership(@Param("userId") userId: string): Promise<AdminMembershipReadDto> {
    return this.membershipService.getMembershipForUser(userId);
  }

  @Post(":userId/grant")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "授予/覆盖会员（幂等 + 审计）" })
  @ApiOkResponse({ type: AdminMembershipResultDto })
  grant(
    @Req() req: AuthenticatedRequest,
    @Param("userId") userId: string,
    @Body() dto: GrantMembershipDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.membershipService.grantMembershipIdempotent(
      req.user,
      userId,
      { plan: dto.plan, mode: dto.mode, durationDays: dto.durationDays, expiresAt: dto.expiresAt },
      req.id,
      idempotencyKey,
    );
  }

  @Post(":userId/renew")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "续期会员（幂等 + 审计）" })
  @ApiOkResponse({ type: AdminMembershipResultDto })
  renew(
    @Req() req: AuthenticatedRequest,
    @Param("userId") userId: string,
    @Body() dto: RenewMembershipDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.membershipService.renewMembershipIdempotent(
      req.user,
      userId,
      { mode: dto.mode, durationDays: dto.durationDays, expiresAt: dto.expiresAt },
      req.id,
      idempotencyKey,
    );
  }

  @Post(":userId/revoke")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "撤销会员 → 立即按 free 限制（幂等 + 审计）" })
  @ApiOkResponse({ type: AdminOkDto })
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param("userId") userId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    await this.membershipService.revokeMembershipIdempotent(
      req.user,
      userId,
      req.id,
      idempotencyKey,
    );
    return { ok: true };
  }

  @Patch(":userId/daily-limit")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "设置该用户的非会员每日学习时长（幂等 + 审计）" })
  @ApiOkResponse({ type: AdminDailyLimitResultDto })
  setDailyLimit(
    @Req() req: AuthenticatedRequest,
    @Param("userId") userId: string,
    @Body() dto: SetDailyLimitDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AdminDailyLimitResultDto> {
    return this.membershipService.setDailyLimitIdempotent(
      req.user,
      userId,
      dto.minutes,
      req.id,
      idempotencyKey,
    );
  }
}
