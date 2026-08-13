// admin-imports E2E 官方 CLI 入口（P1-A / P1-B / P1-C）。
//
// 唯一推荐入口：`E2E_ADMIN_PASSWORD=<口令> pnpm run e2e:import`。
// 所有编排/清理/信号逻辑在 import-e2e-lib.ts（可测试）；本文件只负责：
//   - 用【异步 spawn】执行真实命令（docker compose / pnpm playwright），避免阻塞事件循环；
//   - 把进程 SIGINT/SIGTERM 接进生命周期库；
//   - 使用【单一已解析目标】（resolveIsolatedE2eTarget：固定 127.0.0.1:5433/3100/3101）。
//
// 契约：
//   - 启动失败、readiness/migration/Playwright 失败、SIGINT/SIGTERM 中断都保证执行一次 down -v；
//   - cleanup 期间信号只记录/忽略，不打断清理；
//   - API/Web 固定 127.0.0.1:3100/3101，忽略 API_PUBLIC_URL / PW_BASE_URL 的远程值；
//   - SIGKILL/断电不可捕获；README 保留手动清理命令。
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { runE2eLifecycle, type AsyncChildRunner, type Signal } from "./import-e2e-lib.js";
import {
  resolveIsolatedE2eTarget,
  buildE2eChildEnv,
  migrateIsolatedDatabase,
  assertIsolatedDatabaseReady,
} from "./import-e2e-db.js";

const COMPOSE = "compose/e2e-import.yml";

/** 异步 child runner：跟踪当前 active child，供信号优雅停止。 */
class SpawnRunner implements AsyncChildRunner {
  private active: ChildProcess | null = null;

  run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
    return new Promise<boolean>((resolvePromise) => {
      const child = spawn(cmd, args, {
        stdio: "inherit",
        env: { ...process.env, ...opts.env },
        cwd: resolve(process.cwd()),
      });
      this.active = child;
      child.on("error", (err) => {
        this.active = null;
        console.error(`命令执行失败（${cmd}）：`, err.message);
        resolvePromise(false);
      });
      child.on("close", (code) => {
        this.active = null;
        resolvePromise(code === 0);
      });
    });
  }

  stopActiveChild(): void {
    if (this.active && this.active.exitCode === null && this.active.signalCode === null) {
      // 先 SIGTERM 优雅停止；5s 未退出则 SIGKILL（仅针对该子进程，不波及他人）。
      this.active.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.active && this.active.exitCode === null && this.active.signalCode === null) {
          this.active.kill("SIGKILL");
        }
      }, 5000);
      this.active.once("close", () => clearTimeout(timer));
    }
  }
}

async function waitFor(url: string, what: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // 未就绪，继续轮询。
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`${what} 在 ${tries * 2}s 内未就绪：${url}`);
}

async function main(): Promise<void> {
  const pass = process.env.E2E_ADMIN_PASSWORD;
  if (!pass || pass.length < 12) {
    console.error("请设置 E2E_ADMIN_PASSWORD（至少 12 字符）后运行 pnpm run e2e:import");
    process.exitCode = 1;
    return;
  }

  // 单一已解析目标：固定 host/port/db/凭据/API/Web（忽略远程环境变量）。
  const target = resolveIsolatedE2eTarget();
  const runner = new SpawnRunner();

  // P1-2：显式覆盖 API/Web 目标为已解析的本机地址，绝不让父环境的远程值残留。
  const envForE2E: NodeJS.ProcessEnv = buildE2eChildEnv(target);

  const exitCode = await runE2eLifecycle({
    runner,
    start: () => runner.run("docker", ["compose", "-f", COMPOSE, "up", "-d", "--build"]),
    ready: async () => {
      await waitFor(`${target.apiUrl}/api/v1/health/live`, "api-e2e");
      await waitFor(target.webUrl, "web-e2e");
    },
    migrate: async () => {
      // 迁移/断言使用【同一个已解析 db 配置对象】，不重新读环境、不产生目标漂移。
      await migrateIsolatedDatabase(target.db);
      await assertIsolatedDatabaseReady(target.db);
    },
    test: () =>
      runner.run(
        "pnpm",
        [
          "exec",
          "playwright",
          "test",
          "tests/e2e/admin-imports.spec.ts",
          "--project=chromium",
          "--project=webkit",
        ],
        { env: envForE2E },
      ),
    cleanup: () => runner.run("docker", ["compose", "-f", COMPOSE, "down", "-v"]),
    onSignal: (handler: (sig: Signal) => void): (() => void) => {
      const onSig = (sig: NodeJS.Signals): void => {
        if (sig === "SIGINT" || sig === "SIGTERM") handler(sig);
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
      return () => {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
      };
    },
    log: (msg) => console.log(msg),
  });

  console.log(exitCode === 0 ? "完成。共享 motro 数据库未受影响。" : "runner 以非零退出码结束。");
  process.exitCode = exitCode;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
