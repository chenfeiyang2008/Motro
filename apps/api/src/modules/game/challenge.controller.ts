// Ticket 14: server-graded Challenge Quiz controller.
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import { DailyUsageLimitError } from "../membership/membership.service.js";
import { ChallengeAnswerDto, ChallengeCurrentDto } from "./challenge.dto.js";
import { ChallengeService } from "./challenge.service.js";

@ApiTags("challenge")
@Controller("challenge")
@UseGuards(SessionGuard)
export class ChallengeController {
  constructor(private readonly challengeService: ChallengeService) {}

  @Get("current")
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "获取当前周的挑战测验（10 题冻结快照）。仅返回服务端已确认的题面，不含 provider payload / 内部路径 / 密钥。",
  })
  @ApiOkResponse({ type: ChallengeCurrentDto })
  async current(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      return await this.challengeService.getCurrentChallenge(req.user.id);
    } catch (err) {
      if (err instanceof DailyUsageLimitError) {
        reply.status(429);
        return {
          error: {
            code: "DAILY_USAGE_LIMIT_REACHED",
            message: err.message,
            requestId: req.id,
            retryable: false,
            usedMinutes: err.usedMinutes,
            limitMinutes: err.limitMinutes,
            resetDay: err.resetDay,
          },
        };
      }
      throw err;
    }
  }

  @Post("attempts/:attemptId/answers/:position")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "提交一道挑战答案，服务端判分。幂等：client_event_id。本题对且词方向本周首答得 5 分；否则 0 分。",
  })
  @ApiOkResponse({ type: ChallengeAnswerDto })
  async submit(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("attemptId", new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }))
    attemptId: string,
    @Param("position", new ParseIntPipe()) position: number,
    @Body() body: ChallengeAnswerDto,
  ) {
    try {
      return await this.challengeService.submitAnswer(
        req.user.id,
        attemptId,
        position,
        body.clientEventId,
        body.answer,
      );
    } catch (err) {
      if (err instanceof DailyUsageLimitError) {
        reply.status(429);
        return {
          error: {
            code: "DAILY_USAGE_LIMIT_REACHED",
            message: err.message,
            requestId: req.id,
            retryable: false,
            usedMinutes: err.usedMinutes,
            limitMinutes: err.limitMinutes,
            resetDay: err.resetDay,
          },
        };
      }
      throw err;
    }
  }
}
