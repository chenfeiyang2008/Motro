// 阶段 6 工单 04 + 工单 05：Worker 进程共享装配。
// 统一读取配置、创建 pg pool、注册 fixture / wiktionary 假 handler 与 task list，
// 供 migrate/main/once 复用。工单 05 的 Wikipedia source fact fake handler 在此注册。
import { loadConfig, type AppConfig, type DbConfig } from "@motro/config";
import { createPool } from "@motro/db";
import { runMigrations } from "graphile-worker";
import type { Pool } from "pg";
import type { OperationHandlerRegistry } from "@motro/domain";
import { buildFixtureHandler } from "./fixture-handler.js";
import { buildTaskList } from "./task-list.js";
import { buildWiktionaryFakeHandler } from "./wiktionary-fake-handler.js";
import { buildDeepSeekFakeHandler } from "./deepseek-fake-handler.js";

export interface WorkerRuntime {
  config: AppConfig;
  pool: Pool;
  taskList: ReturnType<typeof buildTaskList>;
  leaseMs: number;
  /** lease-expiry 恢复扫描配置（受控、低频）。 */
  recovery: { intervalMs: number; batchSize: number };
}

export function toDbConfig(cfg: AppConfig): DbConfig {
  return cfg.db;
}

export function createWorkerRuntime(env: NodeJS.ProcessEnv = process.env): WorkerRuntime {
  const config = loadConfig(env);
  const pool = createPool({ ...config.db, max: config.worker.maxPoolSize });
  // 合并 fixture / wiktionary / deepseek 假 handler 为一个 registry（task identifier 唯一）。
  const fixture = buildFixtureHandler(pool);
  const wiktionary = buildWiktionaryFakeHandler(pool);
  const deepseek = buildDeepSeekFakeHandler(pool);
  const registry: OperationHandlerRegistry = new Map([...fixture, ...wiktionary, ...deepseek]);
  const taskList = buildTaskList(pool, registry, config.worker.leaseMs);
  return {
    config,
    pool,
    taskList,
    leaseMs: config.worker.leaseMs,
    recovery: {
      intervalMs: config.worker.recovery.recoverIntervalMs,
      batchSize: config.worker.recovery.recoverBatchSize,
    },
  };
}

/**
 * 运行 Graphile 官方 schema migration（runMigrations）。
 * 只管理官方 schema；绝不复制 Graphile schema 到 Motro migration。
 */
export async function runGraphileMigrations(config: AppConfig): Promise<void> {
  const connectionString = pgConnectionString(config.db);
  await runMigrations({ connectionString, schema: "graphile_worker" });
}

/** 从类型化 DbConfig 构造连接串（仅 worker 内部使用，绝不输出）。 */
export function pgConnectionString(db: DbConfig): string {
  const host = db.host.includes(":") ? `[${db.host}]` : db.host;
  return `postgresql://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${host}:${db.port}/${encodeURIComponent(db.database)}`;
}
