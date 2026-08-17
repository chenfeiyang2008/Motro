// Ticket 14: server-graded Challenge Quiz controller.
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
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
  async current(@Req() req: AuthenticatedRequest) {
    return this.challengeService.getCurrentChallenge(req.user.id);
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
    @Param("attemptId") attemptId: string,
    @Param("position", new ParseIntPipe()) position: number,
    @Body() body: ChallengeAnswerDto,
  ) {
    return this.challengeService.submitAnswer(
      req.user.id,
      attemptId,
      position,
      body.clientEventId,
      body.answer,
    );
  }
}
