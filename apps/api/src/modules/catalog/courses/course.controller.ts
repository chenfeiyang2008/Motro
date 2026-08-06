// /admin/courses 端点：课程/草稿/单元的管理员命令。
// 权限在 API 强制执行（SessionGuard + RolesGuard(admin)）；写操作要求 If-Match 或 draftVersion。
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { Roles, RolesGuard } from "../../../auth/roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "../../../auth/session.guard.js";
import {
  CourseDraftDetailDto,
  CourseListResponseDto,
  CreateCourseDto,
  CreateCourseResultDto,
  CreateUnitDto,
  DeleteUnitDto,
  DraftVersionConflictEnvelopeDto,
  ReorderUnitsDto,
  UpdateCourseDraftDto,
  UpdateUnitDto,
} from "./dto.js";
import { CourseService, DraftVersionConflictError } from "./course.service.js";

@ApiTags("admin courses")
@Controller("admin/courses")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class CourseController {
  constructor(private readonly courseService: CourseService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "课程列表（草稿版本、可见状态）" })
  @ApiOkResponse({ type: CourseListResponseDto })
  async list() {
    const items = await this.courseService.listCourses();
    return { items };
  }

  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: "创建稳定课程并同时创建初始草稿（draftVersion=1）" })
  @ApiCreatedResponse({ type: CreateCourseResultDto })
  @ApiConflictResponse({ description: "slug 已存在" })
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateCourseDto) {
    return this.courseService.createCourse(
      req.user,
      {
        slug: dto.slug,
        title: dto.title,
        level: dto.level,
        description: dto.description,
      },
      req.id,
    );
  }

  @Get(":id/draft")
  @ApiBearerAuth()
  @ApiOperation({ summary: "草稿详情：元数据、版本与有序单元" })
  @ApiOkResponse({ type: CourseDraftDetailDto })
  getDraft(@Param("id", ParseUUIDPipe) id: string) {
    return this.courseService.getDraft(id);
  }

  @Patch(":id/draft")
  @ApiBearerAuth()
  @ApiOperation({ summary: "更新草稿元数据（If-Match 或 draftVersion）" })
  @ApiOkResponse({ type: CourseDraftDetailDto })
  @ApiConflictResponse({ description: "草稿版本冲突", type: DraftVersionConflictEnvelopeDto })
  updateDraft(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() dto: UpdateCourseDraftDto,
  ) {
    return this.runDraftMutation(req, reply, ifMatch, dto.draftVersion, (expected) =>
      this.courseService.updateDraft(
        req.user,
        id,
        { slug: dto.slug, title: dto.title, level: dto.level, description: dto.description },
        expected,
        req.id,
      ),
    );
  }

  @Post(":id/draft/units/:unitId")
  @ApiBearerAuth()
  @ApiOperation({ summary: "新增单元（客户端分配稳定 unitId，追加到末尾）" })
  @ApiCreatedResponse({ type: CourseDraftDetailDto })
  @ApiConflictResponse({ description: "草稿版本冲突", type: DraftVersionConflictEnvelopeDto })
  createUnit(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("unitId", ParseUUIDPipe) unitId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() dto: CreateUnitDto,
  ) {
    return this.runDraftMutation(req, reply, ifMatch, dto.draftVersion, (expected) =>
      this.courseService.createUnit(
        req.user,
        id,
        unitId,
        { title: dto.title, description: dto.description },
        expected,
        req.id,
      ),
    );
  }

  @Patch(":id/draft/units/:unitId")
  @ApiBearerAuth()
  @ApiOperation({ summary: "编辑单元标题/描述" })
  @ApiOkResponse({ type: CourseDraftDetailDto })
  @ApiConflictResponse({ description: "草稿版本冲突", type: DraftVersionConflictEnvelopeDto })
  updateUnit(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("unitId", ParseUUIDPipe) unitId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.runDraftMutation(req, reply, ifMatch, dto.draftVersion, (expected) =>
      this.courseService.updateUnit(
        req.user,
        id,
        unitId,
        { title: dto.title, description: dto.description },
        expected,
        req.id,
      ),
    );
  }

  @Delete(":id/draft/units/:unitId")
  @ApiBearerAuth()
  @ApiOperation({ summary: "删除单元并重排" })
  @ApiOkResponse({ type: CourseDraftDetailDto })
  @ApiConflictResponse({ description: "草稿版本冲突", type: DraftVersionConflictEnvelopeDto })
  deleteUnit(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("unitId", ParseUUIDPipe) unitId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() dto: DeleteUnitDto,
  ) {
    return this.runDraftMutation(req, reply, ifMatch, dto.draftVersion, (expected) =>
      this.courseService.deleteUnit(req.user, id, unitId, expected, req.id),
    );
  }

  @Post(":id/draft/reorder")
  @ApiBearerAuth()
  @ApiOperation({ summary: "提交完整单元顺序并事务重排" })
  @ApiCreatedResponse({ type: CourseDraftDetailDto })
  @ApiConflictResponse({ description: "草稿版本冲突", type: DraftVersionConflictEnvelopeDto })
  reorder(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() dto: ReorderUnitsDto,
  ) {
    return this.runDraftMutation(req, reply, ifMatch, dto.draftVersion, (expected) =>
      this.courseService.reorderUnits(req.user, id, dto.unitIds, expected, req.id),
    );
  }

  private runDraftMutation(
    req: AuthenticatedRequest,
    reply: FastifyReply,
    ifMatch: string | undefined,
    bodyVersion: number | undefined,
    mutate: (expected: number) => Promise<CourseDraftDetailDto>,
  ): Promise<CourseDraftDetailDto | undefined> {
    const expected = resolveVersion(ifMatch, bodyVersion);
    return mutate(expected).catch((err: unknown) => {
      if (err instanceof DraftVersionConflictError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "DRAFT_VERSION_CONFLICT",
            message: "草稿已被其他修改更新，请重新加载",
            requestId: req.id,
            currentDraftVersion: err.currentVersion,
            retryable: false,
          },
        });
        return undefined;
      }
      throw err;
    });
  }
}

function resolveVersion(ifMatch: string | undefined, bodyVersion: number | undefined): number {
  if (ifMatch !== undefined) {
    const n = Number(ifMatch);
    if (!Number.isInteger(n) || n < 1) throw new BadRequestException("If-Match 版本不合法");
    return n;
  }
  if (bodyVersion !== undefined) return bodyVersion;
  throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
}
