// 阶段 6 工单 04：独立 Worker 进程入口。
//
// - library mode + 显式 TypeScript task list（不扫描目录、不执行上传内容）；
// - 4 GB 预算：concurrency 默认 1，pool 最大 2；
// - SIGTERM/SIGINT → Graphile graceful shutdown：不丢 attempt、不把 running 假标成功；
// - 受控的 lease-expiry 恢复扫描（recovery loop）：worker 启动后立即扫一次，此后周期性
//   扫描仍持有已过期 lease 的 running operation 并重新 enqueue（工单 04 修复）；
// - API 可在 worker 重启期间继续提供持久化状态；worker 恢复后继续处理未完成 job。
import { loadConfig } from "@motro/config";
import { run } from "graphile-worker";
import { safeErrorSummary } from "@motro/domain";
import {
  createWorkerRuntime,
  runGraphileMigrations,
  pgConnectionString,
} from "./worker-runtime.js";
import { RecoveryScanLoop } from "./recovery-scan.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { pool, taskList, recovery } = createWorkerRuntime();

  // 业务 migration 完成后，worker schema 必须就绪；未就绪直接失败（readiness 区分在 API）。
  await runGraphileMigrations(config);

  const connectionString = pgConnectionString(config.db);
  const runner = await run(
    {
      connectionString,
      schema: "graphile_worker",
      concurrency: config.worker.concurrency,
      maxPoolSize: config.worker.maxPoolSize,
      pollInterval: config.worker.pollIntervalMs,
      gracefulShutdownAbortTimeout: 5000,
    },
    taskList,
  );

  console.log(
    `[worker] 启动完成：concurrency=${config.worker.concurrency} pool=${config.worker.maxPoolSize} ` +
      `pollIntervalMs=${config.worker.pollIntervalMs} tasks=${Object.keys(taskList).join(",")}`,
  );

  // lease-expiry 恢复扫描：启动后立即执行一次，此后按 intervalMs 周期执行。
  const recoveryLoop = new RecoveryScanLoop({
    pool,
    intervalMs: recovery.intervalMs,
    batchSize: recovery.batchSize,
    onError: (e) =>
      console.error(
        `[worker:recovery] 恢复扫描错误 operationId=${e.operationId}: ${e.errorSummary}`,
      ),
  });
  recoveryLoop.start();
  console.log(
    `[worker:recovery] 恢复扫描已启动：intervalMs=${recovery.intervalMs} batchSize=${recovery.batchSize}`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] 收到 ${signal}，开始优雅关闭…`);
    // 先停止恢复扫描（不在关闭期间继续发起 recovery enqueue），再停 Graphile runner。
    void recoveryLoop
      .stop()
      .catch(() => {})
      .then(() =>
        runner
          .stop()
          .then(async () => {
            await pool.end();
            console.log("[worker] 已优雅关闭");
            process.exit(0);
          })
          .catch((err: unknown) => {
            console.error(
              `[worker] 关闭失败：${safeErrorSummary(undefined, err instanceof Error ? err.message : String(err))}`,
            );
            process.exit(1);
          }),
      );
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(
    `[worker] 启动失败：${safeErrorSummary(undefined, err instanceof Error ? err.message : String(err))}`,
  );
  process.exit(1);
});
