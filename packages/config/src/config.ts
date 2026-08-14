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

/** recovery 扫描间隔下界（500ms）：低于此值拒绝，防忙等待对数据库与 CPU 高轮询。 */
export const RECOVERY_SCAN_MIN_INTERVAL_MS = 500;
/** recovery 扫描间隔上界（5s）：高于此值拒绝，保证 lease 到期后可及时恢复。 */
export const RECOVERY_SCAN_MAX_INTERVAL_MS = 5_000;
/** 单次扫描恢复候选上限。 */
export const RECOVERY_SCAN_MAX_BATCH_SIZE = 20;
/** lease 下界：配合最小 200ms 心跳周期，保证 runtime 中 heartbeat 严格早于 lease 到期。 */
export const WORKER_LEASE_MIN_MS = 600;

/**
 * 工单 04 受控恢复扫描（lease-expiry recovery loop）：
 * - recoverIntervalMs：两次扫描之间的间隔（毫秒）。启动后立即执行一次，随后按间隔循环。
 *   有类型校验、>0、>=500、且有上限（<= RECOVERY_SCAN_MAX_INTERVAL_MS），防止高频轮询。
 * - recoverBatchSize：单次扫描选出的候选上限（有界批量，<= RECOVERY_SCAN_MAX_BATCH_SIZE）。
 */
const WorkerRecoverySchema = z.object({
  recoverIntervalMs: z.coerce
    .number()
    .int()
    .min(RECOVERY_SCAN_MIN_INTERVAL_MS)
    .max(RECOVERY_SCAN_MAX_INTERVAL_MS),
  recoverBatchSize: z.coerce.number().int().min(1).max(RECOVERY_SCAN_MAX_BATCH_SIZE),
});
export type WorkerRecoveryConfig = z.infer<typeof WorkerRecoverySchema>;

/**
 * Worker 边界（阶段 6 工单 04）：4 GB 主机资源预算。
 * - concurrency：单 worker 进程并发 job 数，默认 1，允许显式上调到最大 2；
 * - maxPoolSize：worker 自用 PostgreSQL 连接池上限，固定不超过 2；
 * - maxAttempts：单 job 默认最大尝试次数，保守默认 5（Graphile 库默认 25）；
 * - pollIntervalMs：轮询间隔（毫秒）；
 * - recovery：租赁到期恢复扫描（见 WorkerRecoverySchema）。
 * 配置输出必须脱敏，不暴露数据库密码/连接串。
 */
const WorkerSchema = z.object({
  concurrency: z.coerce.number().int().min(1).max(2),
  maxPoolSize: z.coerce.number().int().min(2).max(2),
  maxAttempts: z.coerce.number().int().min(1).max(5),
  pollIntervalMs: z.coerce.number().int().positive(),
  leaseMs: z.coerce.number().int().min(WORKER_LEASE_MIN_MS),
  recovery: WorkerRecoverySchema,
});
export type WorkerConfig = z.infer<typeof WorkerSchema>;

/**
 * 导入边界（阶段 6 工单 01 + 工单 02 + 02-review）：
 * 工单 01 已有 fileRootDir / maxFileBytes / allowedFormats；
 * 工单 02 追加解析/校验时的输入安全边界——最大行数、最大单元格/字段长度、
 * JSON 最大嵌套深度、XLSX 最大工作表数与最大有效单元格数。
 * 02-review 追加 XLSX 预检（在展开 ZIP 之前的有界防护）：最大 ZIP 条目数、
 * 最大声明未压缩大小、最大压缩膨胀比、最大 ZIP 头缓冲。
 * 全部为保守开发默认值，适配 Motro 4 GB 家庭服务器；生产值由部署注入。
 * fileRootDir 绝不写入 API 响应；只用于服务端读写原始导入文件。
 */
const ImportSchema = z.object({
  fileRootDir: z.string().min(1),
  maxFileBytes: z.coerce.number().int().positive(),
  allowedFormats: z.array(z.string().min(1)).default([]),
  maxRows: z.coerce.number().int().positive(),
  maxCellLength: z.coerce.number().int().positive(),
  maxJsonDepth: z.coerce.number().int().positive(),
  maxSheets: z.coerce.number().int().positive(),
  maxCells: z.coerce.number().int().positive(),
  maxSummaryLength: z.coerce.number().int().positive(),
  // XLSX 预检（ZIP 展开前）。
  maxZipEntries: z.coerce.number().int().positive(),
  maxZipUncompressedBytes: z.coerce.number().int().positive(),
  maxZipExpansionRatio: z.coerce.number().int().positive(),
});
export type ImportConfig = z.infer<typeof ImportSchema>;

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
  worker: WorkerSchema,
  import: ImportSchema,
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
    worker: {
      concurrency: env.WORKER_CONCURRENCY ?? "1",
      maxPoolSize: env.WORKER_MAX_POOL_SIZE ?? "2",
      maxAttempts: env.WORKER_MAX_ATTEMPTS ?? "5",
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS ?? "2000",
      leaseMs: env.WORKER_LEASE_MS ?? "60000",
      recovery: {
        recoverIntervalMs: env.WORKER_RECOVER_INTERVAL_MS ?? "2000",
        recoverBatchSize: env.WORKER_RECOVER_BATCH_SIZE ?? "20",
      },
    },
    import: {
      fileRootDir: env.IMPORT_FILE_ROOT_DIR ?? ".local-import-files",
      maxFileBytes: env.IMPORT_MAX_FILE_BYTES ?? String(10 * 1024 * 1024),
      allowedFormats: (env.IMPORT_ALLOWED_FORMATS ?? "txt,csv,json,xlsx")
        .split(",")
        .filter((s) => s.length > 0),
      maxRows: env.IMPORT_MAX_ROWS ?? "50000",
      maxCellLength: env.IMPORT_MAX_CELL_LENGTH ?? "1000",
      maxJsonDepth: env.IMPORT_MAX_JSON_DEPTH ?? "10",
      maxSheets: env.IMPORT_MAX_SHEETS ?? "50",
      maxCells: env.IMPORT_MAX_CELLS ?? "200000",
      maxSummaryLength: env.IMPORT_MAX_SUMMARY_LENGTH ?? "120",
      // XLSX 预检（ZIP 展开前）。
      maxZipEntries: env.IMPORT_MAX_ZIP_ENTRIES ?? "1024",
      maxZipUncompressedBytes: env.IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES ?? String(256 * 1024 * 1024),
      maxZipExpansionRatio: env.IMPORT_MAX_ZIP_EXPANSION_RATIO ?? "100",
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
    worker: config.worker,
    importFile: {
      fileRootDir: config.import.fileRootDir,
      maxFileBytes: config.import.maxFileBytes,
      allowedFormats: config.import.allowedFormats,
      maxRows: config.import.maxRows,
      maxCellLength: config.import.maxCellLength,
      maxJsonDepth: config.import.maxJsonDepth,
      maxSheets: config.import.maxSheets,
      maxCells: config.import.maxCells,
      maxSummaryLength: config.import.maxSummaryLength,
      maxZipEntries: config.import.maxZipEntries,
      maxZipUncompressedBytes: config.import.maxZipUncompressedBytes,
      maxZipExpansionRatio: config.import.maxZipExpansionRatio,
    },
  };
}
