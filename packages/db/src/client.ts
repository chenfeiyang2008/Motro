// PostgreSQL 连接边界。配置由 @motro/config 统一解析。
import { loadConfig, type DbConfig } from "@motro/config";
import { Pool, type PoolConfig } from "pg";

export type { DbConfig } from "@motro/config";

/** CLI/测试入口：从环境变量加载完整配置并取数据库切片。 */
export function loadDbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return loadConfig(env).db;
}

export interface PoolOptions extends DbConfig {
  max?: number;
}

export function createPool(config: PoolOptions): Pool {
  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max ?? 10,
  };
  return new Pool(poolConfig);
}
