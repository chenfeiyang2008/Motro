// 阶段 6 工单 04：/admin/operations 管理端点。
// - GET  /admin/operations：游标分页 + status/type 过滤；
// - GET  /admin/operations/{id}：operation + attempt 安全摘要；
// - POST /admin/operations/{id}/retry：管理员命令（CSRF 全局钩子 + Idempotency-Key + 审计）。
//
// Controller 只处理协议、身份、DTO 与错误映射；事务、锁、状态机在 Service/Repository。
// learner 一律 403（RolesGuard）；未登录 401（SessionGuard）。
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Roles, RolesGuard } from "../../auth/roles.guard.js";
import { SessionGuard, type AuthenticatedRequest } from "../../auth/session.guard.js";
import { errorEnvelope } from "../../common/error-envelope.js";
import {
  OperationGraphileUnavailableError,
  OperationNotRetryableError,
  OperationRetryConflictError,
  OperationRetryInProgressError,
  OperationsService,
} from "./operations.service.js";
import {
  OperationDetailDto,
  OperationListResponseDto,
  OperationRetryResultDto,
} from "./operations.dto.js";

@ApiTags("admin operations")
@Controller("admin/operations")
@UseGuards(SessionGuard, RolesGuard)
@Roles("admin")
export class OperationsController {
  constructor(private readonly service: OperationsService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "列出后台操作（游标分页；可安全按 status/type 过滤）" })
  @ApiQuery({ name: "status", required: false, description: "状态过滤（queued/running/…）" })
  @ApiQuery({ name: "operationType", required: false, description: "操作类型过滤" })
  @ApiQuery({ name: "cursor", required: false, description: "分页游标" })
  @ApiQuery({ name: "limit", required: false, description: "每页数量（1–50，默认 20）" })
  @ApiResponse({ status: 200, type: OperationListResponseDto })
  async list(
    @Query("status") status?: string,
    @Query("operationType") operationType?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<OperationListResponseDto> {
    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    if (
      parsedLimit !== undefined &&
      (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50)
    ) {
      throw new BadRequestException("非法 limit（1–50）");
    }
    if (
      status &&
      !["queued", "running", "retry_wait", "succeeded", "failed", "manual_action"].includes(status)
    ) {
      throw new BadRequestException("非法 status");
    }
    const listOpts: {
      status?: string;
      operationType?: string;
      cursor?: string;
      limit?: number;
    } = {};
    if (status !== undefined) listOpts.status = status;
    if (operationType !== undefined) listOpts.operationType = operationType;
    if (cursor !== undefined) listOpts.cursor = cursor;
    if (parsedLimit !== undefined) listOpts.limit = parsedLimit;
    return this.service.list(listOpts);
  }

  @Get(":id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "查看单个 operation 详情（含 attempt 时间线与脱敏错误）" })
  @ApiParam({ name: "id", description: "operation UUID" })
  @ApiResponse({ status: 200, type: OperationDetailDto })
  async detail(
    @Param("id", new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST })) id: string,
  ): Promise<OperationDetailDto> {
    return this.service.getDetail(id);
  }

  @Post(":id/retry")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "管理员重试失败/人工状态操作（CSRF + Idempotency-Key + 审计）" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiHeader({ name: "x-csrf-token", required: true })
  @ApiParam({ name: "id", description: "operation UUID" })
  @ApiResponse({ status: 200, type: OperationRetryResultDto })
  @ApiResponse({ status: 409, description: "IDEMPOTENCY_CONFLICT / IDEMPOTENCY_IN_PROGRESS" })
  @ApiResponse({ status: 422, description: "缺少 Idempotency-Key / 非法状态或未确认 / 未知字段" })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async retry(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("id", new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST })) id: string,
    @Body() body: { confirm?: boolean },
  ): Promise<OperationRetryResultDto | void> {
    const idempotencyKey = req.headers["idempotency-key"];
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new UnprocessableEntityException("缺少 Idempotency-Key 请求头");
    }
    const auth = req as AuthenticatedRequest;
    try {
      return await this.service.retry({
        operationId: id,
        adminId: auth.user.id,
        idempotencyKey,
        confirm: body?.confirm === true,
        requestId: req.id,
      });
    } catch (err) {
      if (err instanceof OperationNotRetryableError) {
        reply
          .status(HttpStatus.UNPROCESSABLE_ENTITY)
          .send(errorEnvelope(HttpStatus.UNPROCESSABLE_ENTITY, err.message, req.id));
        return;
      }
      if (err instanceof OperationRetryConflictError) {
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
      if (err instanceof OperationRetryInProgressError) {
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
      if (err instanceof OperationGraphileUnavailableError) {
        reply
          .status(HttpStatus.SERVICE_UNAVAILABLE)
          .send(errorEnvelope(HttpStatus.SERVICE_UNAVAILABLE, err.message, req.id));
        return;
      }
      if (err instanceof NotFoundException) {
        reply
          .status(HttpStatus.NOT_FOUND)
          .send(errorEnvelope(HttpStatus.NOT_FOUND, err.message, req.id));
        return;
      }
      throw err;
    }
  }
}
