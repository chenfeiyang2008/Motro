// /study 端点（阶段 5 工单 01：学习卡与学习展示）。
// 只读当前登录用户自己的数据：学习卡只来自已报名课程的 current release（绝不读草稿），
// 学习展示幂等且不可变。管理员经此路径也只会访问自己的 learner 数据。
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
}
