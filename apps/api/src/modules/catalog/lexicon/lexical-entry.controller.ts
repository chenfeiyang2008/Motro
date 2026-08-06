// /admin/lexical-entries 端点：管理员搜索/分页、详情、手工创建。
// 权限在 API 强制执行（SessionGuard + RolesGuard(admin)），不依赖 Web 隐藏按钮。
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
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
  CreateLexicalEntryDto,
  DuplicateErrorEnvelopeDto,
  LexicalEntryDetailDto,
  LexicalEntryListResponseDto,
  ListLexicalEntriesQuery,
} from "./dto.js";
import { LexicalEntryService } from "./lexical-entry.service.js";

@ApiTags("admin lexical entries")
@Controller("admin/lexical-entries")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class LexicalEntryController {
  constructor(private readonly service: LexicalEntryService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "搜索/分页词条（规范化拼写、来源状态、引用次数、更新时间）" })
  @ApiOkResponse({ type: LexicalEntryListResponseDto })
  list(@Query() query: ListLexicalEntriesQuery) {
    return this.service.list({
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: "创建手工词条；重复候选返回 409 及候选，不静默落库" })
  @ApiCreatedResponse({ type: LexicalEntryDetailDto })
  @ApiConflictResponse({ description: "重复警告/完全相同冲突", type: DuplicateErrorEnvelopeDto })
  async create(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() dto: CreateLexicalEntryDto,
  ) {
    const outcome = await this.service.create(
      req.user,
      {
        canonicalSpelling: dto.canonicalSpelling,
        partOfSpeech: dto.partOfSpeech,
        pronunciation: dto.pronunciation,
        senses: dto.senses,
        sourceNote: dto.sourceNote,
        confirmDuplicate: dto.confirmDuplicate,
      },
      req.id,
    );
    switch (outcome.kind) {
      case "created":
        return outcome.entry;
      case "duplicate_warning":
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "DUPLICATE_WARNING",
            message: "该拼写已存在相似候选词条，请确认后继续",
            requestId: req.id,
            duplicateCandidates: outcome.candidates,
            retryable: false,
          },
        });
        return;
      case "duplicate_exact":
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "DUPLICATE_ENTRY",
            message: "该拼写完全相同的词条已存在",
            requestId: req.id,
            duplicateCandidates: [outcome.candidate],
            retryable: false,
          },
        });
        return;
    }
  }

  @Get(":id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "词条事实与来源摘要" })
  @ApiOkResponse({ type: LexicalEntryDetailDto })
  get(@Param("id") id: string) {
    return this.service.getDetail(id);
  }
}
