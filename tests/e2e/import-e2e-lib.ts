// admin-imports E2E 生命周期库（P1-A / P1-B）：可测试的 runner 编排 + cleanup-once + 真实信号。
//
// 设计目标：
//   - 命令执行使用【异步 child（spawn）】而非 spawnSync，避免阻塞事件循环，使 SIGINT/SIGTERM
//     handler 在 Docker 启动 / Playwright 长时间运行时也能及时执行。
//   - 生命周期模块持有当前 active child：收到首个信号时请求该 child 优雅停止，阻止后续步骤，进入
//     cleanup。
//   - cleanup 期间【不注销信号 handler】：清理中再收到信号只记录/忽略，绝不中途杀死 down -v；
//     cleanup 结束后才注销。
//   - cleanup 最多执行一次；cleanup 失败使 runner 非零。
//   - SIGKILL / 断电 / 宿主崩溃不可捕获；README 保留手动清理命令。

export type Signal = "SIGINT" | "SIGTERM";

/** 异步命令执行器：返回是否成功；抛错视为命令异常。 */
export type AsyncCommand = () => Promise<boolean>;

/** 由生命周期库注入的命令 runner：跟踪 active child，供信号停止。 */
export interface AsyncChildRunner {
  /** 执行一条命令（spawn）。返回是否成功。 */
  run(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<boolean>;
  /** 请求当前 active child 优雅停止（SIGTERM 优先，必要时 SIGKILL）。 */
  stopActiveChild(): void;
}

export interface LifecycleDeps {
  runner: AsyncChildRunner;
  /** 启动独立栈（docker compose up -d --build）。 */
  start(): Promise<boolean>;
  /** 等待 readiness。失败抛错。 */
  ready(): Promise<void>;
  /** 迁移 + 断言独立库。失败抛错。 */
  migrate(): Promise<void>;
  /** 运行 Playwright。 */
  test(): Promise<boolean>;
  /** 清理独立栈（down -v）。 */
  cleanup(): Promise<boolean>;
  /** 注册信号处理（cleanup 期间仍生效）；返回注销函数。 */
  onSignal(handler: (sig: Signal) => void): () => void;
  /** 输出消息。 */
  log(msg: string): void;
}

/** 内部中断信号（步骤间检查）。 */
export class InterruptedError extends Error {
  constructor(readonly sig: Signal) {
    super(`interrupted by ${sig}`);
  }
}

/** SIGINT / SIGTERM 的标准退出码。 */
export function signalExitCode(sig: Signal): number {
  return sig === "SIGINT" ? 130 : 143;
}

/**
 * 执行 E2E 生命周期，返回进程退出码（0 成功；1 任一步失败或 cleanup 失败；130/143 中断）。
 * 保证：cleanup 最多执行一次；start 失败也执行 cleanup；cleanup 期间信号不打断清理。
 */
export async function runE2eLifecycle(deps: LifecycleDeps): Promise<number> {
  let cleaned = false;
  let cleaning = false;
  let interruptedBy: Signal | null = null;
  // 信号 handler 在 cleanup 结束后才注销；cleanup 期间仍生效，但只记录/忽略，
  // 绝不停止 active child（否则会中途杀死 down -v，留下容器/卷）。
  const unregister = deps.onSignal((sig) => {
    if (interruptedBy === null) interruptedBy = sig;
    // 仅当【未进入 cleanup】且【已有首个信号】时，请求当前 active child 优雅停止。
    if (!cleaning && interruptedBy !== null) deps.runner.stopActiveChild();
  });

  const shouldStop = (): Signal | null => interruptedBy;
  let exitCode = 0;

  try {
    deps.log("[1] 启动独立 E2E 栈…");
    const started = await deps.start();
    // P1-1：若信号已记录（即使 start 因被停止而返回 false），信号退出码优先于普通失败。
    if (shouldStop()) throw new InterruptedError(interruptedBy!);
    if (!started) {
      deps.log("启动失败，进入清理。");
      exitCode = 1;
    } else {
      deps.log("[2] 等待 readiness…");
      await deps.ready();
      if (shouldStop()) throw new InterruptedError(interruptedBy!);

      deps.log("[3] 迁移独立库…");
      await deps.migrate();
      if (shouldStop()) throw new InterruptedError(interruptedBy!);

      deps.log("[4] 运行 E2E…");
      const ok = await deps.test();
      // 信号优先于命令失败（test 可能因被停止而返回 false）。
      if (shouldStop()) throw new InterruptedError(interruptedBy!);
      if (!ok) exitCode = 1;
    }
  } catch (e) {
    if (e instanceof InterruptedError) {
      deps.log(`被 ${e.sig} 中断。`);
      exitCode = signalExitCode(e.sig);
    } else {
      deps.log(`E2E 运行失败：${e instanceof Error ? e.message : String(e)}`);
      exitCode = 1;
    }
  } finally {
    // cleanup 期间不注销 handler；第二个中断只记录（cleaning 置 true，不再 stopActiveChild）。
    if (!cleaned) {
      cleaned = true;
      cleaning = true;
      deps.log("[5] 清理独立 E2E 栈（down -v）…");
      const okClean = await deps.cleanup();
      if (!okClean) {
        deps.log("清理失败：请手动执行 docker compose -f compose/e2e-import.yml down -v");
        if (exitCode === 0) exitCode = 1;
      }
    }
    // 清理结束，注销信号 handler。
    unregister();
    if (cleaned) deps.log("cleanup 已执行（cleanup-once）。");
  }

  return exitCode;
}
