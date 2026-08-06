// 类型化配置边界：按进程分组的环境变量 schema、启动校验与脱敏诊断。
// 凭证只允许通过运行时 secret 注入；本模块不会输出任何密钥原文。
import { z } from "zod";

export const NODE_ENV_SCHEMA = z.enum(["development", "test", "production"]);
export type NodeEnv = z.infer<typeof NODE_ENV_SCHEMA>;

const DbSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
});
export type DbConfig = z.infer<typeof DbSchema>;

const CookieSchema = z.object({
  key: z.string().min(32),
  secure: z.enum(["true", "false"]).transform((v) => v === "true"),
  sameSite: z.enum(["lax", "strict", "none"]),
  idleMinutes: z.coerce.number().int().positive(),
  absoluteHours: z.coerce.number().int().positive(),
});
export type CookieConfig = z.infer<typeof CookieSchema>;

const CsrfSchema = z.object({
  key: z.string().min(32),
  headerName: z.string().min(1),
});
export type CsrfConfig = z.infer<typeof CsrfSchema>;

const ApiSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535),
  publicUrl: z.string().url(),
});
export type ApiConfig = z.infer<typeof ApiSchema>;

const WebSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535),
  apiPublicUrl: z.string().url(),
  apiInternalUrl: z.string().url(),
});
export type WebConfig = z.infer<typeof WebSchema>;

const LoggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
});

const OpenApiSchema = z.object({
  enabled: z.boolean(),
});

const CorsSchema = z.object({
  origins: z.array(z.string().url()).default([]),
});

const RateLimitSchema = z.object({
  loginPerMinute: z.coerce.number().int().positive(),
});
export type RateLimitConfig = z.infer<typeof RateLimitSchema>;

export const AppConfigSchema = z.object({
  env: NODE_ENV_SCHEMA,
  db: DbSchema,
  cookie: CookieSchema,
  csrf: CsrfSchema,
  api: ApiSchema,
  web: WebSchema,
  logging: LoggingSchema,
  openapi: OpenApiSchema,
  cors: CorsSchema,
  rateLimit: RateLimitSchema,
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(
    public readonly fieldErrors: FieldError[],
    message?: string,
  ) {
    super(message ?? fieldErrors[0]?.message ?? "配置校验失败");
    this.name = "ConfigError";
  }
}

const DEV_SESSION_KEY = "development-only-session-key-0123456789abcdef";
const DEV_CSRF_KEY = "development-only-csrf-key-0123456789abcdef";

function parseNodeEnv(value: string | undefined): NodeEnv {
  if (value === undefined) return "development";
  const parsed = NODE_ENV_SCHEMA.safeParse(value);
  if (!parsed.success)
    throw new ConfigError([
      {
        path: "env",
        code: "invalid_enum_value",
        message: "NODE_ENV 必须是 development/test/production",
      },
    ]);
  return parsed.data;
}

function requiredInProduction<T>(
  value: T | undefined,
  fallback: T,
  isProduction: boolean,
): T | undefined {
  return value ?? (isProduction ? undefined : fallback);
}

/**
 * 从环境变量加载并校验完整配置。失败时抛出字段级 ConfigError。
 * @param explicitEnv 覆盖 NODE_ENV（供 config:check --env 使用）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, explicitEnv?: NodeEnv): AppConfig {
  const nodeEnv = explicitEnv ?? parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === "production";

  const raw = {
    env: nodeEnv,
    db: {
      host: env.POSTGRES_HOST ?? "127.0.0.1",
      port: env.POSTGRES_PORT ?? "5432",
      database: env.POSTGRES_DB ?? "motro",
      user: env.POSTGRES_USER ?? "motro",
      password: requiredInProduction(env.POSTGRES_PASSWORD, "dev_only_change_me", isProduction),
    },
    cookie: {
      key: requiredInProduction(env.SESSION_KEY, DEV_SESSION_KEY, isProduction),
      secure: env.COOKIE_SECURE ?? (isProduction ? "true" : "false"),
      sameSite: env.COOKIE_SAMESITE ?? "lax",
      idleMinutes: env.COOKIE_IDLE_MINUTES ?? "30",
      absoluteHours: env.COOKIE_ABSOLUTE_HOURS ?? "168",
    },
    csrf: {
      key: requiredInProduction(env.CSRF_KEY, DEV_CSRF_KEY, isProduction),
      headerName: env.CSRF_HEADER_NAME ?? "x-csrf-token",
    },
    api: {
      port: env.API_PORT ?? "3000",
      publicUrl: env.API_PUBLIC_URL ?? "http://127.0.0.1:3000",
    },
    web: {
      port: env.WEB_PORT ?? "3001",
      apiPublicUrl: env.API_PUBLIC_URL ?? "http://127.0.0.1:3000",
      apiInternalUrl: env.API_INTERNAL_URL ?? "http://127.0.0.1:3000",
    },
    logging: {
      level: env.LOG_LEVEL ?? "info",
    },
    openapi: {
      enabled: (env.OPENAPI_ENABLED ?? (isProduction ? "false" : "true")) === "true",
    },
    cors: {
      origins: (env.CORS_ORIGINS ?? "").split(",").filter((s) => s.length > 0),
    },
    rateLimit: {
      loginPerMinute: env.RATE_LIMIT_LOGIN_PER_MINUTE ?? "10",
    },
  };

  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  if (nodeEnv === "production" && !result.data.cookie.secure) {
    throw new ConfigError([
      {
        path: "cookie.secure",
        code: "production_insecure",
        message: "production 必须使用 Secure cookie",
      },
    ]);
  }

  // SameSite=None 必须配合 Secure（否则浏览器拒绝）。
  if (result.data.cookie.sameSite === "none" && !result.data.cookie.secure) {
    throw new ConfigError([
      {
        path: "cookie.sameSite",
        code: "invalid_config",
        message: "SameSite=None 必须配合 Secure cookie",
      },
    ]);
  }

  return result.data;
}

/** 脱敏后的配置摘要，仅用于启动日志/health 诊断，不输出任何密钥原文。 */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    db: { ...config.db, password: "***" },
    cookie: { ...config.cookie, key: "***" },
    csrf: { ...config.csrf, key: "***" },
    api: config.api,
    web: config.web,
    logging: config.logging,
    openapi: config.openapi,
    cors: config.cors,
    rateLimit: config.rateLimit,
  };
}
