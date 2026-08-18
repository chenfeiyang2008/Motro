import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Roles, RolesGuard } from "../../auth/roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import {
  AdminMotivationListDto,
  AdminMotivationCopyDto,
  BatchCreateMotivationCopyDto,
  BatchCreateMotivationResultDto,
  CreateMotivationCopyDto,
  MotivationResponseDto,
  UpdateMotivationCopyDto,
} from "./motivation.dto.js";
import { MotivationService } from "./motivation.service.js";

@ApiTags("motivation")
@Controller()
@UseGuards(SessionGuard)
export class MotivationController {
  constructor(private readonly service: MotivationService) {}

  @Get("home/motivation")
  @ApiBearerAuth()
  @ApiOperation({ summary: "学习端首页随机激励文案（仅启用内容）" })
  @ApiOkResponse({ type: MotivationResponseDto })
  learner(): Promise<MotivationResponseDto> {
    return this.service.getForLearner();
  }

  @Get("admin/motivation-copies")
  @Roles("admin")
  @UseGuards(RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "管理员激励文案列表" })
  @ApiQuery({ name: "status", required: false, enum: ["enabled", "disabled"] })
  @ApiQuery({ name: "category", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({ type: AdminMotivationListDto })
  list(
    @Query("status") status?: string,
    @Query("category") category?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<AdminMotivationListDto> {
    const parsed = limit === undefined ? undefined : Number(limit);
    const opts: { status?: string; category?: string; cursor?: string; limit?: number } = {};
    if (status) opts.status = status;
    if (category) opts.category = category;
    if (cursor) opts.cursor = cursor;
    if (parsed !== undefined && Number.isFinite(parsed)) opts.limit = parsed;
    return this.service.list(opts);
  }

  @Post("admin/motivation-copies")
  @Roles("admin")
  @UseGuards(RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "创建激励文案" })
  @ApiCreatedResponse({ type: AdminMotivationCopyDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateMotivationCopyDto,
  ): Promise<AdminMotivationCopyDto> {
    return this.service.create(req.user.id, req.id, dto);
  }

  @Post("admin/motivation-copies/batch")
  @Roles("admin")
  @UseGuards(RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "批量创建激励文案（最多 100 条）" })
  @ApiBody({ type: BatchCreateMotivationCopyDto })
  @ApiCreatedResponse({ type: BatchCreateMotivationResultDto })
  createBatch(
    @Req() req: AuthenticatedRequest,
    @Body() dto: BatchCreateMotivationCopyDto,
  ): Promise<BatchCreateMotivationResultDto> {
    return this.service.createBatch(req.user.id, req.id, dto);
  }

  @Patch("admin/motivation-copies/:id")
  @Roles("admin")
  @UseGuards(RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "编辑、启用或停用激励文案" })
  @ApiOkResponse({ type: AdminMotivationCopyDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() dto: UpdateMotivationCopyDto,
  ): Promise<AdminMotivationCopyDto> {
    return this.service.update(req.user.id, req.id, id, dto);
  }
}
