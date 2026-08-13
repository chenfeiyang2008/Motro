// 隔离 E2E 生命周期库单元测试（P1-A / P1-B）。
// 用可控制的异步 child runner 与真实信号触发（非同步 mock 内直接调 handler）验证：
//   - up 失败仍 cleanup 一次；
//   - ready/migrate/test 失败 cleanup 一次；
//   - cleanup 失败使 runner 失败；
//   - cleanup 不重复执行；
//   - SIGINT/SIGTERM 在「命令仍运行」时：active child 被请求停止、后续步骤不运行、cleanup 一次、
//     退出 130/143；
//   - cleanup 期间第二个信号不打断清理，cleanup 仍恰好一次。
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  runE2eLifecycle,
  signalExitCode,
  type AsyncChildRunner,
  type LifecycleDeps,
  type Signal,
} from "./import-e2e-lib.js";

/** 可控制的异步 child runner：run 可阻塞直到被 stop 或 resolve。 */
class StubRunner implements AsyncChildRunner {
  stopCalled = false;
  private pending: Array<{ stop: () => void; done: (ok: boolean) => void }> = [];
  private queue: boolean[] = [];
  /** stopActiveChild 解析被阻塞 run 的结果：默认 false（真实 spawn 被信号终止 → 非成功）。 */
  stopResult = false;

  /** 按 FIFO 依次让后续 run 返回指定结果。 */
  queueResult(ok: boolean): void {
    this.queue.push(ok);
  }

  run(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.queue.length > 0) {
        resolve(this.queue.shift()!);
        return;
      }
      // 阻塞，等待 stopActiveChild 或外部完成。
      this.pending.push({
        stop: () => {
          this.stopCalled = true;
          resolve(this.stopResult);
        },
        done: resolve,
      });
    });
  }

  stopActiveChild(): void {
    this.stopCalled = true;
    for (const p of this.pending) p.stop();
    this.pending = [];
  }

  /** 手动完成当前 run（模拟子进程退出）。 */
  finish(ok: boolean): void {
    for (const p of this.pending) p.done(ok);
    this.pending = [];
  }
}

function makeDeps(overrides: Partial<LifecycleDeps> = {}): {
  deps: LifecycleDeps;
  runner: StubRunner;
  logs: string[];
} {
  const runner = new StubRunner();
  const logs: string[] = [];
  const base: LifecycleDeps = {
    runner,
    start: () => runner.run("docker", ["up"]),
    ready: async () => {},
    migrate: async () => {},
    test: () => runner.run("pnpm", ["playwright"]),
    cleanup: () => runner.run("docker", ["down", "-v"]),
    onSignal: () => () => {},
    log: (m) => logs.push(m),
  };
  return { deps: { ...base, ...overrides }, runner, logs };
}

/** 注册一个可触发的信号 handler（真实信号路径：外部调用 handler）。 */

describe("runE2eLifecycle (P1-A/B)", () => {
  it("全部成功：cleanup 恰好一次，退出码 0", async () => {
    const { deps, runner } = makeDeps();
    runner.queueResult(true); // start
    runner.queueResult(true); // test
    runner.queueResult(true); // cleanup
    expect(await runE2eLifecycle(deps)).toBe(0);
    expect(runner.stopCalled).toBe(false);
  });

  it("start（up）失败：仍 cleanup 一次，退出码 1", async () => {
    const { deps, runner } = makeDeps();
    runner.queueResult(false); // start
    runner.queueResult(true); // cleanup
    expect(await runE2eLifecycle(deps)).toBe(1);
  });

  it("ready 失败：cleanup 一次，退出码 1", async () => {
    const { deps, runner } = makeDeps({
      ready: async () => {
        throw new Error("api not ready");
      },
    });
    runner.queueResult(true); // start
    runner.queueResult(true); // cleanup
    expect(await runE2eLifecycle(deps)).toBe(1);
  });

  it("migrate 失败：cleanup 一次，退出码 1", async () => {
    const { deps, runner } = makeDeps({
      migrate: async () => {
        throw new Error("migration failed");
      },
    });
    runner.queueResult(true); // start
    runner.queueResult(true); // cleanup
    expect(await runE2eLifecycle(deps)).toBe(1);
  });

  it("test（Playwright）失败：cleanup 一次，退出码 1", async () => {
    const { deps, runner } = makeDeps();
    runner.queueResult(true); // start
    runner.queueResult(false); // test
    runner.queueResult(true); // cleanup
    expect(await runE2eLifecycle(deps)).toBe(1);
  });

  it("cleanup 自身失败：使 runner 非零，且不重复执行", async () => {
    const { deps, runner } = makeDeps();
    runner.queueResult(true); // start
    runner.queueResult(true); // test
    runner.queueResult(false); // cleanup 失败
    expect(await runE2eLifecycle(deps)).toBe(1);
  });

  it("SIGINT 在 start 命令仍运行时：active child 被停止、后续步骤不运行、cleanup 一次、退出 130", async () => {
    const { deps, runner } = makeDeps();
    let fireHandler: ((sig: Signal) => void) | undefined;
    deps.onSignal = (handler: (sig: Signal) => void): (() => void) => {
      fireHandler = handler;
      return () => {};
    };
    // start 阻塞（空 queue）；cleanup 也阻塞，稍后由 finish 完成。
    const runPromise = runE2eLifecycle(deps);
    // 等待 start 进入阻塞，再触发 SIGINT（真实信号路径：handler 由信号回调调用）。
    await new Promise((res) => setTimeout(res, 5));
    fireHandler?.("SIGINT");
    // stopActiveChild 被调用，把阻塞的 start 解析为【false】（真实 spawn 被信号终止 → 非成功）。
    expect(runner.stopCalled).toBe(true);
    // 信号退出码优先于「start 失败」：应返回 130 而非 1。
    // cleanup（down -v）仍执行并完成。
    await new Promise((res) => setTimeout(res, 5));
    runner.finish(true);
    expect(await runPromise).toBe(130);
  });

  it("SIGTERM 在 Playwright 命令仍运行时：cleanup 一次、退出 143", async () => {
    const { deps, runner } = makeDeps();
    // start 立即成功（queue 1 个 true）；test 阻塞（空 queue，模拟 Playwright 长跑）。
    runner.queueResult(true); // start
    let fireHandler: ((sig: Signal) => void) | undefined;
    deps.onSignal = (handler: (sig: Signal) => void): (() => void) => {
      fireHandler = handler;
      return () => {};
    };
    const runPromise = runE2eLifecycle(deps);
    await new Promise((res) => setTimeout(res, 5));
    fireHandler?.("SIGTERM");
    expect(runner.stopCalled).toBe(true);
    // cleanup（down -v）仍执行并完成。
    await new Promise((res) => setTimeout(res, 5));
    runner.finish(true);
    expect(await runPromise).toBe(143);
  });

  it("cleanup 期间第二个信号：不打断清理，cleanup 仍恰好一次", async () => {
    const { deps, runner } = makeDeps();
    // start 与 test 立即成功（queue FIFO）；cleanup 阻塞（模拟 down -v 长跑，不 queue）。
    runner.queueResult(true); // start
    runner.queueResult(true); // test
    let fireHandler: ((sig: Signal) => void) | undefined;
    deps.onSignal = (handler: (sig: Signal) => void): (() => void) => {
      fireHandler = handler;
      return () => {};
    };
    const runPromise = runE2eLifecycle(deps);
    // 等待 cleanup 开始（[5] 日志出现），再触发第二个信号。
    await new Promise((res) => setTimeout(res, 5));
    fireHandler?.("SIGTERM");
    // 完成 cleanup。
    runner.finish(true);
    expect(await runPromise).toBe(0);
    // cleanup 期间第二个信号不打断 down -v（stopActiveChild 未被调用）。
    expect(runner.stopCalled).toBe(false);
  });

  it("child-process 级：真实 SpawnRunner 子进程被 SIGINT 停止 → 生命周期返回 130（cleanup 一次）", async () => {
    // 用真实 spawn 子进程（无害的 node 定时器）+ 受控 cleanup，验证「被中断的子进程 → 信号退出码而非 1」。
    let child: ChildProcess | null = null;
    let cleanupRuns = 0;
    const childRunner: AsyncChildRunner = {
      run: () =>
        new Promise<boolean>((resolve) => {
          child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
          child.on("error", () => resolve(false));
          child.on("close", (code) => resolve(code === 0));
        }),
      stopActiveChild: () => {
        child?.kill("SIGTERM");
      },
    };
    const deps: LifecycleDeps = {
      runner: childRunner,
      start: () => childRunner.run("node", ["-e", "setTimeout(()=>{},30000)"]),
      ready: async () => {},
      migrate: async () => {},
      test: () => Promise.resolve(true),
      cleanup: () => {
        cleanupRuns += 1;
        return Promise.resolve(true);
      },
      onSignal: (handler: (sig: Signal) => void): (() => void) => {
        // 启动后触发一次 SIGINT，请求停止 active child。
        setTimeout(() => handler("SIGINT"), 10);
        return () => {};
      },
      log: () => {},
    };
    const exit = await runE2eLifecycle(deps);
    expect(exit).toBe(130); // SIGINT → 130，而非普通失败 1
    expect(cleanupRuns).toBe(1);
  });

  it("signalExitCode 映射正确", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });
});
