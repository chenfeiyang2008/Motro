// Ticket 09 motivation controller: /me/xp, /me/learning-summary, /leaderboard/weekly.
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import {
  LeaderboardQueryDto,
  LeaderboardVisibilityDto,
  LearningSummaryDto,
  MeXpDto,
  WeeklyLeaderboardDto,
} from "./game.dto.js";
import { GameService } from "./game.service.js";

@ApiTags("game")
@Controller()
@UseGuards(SessionGuard)
export class GameController {
  constructor(private readonly gameService: GameService) {}

  @Get("me/xp")
  @ApiBearerAuth()
  @ApiOperation({ summary: "个人学习 XP（只属个人，不参与排行榜）" })
  @ApiOkResponse({ type: MeXpDto })
  async meXp(@Req() req: AuthenticatedRequest): Promise<MeXpDto> {
    return this.gameService.getMeXp(req.user.id);
  }

  @Get("me/learning-summary")
  @ApiBearerAuth()
  @ApiOperation({ summary: "个人学习概览（可重建，不含 XP/排行榜/CEFR）" })
  @ApiOkResponse({ type: LearningSummaryDto })
  async learningSummary(@Req() req: AuthenticatedRequest): Promise<LearningSummaryDto> {
    return this.gameService.getLearningSummary(req.user.id);
  }

  @Get("leaderboard/weekly")
  @ApiBearerAuth()
  @ApiOperation({ summary: "周挑战榜（仅挑战积分；日常 XP 不参与；支持周期/游标分页）" })
  @ApiOkResponse({ type: WeeklyLeaderboardDto })
  async weeklyLeaderboard(
    @Req() req: AuthenticatedRequest,
    @Query() query: LeaderboardQueryDto,
  ): Promise<WeeklyLeaderboardDto> {
    return this.gameService.getWeeklyLeaderboard(req.user.id, query);
  }

  @Post("leaderboard/visibility")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "设置周挑战榜公开参与状态（默认公开；退出仅隐藏公开行，保留积分/名次）。幂等：Idempotency-Key 可选。",
  })
  @ApiOkResponse({ type: LeaderboardVisibilityDto })
  async setVisibility(
    @Req() req: AuthenticatedRequest,
    @Body() dto: LeaderboardVisibilityDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<{ isPublic: boolean }> {
    return this.gameService.setLeaderboardVisibility(req.user.id, dto.public, idempotencyKey);
  }
}
