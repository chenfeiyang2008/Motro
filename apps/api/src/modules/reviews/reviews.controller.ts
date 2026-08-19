import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { Roles, RolesGuard } from "../../auth/roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import {
  ReviewDecisionRequestDto,
  ReviewDecisionResponseDto,
  ReviewDraftDetailDto,
  ReviewDraftListDto,
  ReviewListQueryDto,
} from "./reviews.dto.js";
import { ReviewsService } from "./reviews.service.js";

@ApiTags("admin reviews")
@Controller("admin/reviews")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "列出来源完整、等待审核的草稿队列（支持筛选与 keyset 分页）" })
  @ApiOkResponse({ type: ReviewDraftListDto })
  list(@Query() query: ReviewListQueryDto): Promise<ReviewDraftListDto> {
    const opts: {
      status?: string;
      manualAction?: "resolvable" | "non_resolvable";
      cursor?: string;
      limit?: number;
    } = {};
    if (query.status !== undefined && query.status !== "") opts.status = query.status;
    if (query.manualAction !== undefined) opts.manualAction = query.manualAction;
    if (query.cursor !== undefined && query.cursor !== "") opts.cursor = query.cursor;
    if (query.limit !== undefined) opts.limit = query.limit;
    return this.service.list(opts);
  }

  @Get(":id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "查看单个草稿和完整来源投影" })
  @ApiOkResponse({ type: ReviewDraftDetailDto })
  detail(@Param("id", new ParseUUIDPipe()) id: string): Promise<ReviewDraftDetailDto> {
    return this.service.detail(id);
  }

  @Get(":id/history")
  @ApiBearerAuth()
  @ApiOperation({ summary: "查看该草稿的历史审核决定（不可变只读）" })
  @ApiOkResponse({ type: ReviewDraftListDto })
  history(@Param("id", new ParseUUIDPipe()) id: string): Promise<ReviewDraftListDto> {
    return this.service.history(id);
  }

  @Post(":id/decision")
  @ApiBearerAuth()
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiCreatedResponse({ type: ReviewDecisionResponseDto })
  @ApiOperation({ summary: "提交不可变人工审核决定（accept / accept_with_edits / reject）" })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  decide(
    @Req() req: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: ReviewDecisionRequestDto,
  ): Promise<ReviewDecisionResponseDto> {
    if (!idempotencyKey) throw new UnprocessableEntityException("缺少 Idempotency-Key 请求头");
    return this.service.decide({
      draftId: id,
      reviewerId: req.user.id,
      idempotencyKey,
      body,
      requestId: req.id,
      ...(body.expectedVersion ? { expectedVersion: body.expectedVersion } : {}),
    });
  }

  @Post(":id/resolve")
  @ApiBearerAuth()
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiCreatedResponse()
  @ApiOperation({
    summary: "人工处理可补全的 manual_action：生成不可变人工处理事实（append-only）",
  })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  resolve(
    @Req() req: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<{ handled: boolean; draftId: string }> {
    if (!idempotencyKey) throw new UnprocessableEntityException("缺少 Idempotency-Key 请求头");
    return this.service.resolve({
      draftId: id,
      actorId: req.user.id,
      idempotencyKey,
      body,
      requestId: req.id,
    });
  }
}
