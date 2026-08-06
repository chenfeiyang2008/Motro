// 认证模块数据库访问：pg 连接池（配置来自 @motro/config）。
import { loadConfig } from "@motro/config";
import { createPool } from "@motro/db";
import type { Pool } from "pg";

export const POOL = Symbol("POOL");

export const databaseProvider = {
  provide: POOL,
  useFactory: (): Pool => {
    const config = loadConfig();
    return createPool({ ...config.db, max: 10 });
  },
};

export type { Pool };
