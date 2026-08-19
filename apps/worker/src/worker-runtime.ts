// 阶段 6 工单 04 + 工单 05 + 阶段 7 工单 22：Worker 进程共享装配。
// 统一读取配置、创建 pg pool、按 providerMode 注册 handler 与 task list，
// 供 migrate/main/once 复用。
//
// 模式切换（T22）：
//   - providerMode=fake（默认）：注册 fixture + wiktionary fake + deepseek fake；
//   - providerMode=real：注册 fixture + wiktionary real + deepseek real。
//   不允许 real/fake 静默混用：同一 task identifier 只能有一个 handler。
import { loadConfig, type AppConfig, type DbConfig } from "@motro/config";
import { createPool } from "@motro/db";
import { runMigrations } from "graphile-worker";
import type { Pool } from "pg";
import type { OperationHandlerRegistry } from "@motro/domain";
import { buildFixtureHandler } from "./fixture-handler.js";
import { buildTaskList } from "./task-list.js";
import { buildWiktionaryFakeHandler } from "./wiktionary-fake-handler.js";
import { buildDeepSeekFakeHandler } from "./deepseek-fake-handler.js";
import { buildWiktionaryRealAdapter } from "./wiktionary-real-adapter.js";
import { buildDeepSeekRealAdapter } from "./deepseek-real-adapter.js";

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

// ---- 模式切换：按 providerMode 注册 exclusive handler ----

/**
 * 注册 worker handler registry。providerMode=fake 时注册 fake handler；
 * providerMode=real 时注册 real adapter。fixture 恒注册。
 *
 * 不允许 real/fake 静默混用：同一个 task identifier 在 registry 中只能出现一次。
 */
function buildHandlerRegistry(pool: Pool, config: AppConfig): OperationHandlerRegistry {
  const fixture = buildFixtureHandler(pool);
  const providerMode = config.providerMode;
  let wiktionary: OperationHandlerRegistry;
  let deepseek: OperationHandlerRegistry;
  if (providerMode === "real") {
    wiktionary = buildWiktionaryRealAdapter(pool, config);
    deepseek = buildDeepSeekRealAdapter(pool, config);
  } else {
    wiktionary = buildWiktionaryFakeHandler(pool);
    deepseek = buildDeepSeekFakeHandler(pool);
  }
  // fixture + wiktionary + deepseek 的 task identifier 互不冲突（motro-op-fixture /
  // motro-wiktionary-{fake,real} / motro-deepseek-{fake,real}）。
  return new Map([...fixture, ...wiktionary, ...deepseek]);
}

export function createWorkerRuntime(env: NodeJS.ProcessEnv = process.env): WorkerRuntime {
  const config = loadConfig(env);
  const pool = createPool({ ...config.db, max: config.worker.maxPoolSize });
  const registry = buildHandlerRegistry(pool, config);
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
