// /study 端点（阶段 5 工单 01/03：学习卡、学习展示、每日计划与学习会话）。
// 只读当前登录用户自己的数据：学习卡只来自已报名课程的 current release（绝不读草稿），
// 学习展示幂等且不可变；计划与会话只读/创建当前用户自己的主课程计划。
import {
  Body,
  Controller,
  Get,
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
  CreateExposureDto,
  LearningCardListDto,
  LearningCardListQueryDto,
  LearningCardSummaryDto,
  LearningExposureDto,
  StudySessionDetailDto,
  StudySessionDto,
  TodayDto,
} from "./dto.js";
import { StudyService } from "./study.service.js";

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
}
