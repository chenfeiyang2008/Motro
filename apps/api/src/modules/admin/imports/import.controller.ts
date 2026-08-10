// /admin/imports 端点（阶段 6 工单 01，最终审查修复）：
// - POST /admin/imports：multipart 上传 + Idempotency-Key；创建批次。
// - GET  /admin/imports 与 GET /:id：任意管理员可读；学习者拒绝。
// - 错误：未知/底层异常交给全局异常过滤器 → 脱敏 500；已知领域/校验错误用统一信封。
// 本票不实现解析/校验/提交（"开始校验"为后续工单占位）。
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
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
  ImportBatchDto,
  ImportBatchListDto,
  ImportErrorEnvelopeDto,
  ImportUploadBodyDto,
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
  @ApiOperation({ summary: "单个导入批次详情（管理员共享；元数据，不含磁盘路径/存储键）" })
  @ApiResponse({ status: 200, type: ImportBatchDto })
  @ApiResponse({ status: 400, description: "非法 UUID", type: ImportErrorEnvelopeDto })
  @ApiResponse({ status: 404, description: "批次不存在", type: ImportErrorEnvelopeDto })
  async get(@Param("id", ParseUUIDPipe) id: string): Promise<ImportBatchDto> {
    return this.repository.getById(id);
  }
}
