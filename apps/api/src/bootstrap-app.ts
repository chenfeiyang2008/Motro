// 创建并装配 Nest/Fastify 应用；main 与测试共用同一装配路径。
import { HttpException, HttpStatus, type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import { loadConfig, type AppConfig } from "@motro/config";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { AppModule } from "./app.module.js";
import { errorEnvelope } from "./common/error-envelope.js";
import { GlobalExceptionFilter } from "./common/global-exception.filter.js";
import { CSRF_COOKIE, csrfCookieOptions } from "./auth/cookies.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function createApp(config?: AppConfig): Promise<NestFastifyApplication> {
  const cfg = config ?? loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: cfg.logging.level === "debug" ? ["debug"] : ["log", "error", "warn"],
  });

  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => {
        const fieldErrors = errors.map((e) => ({
          path: e.property,
          code: "invalid",
          message: Object.values(e.constraints ?? {})[0] ?? "校验失败",
        }));
        return new HttpException(
          { message: "请求校验失败", fieldErrors },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      },
    }),
  );

  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(cookie);

  fastify.addHook("onSend", async (request: FastifyRequest, reply) => {
    reply.header("x-request-id", request.id);
  });

  // CSRF：双提交 cookie。安全方法确保 cookie 存在；不安全方法校验 x-csrf-token 头。
  fastify.addHook("onRequest", async (request: FastifyRequest, reply) => {
    let csrf = request.cookies?.[CSRF_COOKIE];
    if (!csrf) {
      csrf = randomBytes(24).toString("base64url");
      reply.setCookie(CSRF_COOKIE, csrf, csrfCookieOptions(cfg.cookie));
    }
    if (UNSAFE_METHODS.has(request.method)) {
      const header = request.headers["x-csrf-token"];
      if (typeof header !== "string" || header !== csrf) {
        reply.status(403).send(errorEnvelope(403, "CSRF 校验失败", request.id));
      }
    }
  });

  // CORS 挂点：策略由认证票据填充，当前仅允许配置的 origin。
  if (cfg.cors.origins.length > 0) {
    app.enableCors({
      origin: cfg.cors.origins,
      credentials: true,
    });
  }

  app.enableShutdownHooks();
  return app;
}

export type { INestApplication };
