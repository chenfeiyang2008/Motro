// 隔离 E2E 数据库迁移助手（P2：接入正式 runner，不留死代码）。
//
// 背景：admin-imports E2E 必须运行在【独立数据库】（compose/e2e-import.yml 的 db-e2e，
// POSTGRES_DB=motro_e2e_import，独立命名卷）。数据库的创建/销毁由 compose 生命周期负责：
//   - 创建：`docker compose -f compose/e2e-import.yml up -d --build`（db-e2e 初始化空库）；
//   - 销毁：`docker compose -f compose/e2e-import.yml down -v`（移除独立卷）。
// 因此本文件只负责对独立库执行 migration（0001–0024），供 e2e:import runner 调用。
//
// 安全：不执行 CREATE DATABASE / DROP DATABASE（不把环境变量插入 SQL 标识符，杜绝注入）；
// 只对已知库名做 migration 与只读连通性检查。
import { createPool, migrate, type DbConfig } from "@motro/db";
import { loadConfig } from "@motro/config";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

/** 独立库名的安全白名单：仅允许带 e2e-import 标识的库名（防注入/防误连共享库）。 */
const SAFE_DB_RE = /^motro_e2e_import(_[a-z0-9-]{1,40})?$/;

export function assertSafeDbName(dbName: string): void {
  if (!SAFE_DB_RE.test(dbName)) {
    throw new Error(
      `独立 E2E 库名不合法（仅允许 motro_e2e_import[...]）："${dbName}"；` +
        `拒绝执行迁移以避免误连共享库或 SQL 注入。`,
    );
  }
}

/** 返回指向指定数据库的连接配置（其余取自环境；端口由 E2E_POSTGRES_PORT 控制）。 */
export function makeIsolatedDbConfig(dbName: string): DbConfig {
  assertSafeDbName(dbName);
  const db = loadConfig().db;
  const port = Number(process.env.E2E_POSTGRES_PORT ?? process.env.POSTGRES_PORT ?? 5432);
  return { ...db, database: dbName, port };
}

/** 对独立数据库应用全部 migration（0001–0024）。 */
export async function migrateIsolatedDatabase(dbName: string): Promise<void> {
  assertSafeDbName(dbName);
  await migrate(makeIsolatedDbConfig(dbName), MIGRATIONS_DIR);
}

/** 断言独立数据库可连接（SELECT 1）且已迁移到最新版本。不可用时抛错使 E2E 明确失败。 */
export async function assertIsolatedDatabaseReady(dbName: string): Promise<void> {
  assertSafeDbName(dbName);
  const pool = createPool(makeIsolatedDbConfig(dbName));
  try {
    const r = await pool.query<{ v: number }>(
      "SELECT max(version)::int AS v FROM schema_migrations",
    );
    if ((r.rows[0]?.v ?? 0) < 24) {
      throw new Error(
        `独立 E2E 库 ${dbName} 未完成迁移（当前 ${r.rows[0]?.v ?? 0} < 24）。请先运行迁移。`,
      );
    }
  } finally {
    await pool.end();
  }
}
