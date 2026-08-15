// 工单 09：可重建学习指标——API 控制器。
//
// GET /study/metrics：返回当前登录用户的学习指标（只读、可重建、不含 XP/排行榜/CEFR）。
// 复用 SessionGuard（SessionGuard 复用已有 session 认证）；不新增认证机制。
import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import { LearningMetricsDto } from "./metrics.dto.js";
import { MetricsService } from "./metrics.service.js";

@ApiTags("study")
@Controller("study")
@UseGuards(SessionGuard)
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("metrics")
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "可重建学习指标（只读）：已稳定词项、待复习数、7日节奏、会话统计、课程完成度。" +
      "由 review_events / learning_cards / study_sessions 完全重建，标注事实来源、timezone、去重规则。",
  })
  @ApiOkResponse({ type: LearningMetricsDto })
  async getMetrics(@Req() req: AuthenticatedRequest): Promise<LearningMetricsDto> {
    return this.metricsService.getLearningMetrics(req.user.id);
  }
}
