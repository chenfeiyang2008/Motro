// 阶段 6 工单 04：`worker:once` 入口。
// runOnce：处理当前可执行 job 后返回，供测试/运维一次性排空队列。
import { loadConfig } from "@motro/config";
import { runOnce } from "graphile-worker";
import {
  createWorkerRuntime,
  runGraphileMigrations,
  pgConnectionString,
} from "./worker-runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { pool, taskList } = createWorkerRuntime();
  await runGraphileMigrations(config);

  const connectionString = pgConnectionString(config.db);
  await runOnce(
    {
      connectionString,
      schema: "graphile_worker",
      concurrency: 1,
      maxPoolSize: config.worker.maxPoolSize,
      pollInterval: config.worker.pollIntervalMs,
    },
    taskList,
  );
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(`worker:once 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
