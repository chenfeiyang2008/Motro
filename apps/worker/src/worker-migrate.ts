// 阶段 6 工单 04：`worker:migrate` 入口。
// 依次执行：
//   1. Motro 业务 migration（db/migrations 0001–0025，@motro/db migrate）；
//   2. Graphile 官方 schema migration（runMigrations，schema=graphile_worker）。
//
// 升级 runbook（scale-to-zero）：先停 worker，再迁移，再启动。API 的 readiness 必须
// 区分「业务 migration 完成」与「Graphile worker schema 未就绪」。
import { resolve } from "node:path";
import { migrate as runBusinessMigrations } from "@motro/db";
import { createWorkerRuntime, runGraphileMigrations } from "./worker-runtime.js";

async function main(): Promise<void> {
  const { config, pool } = createWorkerRuntime();
  const migrationsDir = resolve(process.cwd(), "db/migrations");
  const applied = await runBusinessMigrations(config.db, migrationsDir);
  console.log(`[worker:migrate] 业务 migration 已应用：${applied.length} 个（总数含已存在）`);
  await runGraphileMigrations(config);
  console.log("[worker:migrate] Graphile Worker schema 就绪（graphile_worker）");
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(`worker:migrate 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
