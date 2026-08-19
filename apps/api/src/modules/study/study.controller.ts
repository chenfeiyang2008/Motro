// /study 端点（阶段 5 工单 01/03：学习卡、学习展示、每日计划与学习会话）。
// 只读当前登录用户自己的数据：学习卡只来自已报名课程的 current release（绝不读草稿），
// 学习展示幂等且不可变；计划与会话只读/创建当前用户自己的主课程计划。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import {
  CreateExposureDto,
  LearningCardListDto,
  LearningCardListQueryDto,
  LearningCardSummaryDto,
  LearningExposureDto,
  ProgressDto,
  RevealResultDto,
  StudySessionDetailDto,
  StudySessionDto,
  SubmitReviewDto,
  SubmitReviewResultDto,
  TodayDto,
} from "./dto.js";
import {
  IdempotencyConflictError,
  ReviewItemNotFoundError,
  ReviewValidationError,
  StudyService,
} from "./study.service.js";
import { DailyUsageLimitError } from "../membership/membership.service.js";

@ApiTags("study")
@Controller("study")
@UseGuards(SessionGuard)
export class StudyController {
  constructor(private readonly studyService: StudyService) {}

  @Get("cards/summary")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "当前用户主课程的学习卡摘要（幂等补齐 current release 双向卡后统计）",
  })
  @ApiOkResponse({ type: LearningCardSummaryDto })
  summary(@Req() req: AuthenticatedRequest) {
    return this.studyService.getCardSummary(req.user.id);
  }

  @Get("cards")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "当前用户自己的学习卡状态列表（默认主课程，可按已报名课程过滤）",
  })
  @ApiOkResponse({ type: LearningCardListDto })
  cards(@Req() req: AuthenticatedRequest, @Query() query: LearningCardListQueryDto) {
    return this.studyService.listCards(req.user.id, query.courseId);
  }

  @Post("exposures")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "记录当前用户某课程词项学习面首次展示（幂等；只允许已报名课程 current release 词项，不改 FSRS，不产生复习/XP）",
  })
  @ApiOkResponse({ type: LearningExposureDto })
  expose(@Req() req: AuthenticatedRequest, @Body() dto: CreateExposureDto) {
    return this.studyService.recordExposure(req.user.id, dto.courseItemId, req.id);
  }

  @Get("today")
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "今日概览：主课程、预算、计划候选数（due/initial/new）、是否有 active 会话、是否无任务（只读）",
  })
  @ApiOkResponse({ type: TodayDto })
  today(@Req() req: AuthenticatedRequest) {
    return this.studyService.getToday(req.user.id);
  }

  @Post("sessions")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "创建或恢复当前用户唯一 active 会话（幂等；刷新/重复调用返回同一会话；无候选返回 noWork，不创建空会话）",
  })
  @ApiOkResponse({ type: StudySessionDto })
  createOrResume(@Req() req: AuthenticatedRequest) {
    return this.studyService.createOrResumeSession(req.user.id);
  }

  @Get("sessions/active")
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "读取当前用户 active 会话详情（会话头 + 按 position 有序计划项）；无 active 会话 → 404",
  })
  @ApiOkResponse({ type: StudySessionDetailDto })
  activeDetail(@Req() req: AuthenticatedRequest) {
    return this.studyService.getActiveSessionDetail(req.user.id);
  }

  @Post("sessions/:sessionId/items/:itemId/reveal")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "展示确认：把当前 cursor 所指的 pending 计划项标记为 shown（幂等；重复 reveal 返回已 shown 状态，不产生 ReviewEvent/不改 FSRS/不推进 cursor）",
  })
  @ApiOkResponse({ type: RevealResultDto })
  async reveal(
    @Req() req: AuthenticatedRequest,
    @Param("sessionId") sessionId: string,
    @Param("itemId") itemId: string,
  ) {
    return await this.studyService.revealItem(req.user.id, sessionId, itemId);
  }

  @Post("sessions/:sessionId/reviews")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "评分提交：对当前 cursor 所指、已 reveal 的计划项提交四级评分；幂等键去重（同请求重放，不同请求 409 IDEMPOTENCY_CONFLICT），事务内原子结算 FSRS 与 cursor",
  })
  @ApiOkResponse({ type: SubmitReviewResultDto })
  async submitReview(
    @Req() req: AuthenticatedRequest,
    @Param("sessionId") sessionId: string,
    @Body() dto: SubmitReviewDto,
    @Res({ passthrough: true }) res: import("fastify").FastifyReply,
  ) {
    try {
      return await this.studyService.submitReview(req.user.id, sessionId, {
        sessionItemId: dto.sessionItemId,
        cardId: dto.cardId,
        rating: dto.rating,
        clientEventId: dto.clientEventId,
      });
    } catch (err) {
      if (err instanceof DailyUsageLimitError) {
        res.status(HttpStatus.CONFLICT);
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
      if (err instanceof IdempotencyConflictError) {
        res.status(HttpStatus.CONFLICT);
        return {
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: "幂等键已被其他评分占用，请使用不同 clientEventId",
            requestId: req.id,
            retryable: false,
          },
        };
      }
      if (err instanceof ReviewValidationError) {
        res.status(HttpStatus.UNPROCESSABLE_ENTITY);
        return {
          error: {
            code: "VALIDATION_FAILED",
            message: err.message,
            requestId: req.id,
            retryable: false,
          },
        };
      }
      if (err instanceof ReviewItemNotFoundError) {
        res.status(HttpStatus.NOT_FOUND);
        return {
          error: {
            code: "REVIEW_ITEM_NOT_FOUND",
            message: err.message,
            requestId: req.id,
            retryable: false,
          },
        };
      }
      throw err;
    }
  }

  @Get("progress")
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "进度概览（只读）：主课程 current release 各单元解锁 + 首测完成 + 稳定派生状态，由事件与快照完全重建",
  })
  @ApiOkResponse({ type: ProgressDto })
  progress(@Req() req: AuthenticatedRequest) {
    return this.studyService.getProgress(req.user.id);
  }
}
