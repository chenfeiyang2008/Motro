// 创建并装配 Nest/Fastify 应用；main 与测试共用同一装配路径。
import { HttpException, HttpStatus, type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { loadConfig, type AppConfig } from "@motro/config";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { AppModule } from "./app.module.js";
import { errorEnvelope } from "./common/error-envelope.js";
import { GlobalExceptionFilter } from "./common/global-exception.filter.js";
import { CSRF_COOKIE, csrfCookieOptions } from "./auth/cookies.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// multipart 上传上限：由配置的 IMPORT_MAX_FILE_BYTES 控制（更严格），此值只是 Fastify
// 请求体层面的兜底，防止超大 multipart 耗尽内存；两者取较小者生效。
const DEFAULT_MULTIPART_BODY_LIMIT = 20 * 1024 * 1024;

// 信任上游内网代理（Caddy / web 容器均位于 intranet-net 桥接网络），使 req.ip 取自
// X-Forwarded-For 的客户端地址，而非代理容器的桥接 IP，从而让登录限速与日志 IP 正确。
// Fastify v5 的 trustProxy 是 server 选项（无 setTrustProxy 实例方法），经 FastifyAdapter
// 构造参数透传。仅信任回环与私有/RFC1918/docker 桥接段；绝不能信任 "0.0.0.0/0"。
const TRUSTED_PROXY: string[] = [
  "127.0.0.1/8", // 回环 IPv4
  "::1", // 回环 IPv6
  "10.0.0.0/8", // 私有 A 类
  "172.16.0.0/12", // 私有 B 类 + docker 默认桥接（Caddy/web 容器在此段）
  "192.168.0.0/16", // 私有 C 类
];

export async function createApp(config?: AppConfig): Promise<NestFastifyApplication> {
  const cfg = config ?? loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: TRUSTED_PROXY }),
    {
      logger: cfg.logging.level === "debug" ? ["debug"] : ["log", "error", "warn"],
    },
  );

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
  await fastify.register(multipart, {
    limits: { fileSize: DEFAULT_MULTIPART_BODY_LIMIT, files: 1 },
    throwFileSizeLimit: true,
  });

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
