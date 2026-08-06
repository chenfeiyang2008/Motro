// 全局异常过滤器：任何异常都映射为统一错误信封，错误消息不含 stack trace 或密钥。
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errorEnvelope, statusToCode } from "./error-envelope.js";

interface FieldErrorLike {
  path: string;
  code: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = this.resolveMessage(exception, status);
    const fieldErrors = this.resolveFieldErrors(exception);

    if (status >= 500) {
      // 仅服务端记录，永不进入客户端响应。
      const detail = exception instanceof Error ? exception.message : String(exception);
      console.error(`[error] ${request.id} status=${status} message=${message} detail=${detail}`);
    }

    reply.status(status).send(errorEnvelope(status, message, request.id, fieldErrors));
  }

  private resolveMessage(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null) {
        const message = (body as { message?: unknown }).message;
        if (typeof message === "string") return message;
      }
      if (typeof body === "string") return body;
      return HttpStatus[status] ?? "请求失败";
    }
    return "内部错误";
  }

  private resolveFieldErrors(exception: unknown): FieldErrorLike[] | undefined {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null) {
        const fieldErrors = (body as { fieldErrors?: unknown }).fieldErrors;
        if (Array.isArray(fieldErrors)) {
          const valid = fieldErrors.filter(
            (f): f is FieldErrorLike =>
              typeof f === "object" && f !== null && "path" in f && "code" in f,
          );
          return valid.length > 0 ? valid : undefined;
        }
      }
    }
    return undefined;
  }
}

export { statusToCode };
