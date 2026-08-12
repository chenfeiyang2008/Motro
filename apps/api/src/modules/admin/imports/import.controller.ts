// /admin/imports 端点（阶段 6 工单 01，最终审查修复）：
// - POST /admin/imports：multipart 上传 + Idempotency-Key；创建批次。
// - GET  /admin/imports 与 GET /:id：任意管理员可读；学习者拒绝。
// - 错误：未知/底层异常交给全局异常过滤器 → 脱敏 500；已知领域/校验错误用统一信封。
// 本票不实现解析/校验/提交（"开始校验"为后续工单占位）。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Roles, RolesGuard } from "../../../auth/roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "../../../auth/session.guard.js";
import {
  ImportContentConflictError,
  ImportIdempotencyConflictError,
  ImportIdempotencyInProgressError,
  ImportService,
  ImportWriteError,
} from "./import.service.js";
import {
  CommitImportBatchDto,
  ImportBatchDetailDto,
  ImportBatchDto,
  ImportBatchListDto,
  ImportCommitResultDto,
  ImportErrorEnvelopeDto,
  ImportRowListDto,
  ImportUploadBodyDto,
  UpdateImportBatchDto,
} from "./import.dto.js";
import { ImportBatchRepository } from "./import.repository.js";
import { errorEnvelope } from "../../../common/error-envelope.js";

const SOURCE_DECLARATION_MAX = 500;

const MISSING_FILE = {
  status: HttpStatus.BAD_REQUEST,
  code: "MISSING_FILE",
  message: "multipart 请求缺少文件字段",
  retryable: false,
} as const;
const MISSING_KEY = {
  status: HttpStatus.BAD_REQUEST,
  code: "IDEMPOTENCY_KEY_REQUIRED",
  message: "缺少 Idempotency-Key 请求头",
  retryable: false,
} as const;

@ApiTags("admin imports")
@Controller("admin/imports")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly repository: ImportBatchRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiConsumes("multipart/form-data")
  @ApiOperation({
    summary:
      "管理员上传原始文件并创建导入批次（multipart；Idempotency-Key 幂等；本票不解析文件内容）",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "本次上传意图的幂等键；重试必须复用同一键",
  })
  // P1-1：用真实 DTO 表达 multipart body（不再同时给 type + 冲突的 inline schema）。
  @ApiBody({ type: ImportUploadBodyDto, required: true })
  @ApiResponse({ status: 201, description: "新批次创建成功", type: ImportBatchDto })
  @ApiResponse({ status: 200, description: "幂等重放或内容去重返回既有批次", type: ImportBatchDto })
  @ApiResponse({
    status: 400,
    description: "malformed 或安全文件拒绝",
    type: ImportErrorEnvelopeDto,
  })
  @ApiResponse({
    status: 409,
    description: "IDEMPOTENCY_CONFLICT / IDEMPOTENCY_IN_PROGRESS / IMPORT_CONTENT_CONFLICT",
    type: ImportErrorEnvelopeDto,
  })
  @ApiResponse({ status: 422, description: "字段或领域校验失败", type: ImportErrorEnvelopeDto })
  @ApiResponse({ status: 500, description: "统一内部错误信封", type: ImportErrorEnvelopeDto })
  async create(
    @Req() req: FastifyRequest & AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ImportBatchDto | void> {
    const file = await req.file().catch(() => null);
    if (!file) {
      // P2-1：缺文件返回真正专用 MISSING_FILE，而非通用 BAD_REQUEST。
      reply
        .status(MISSING_FILE.status)
        .send(
          errorEnvelope(
            MISSING_FILE.status,
            MISSING_FILE.message,
            req.id,
            undefined,
            MISSING_FILE.code,
          ),
        );
      return;
    }

    const filename = file.filename ?? "";
    const declaredMime = file.mimetype ?? "application/octet-stream";
    const idempotencyKey = req.headers["idempotency-key"];
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      // P2-1：缺幂等键返回专门 IDEMPOTENCY_KEY_REQUIRED。
      reply
        .status(MISSING_KEY.status)
        .send(
          errorEnvelope(
            MISSING_KEY.status,
            MISSING_KEY.message,
            req.id,
            undefined,
            MISSING_KEY.code,
          ),
        );
      return;
    }

    const sourceRaw = file.fields?.["sourceDeclaration"];
    const sourceDeclaration =
      (typeof sourceRaw === "object" && sourceRaw !== null && "value" in sourceRaw
        ? (sourceRaw as { value: unknown }).value
        : undefined
      )?.toString() ?? "";
    if (!sourceDeclaration.trim()) {
      reply
        .status(HttpStatus.UNPROCESSABLE_ENTITY)
        .send(errorEnvelope(HttpStatus.UNPROCESSABLE_ENTITY, "来源声明不能为空", req.id));
      return;
    }
    if (sourceDeclaration.length > SOURCE_DECLARATION_MAX) {
      reply
        .status(HttpStatus.UNPROCESSABLE_ENTITY)
        .send(errorEnvelope(HttpStatus.UNPROCESSABLE_ENTITY, "来源声明过长", req.id));
      return;
    }

    try {
      const result = await this.importService.uploadAndCreateBatch({
        fileStream: file.file,
        filename,
        declaredMime,
        sourceDeclaration,
        idempotencyKey,
        userId: req.user.id,
        requestId: req.id,
      });
      // 幂等重放或完全复用了既有批次/文件（dedup 命中且批次已存在）→ 200；新创建 → 201。
      if (result.idempotentReplay || !result.created) reply.status(HttpStatus.OK);
      else reply.status(HttpStatus.CREATED);
      return result.batch;
    } catch (err) {
      if (err instanceof ImportContentConflictError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "IMPORT_CONTENT_CONFLICT",
            message: err.message,
            requestId: req.id,
            existingBatchId: err.existingBatchId,
            retryable: false,
          },
        });
        return;
      }
      if (err instanceof ImportIdempotencyConflictError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: err.message,
            requestId: req.id,
            retryable: false,
          },
        });
        return;
      }
      if (err instanceof ImportIdempotencyInProgressError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "IDEMPOTENCY_IN_PROGRESS",
            message: err.message,
            requestId: req.id,
            retryable: true,
          },
        });
        return;
      }
      if (err instanceof ImportWriteError) {
        reply
          .status(HttpStatus.BAD_REQUEST)
          .send(errorEnvelope(HttpStatus.BAD_REQUEST, err.message, req.id));
        return;
      }
      // P1-1：未知/底层异常原样上抛，全局异常过滤器返回脱敏 500。
      throw err;
    }
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "导入批次列表（管理员共享；元数据，不含磁盘路径/存储键）" })
  @ApiResponse({ status: 200, type: ImportBatchListDto })
  async list(): Promise<ImportBatchListDto> {
    return { items: await this.repository.listAll() };
  }

  @Get(":id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "单个导入批次详情（含映射/校验事实；不含磁盘路径/存储键）" })
  @ApiResponse({ status: 200, type: ImportBatchDetailDto })
  @ApiResponse({ status: 400, description: "非法 UUID", type: ImportErrorEnvelopeDto })
  @ApiResponse({ status: 404, description: "批次不存在", type: ImportErrorEnvelopeDto })
  async get(@Param("id", ParseUUIDPipe) id: string): Promise<ImportBatchDetailDto> {
    return this.importService.getWithDiscovery(id);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @ApiBody({ type: UpdateImportBatchDto, required: true })
  @ApiOperation({
    summary: "更新导入批次映射/来源声明（乐观并发：version；映射变更使旧校验结果失效并写审计）",
  })
  @ApiResponse({ status: 200, type: ImportBatchDetailDto })
  @ApiResponse({ status: 404, description: "批次不存在或版本已过期", type: ImportErrorEnvelopeDto })
  @ApiResponse({ status: 422, description: "非法映射/来源声明", type: ImportErrorEnvelopeDto })
  async updateMapping(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateImportBatchDto,
    @Req() req: FastifyRequest & AuthenticatedRequest,
  ): Promise<ImportBatchDetailDto> {
    if (body.version === undefined) {
      throw new UnprocessableEntityException("缺少乐观并发版本");
    }
    try {
      // fromDomain 映射：接受 DTO 中的 mapping，忽略未知字段。
      const mapping =
        body.mapping === undefined
          ? undefined
          : {
              ...(body.mapping.spellingField !== undefined
                ? { spellingField: body.mapping.spellingField }
                : {}),
              ...(body.mapping.sheet !== undefined ? { sheet: body.mapping.sheet } : {}),
            };
      return await this.importService.updateBatch(
        id,
        mapping,
        body.sourceDeclaration,
        body.version,
        req.user.id,
        req.id,
      );
    } catch (err) {
      // 非法映射 → 结构化 422。
      if ((err as { code?: string }).code === "MAPPING_INVALID") {
        throw new UnprocessableEntityException((err as Error).message);
      }
      if ((err as { code?: string }).code === "SOURCE_INVALID") {
        throw new UnprocessableEntityException((err as Error).message);
      }
      throw err;
    }
  }

  @Post(":id/validate")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "本次校验意图的幂等键；重试必须复用同一键",
  })
  @ApiOperation({ summary: "同步解析并校验批次：生成行事实与校验摘要（幂等）" })
  @ApiResponse({ status: 200, type: ImportBatchDetailDto })
  @ApiResponse({
    status: 409,
    description: "IDEMPOTENCY_CONFLICT / IN_PROGRESS",
    type: ImportErrorEnvelopeDto,
  })
  @ApiResponse({ status: 422, description: "映射未确认", type: ImportErrorEnvelopeDto })
  async validate(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest & AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ImportBatchDetailDto | void> {
    const key = req.headers["idempotency-key"];
    if (!key || typeof key !== "string") {
      throw new UnprocessableEntityException("缺少 Idempotency-Key 请求头");
    }
    try {
      return await this.importService.validate(id, key, req.user.id, req.id);
    } catch (err) {
      if (err instanceof ImportIdempotencyConflictError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: "该校验请求键已用于不同的语义",
            requestId: req.id,
            retryable: false,
          },
        });
        return;
      }
      if (err instanceof ImportIdempotencyInProgressError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "IDEMPOTENCY_IN_PROGRESS",
            message: "该校验请求正在处理中，请稍后重试",
            requestId: req.id,
            retryable: true,
          },
        });
        return;
      }
      const code = (err as { code?: string }).code;
      if (code === "MAPPING_REQUIRED" || this.isParseErrorCode(code)) {
        throw new UnprocessableEntityException((err as Error).message);
      }
      throw err;
    }
  }

  /** 解析安全错误码 → 结构化 422（可重试性由错误信封决定）。 */
  private isParseErrorCode(code: string | undefined): boolean {
    if (!code) return false;
    return [
      "INVALID_CSV",
      "INVALID_JSON",
      "INVALID_XLSX",
      "XLS_NOT_SUPPORTED",
      "FILE_NOT_SUPPORTED",
      "INVALID_ZIP",
      "TOO_MANY_ROWS",
      "TOO_MANY_CELLS",
      "TOO_MANY_SHEETS",
      "CELL_TOO_LONG",
      "JSON_TOO_DEEP",
      "UNDECODABLE_TEXT",
      "FORMULA_BLOCKED",
      // XLSX pre-flight 安全拦截（工单 02-review P1-1）：这些是结构化、可重试的解析/安全拒绝，
      // 不是服务器内部错误 → 422 而非 500。
      "ZIP_TOO_MANY_ENTRIES",
      "ZIP_TOO_LARGE_UNCOMPRESSED",
      "ZIP_EXPANSION_TOO_HIGH",
      "ZIP_MALFORMED",
      "XLSX_MACRO_BLOCKED",
      "XLSX_STRUCTURE_INVALID",
    ].includes(code);
  }

  @Get(":id/rows")
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "分页读取批次行结果（按 ordinal 升序；游标分页）。默认当前映射版本；可传 mappingVersion 读取历史映射版本的行事实",
  })
  @ApiResponse({ status: 200, type: ImportRowListDto })
  @ApiResponse({ status: 404, description: "批次不存在", type: ImportErrorEnvelopeDto })
  @ApiResponse({
    status: 422,
    description: "非法游标/limit/mappingVersion",
    type: ImportErrorEnvelopeDto,
  })
  async rows(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("mappingVersion") mappingVersion?: string,
  ): Promise<ImportRowListDto> {
    let parsedCursor: number | null = null;
    if (cursor !== undefined && cursor.trim() !== "") {
      parsedCursor = Number(cursor);
      if (!Number.isInteger(parsedCursor) || parsedCursor < 0) {
        throw new UnprocessableEntityException("非法游标");
      }
    }
    let parsedLimit = 50;
    if (limit !== undefined && limit.trim() !== "") {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        throw new UnprocessableEntityException("非法 limit");
      }
    }
    // P1-B：显式 mappingVersion 允许读取该历史映射版本的行事实。
    let parsedMappingVersion: number | undefined;
    if (mappingVersion !== undefined && mappingVersion.trim() !== "") {
      parsedMappingVersion = Number(mappingVersion);
      if (!Number.isInteger(parsedMappingVersion) || parsedMappingVersion < 1) {
        throw new UnprocessableEntityException("非法 mappingVersion");
      }
    }
    return this.importService.listRows(id, parsedCursor, parsedLimit, parsedMappingVersion);
  }

  @Post(":id/commit")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "本次提交意图的幂等键；重试必须复用同一键，重放返回原始结果",
  })
  @ApiBody({ type: CommitImportBatchDto, required: true })
  @ApiOperation({
    summary:
      "仅提交有效候选行：事务内创建/关联全局词条与 lexical_sources(import)，形成可审计提交事实（幂等；绝不创建课程/发布）",
  })
  @ApiResponse({ status: 200, type: ImportCommitResultDto })
  @ApiResponse({
    status: 409,
    description: "IDEMPOTENCY_CONFLICT / IDEMPOTENCY_IN_PROGRESS / COMMIT_STALE_MAPPING",
    type: ImportErrorEnvelopeDto,
  })
  @ApiResponse({
    status: 422,
    description:
      "COMMIT_NOT_VALIDATED / COMMIT_VALIDATION_MISMATCH / COMMIT_NO_ELIGIBLE_ROWS / COMMIT_REVALIDATION_REQUIRED / 缺少幂等键",
    type: ImportErrorEnvelopeDto,
  })
  async commit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CommitImportBatchDto,
    @Req() req: FastifyRequest & AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ImportCommitResultDto | void> {
    const key = req.headers["idempotency-key"];
    if (!key || typeof key !== "string") {
      throw new UnprocessableEntityException("缺少 Idempotency-Key 请求头");
    }
    try {
      return await this.importService.commit(id, {
        idempotencyKey: key,
        mappingVersion: body.mappingVersion,
        validationInputSha256: body.validationInputSha256,
        userId: req.user.id,
        requestId: req.id,
      });
    } catch (err) {
      if (err instanceof ImportIdempotencyConflictError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: err.message,
            requestId: req.id,
            retryable: false,
          },
        });
        return;
      }
      if (err instanceof ImportIdempotencyInProgressError) {
        reply.status(HttpStatus.CONFLICT).send({
          error: {
            code: "IDEMPOTENCY_IN_PROGRESS",
            message: err.message,
            requestId: req.id,
            retryable: true,
          },
        });
        return;
      }
      const code = (err as { code?: string }).code;
      if (
        code === "COMMIT_STALE_MAPPING" ||
        code === "COMMIT_NOT_VALIDATED" ||
        code === "COMMIT_VALIDATION_MISMATCH" ||
        code === "COMMIT_NO_ELIGIBLE_ROWS" ||
        code === "COMMIT_REVALIDATION_REQUIRED"
      ) {
        reply
          .status(HttpStatus.UNPROCESSABLE_ENTITY)
          .send(
            errorEnvelope(
              HttpStatus.UNPROCESSABLE_ENTITY,
              (err as Error).message,
              req.id,
              undefined,
              code,
            ),
          );
        return;
      }
      throw err;
    }
  }

  @Get(":id/error-report")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "下载仅含不可提交行的服务端生成错误报告 CSV（当前映射版本；公式注入已中和）",
  })
  @ApiResponse({ status: 200, description: "CSV 下载；无错误行时返回仅表头 CSV" })
  @ApiResponse({ status: 404, description: "批次不存在", type: ImportErrorEnvelopeDto })
  async errorReport(
    @Param("id", ParseUUIDPipe) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { filename, csv } = await this.importService.buildErrorReportCsv(id);
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send("﻿" + csv);
  }
}
