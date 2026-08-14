// 隔离 E2E 栈的【单一已解析目标】与迁移助手（P1-B / P1-C）。
//
// 这是唯一权威的宿主侧隔离 E2E 目标入口：
//   - resolveIsolatedE2eTarget(env?) — 一次性解析并校验：数据库配置 + API/Web URL
//   - migrateIsolatedDatabase(cfg)   — 接收【已解析的 db 配置对象】，不再重新读环境
//   - assertIsolatedDatabaseReady(cfg) — 同上
//
// 安全契约：
//   - host 强制 127.0.0.1；API/Web 强制 http://127.0.0.1:3100 / :3101；
//     绝不继承 POSTGRES_HOST / API_PUBLIC_URL / PW_BASE_URL 的远程值。
//   - 数据库名白名单 ^motro_e2e_import(_[a-z0-9-]{1,40})?$；
//     端口/凭据只用 E2E_POSTGRES_* 命名空间。
//   - 不输出密码、session key、CSRF key、cookie 或连接串。
import { createPool, migrate, type DbConfig } from "@motro/db";
import { runMigrations } from "graphile-worker";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

/** 独立库名的安全白名单：仅允许带 e2e-import 标识的库名（防注入/防误连共享库）。 */
const SAFE_DB_RE = /^motro_e2e_import(_[a-z0-9-]{1,40})?$/;

/** 强制本机 loopback host（绝不继承共享/远程 host）。 */
const LOOPBACK_HOST = "127.0.0.1";
/** 固定 API / Web 目标。 */
const API_PORT = 3100;
const WEB_PORT = 3101;

export interface IsolatedE2eDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** 单一已解析目标：数据库配置 + API/Web URL（同一对象贯穿迁移/校验/Playwright/Compose）。 */
export interface IsolatedE2eTarget {
  db: IsolatedE2eDbConfig;
  apiUrl: string;
  webUrl: string;
}

export function assertSafeDbName(dbName: string): void {
  if (!SAFE_DB_RE.test(dbName)) {
    throw new Error(
      `独立 E2E 库名不合法（仅允许 motro_e2e_import[...]）："${dbName}"；` +
        `拒绝执行迁移以避免误连共享库或 SQL 注入。`,
    );
  }
}

export function assertSafePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`独立 E2E 端口不合法：${port}`);
  }
}

/**
 * 一次性解析并校验隔离 E2E 目标。
 * 显式环境中的 POSTGRES_HOST / API_PUBLIC_URL / PW_BASE_URL / POSTGRES_USER/PASSWORD 一律忽略；
 * 只使用本机 loopback 与 E2E_* 命名空间。
 * @param env 显式环境（缺省 process.env）。
 */
export function resolveIsolatedE2eTarget(env: NodeJS.ProcessEnv = process.env): IsolatedE2eTarget {
  const database = env.E2E_IMPORT_DB ?? "motro_e2e_import";
  assertSafeDbName(database);

  const rawPort = env.E2E_POSTGRES_PORT ?? "5433";
  const port = Number(rawPort);
  assertSafePort(port);

  const user = env.E2E_POSTGRES_USER ?? "motro_e2e";
  const password = env.E2E_POSTGRES_PASSWORD ?? "e2e_only_change_me";

  return {
    db: { host: LOOPBACK_HOST, port, database, user, password },
    apiUrl: `http://${LOOPBACK_HOST}:${API_PORT}`,
    webUrl: `http://${LOOPBACK_HOST}:${WEB_PORT}`,
  };
}

/** 将隔离数据库配置转换为 @motro/db 的 DbConfig（max 由调用方控制）。 */
export function toDbConfig(cfg: IsolatedE2eDbConfig): DbConfig {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
  };
}

/**
 * 构造 Playwright 子进程环境：显式覆盖 API/Web 目标为已解析的本机地址，
 * 确保父环境的远程 API_PUBLIC_URL / PW_BASE_URL / POSTGRES_HOST 无法残留。
 * @param target 已解析的隔离目标。
 */
export function buildE2eChildEnv(target: IsolatedE2eTarget): NodeJS.ProcessEnv {
  return {
    E2E_IMPORT_DB: target.db.database,
    E2E_POSTGRES_PORT: String(target.db.port),
    API_PUBLIC_URL: target.apiUrl,
    PW_BASE_URL: target.webUrl,
    PW_WEB_PORT: String(3101),
    PW_REUSE_SERVER: "1",
  };
}

/** 对独立数据库应用全部 migration（0001–0025）+ Graphile 官方 schema。接收【已解析配置】。 */
export async function migrateIsolatedDatabase(cfg: IsolatedE2eDbConfig): Promise<void> {
  const db = toDbConfig(cfg);
  await migrate(db, MIGRATIONS_DIR);
  // 工单 04：import commit 会原子投递 Graphile job；官方 schema 必须先就绪。
  const conn = `postgresql://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${encodeURIComponent(db.database)}`;
  await runMigrations({ connectionString: conn, schema: "graphile_worker" });
}

/** 断言独立数据库可连接（SELECT 1）且已迁移到最新版本。接收【已解析配置】，不重新读环境。 */
export async function assertIsolatedDatabaseReady(cfg: IsolatedE2eDbConfig): Promise<void> {
  const pool = createPool(toDbConfig(cfg));
  try {
    const r = await pool.query<{ v: number }>(
      "SELECT max(version)::int AS v FROM schema_migrations",
    );
    if ((r.rows[0]?.v ?? 0) < 30) {
      throw new Error(
        `独立 E2E 库 ${cfg.database} 未完成迁移（当前 ${r.rows[0]?.v ?? 0} < 30）。请先运行迁移。`,
      );
    }
  } finally {
    await pool.end();
  }
}
