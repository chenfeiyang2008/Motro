// 阶段 6 工单 04 收口：Worker 生产运行姿态断言（Task 2）。
//
// 目标：用一个无需数据库、无 YAML 依赖的单元级断言，证明 worker 的运行姿态契约：
//   - 生产镜像默认不以 development 运行（Dockerfile 默认 NODE_ENV=production）；
//   - 本地开发 / E2E 的 development 语义由显式 compose 覆盖承担，而非镜像默认值；
//   - E2E compose 使用独立 host/port/db/secret 命名空间；
//   - API 仍等待 worker-migrate 成功后才启动；
//   - worker 进程不依赖 API 内部模块（隔离边界）。
//
// 采用与仓库既有「源码扫描守卫」一致的风格：直接读文件 + 正则断言，不引入新依赖。
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

describe("Ticket 04 worker 生产运行姿态", () => {
  const devCompose = read("compose/docker-compose.yml");
  const e2eCompose = read("compose/e2e-import.yml");
  const workerDockerfile = read("apps/worker/Dockerfile");

  it("worker 生产镜像默认运行姿态为 production，不以 development 兜底", () => {
    // 镜像默认值不得承担开发语义。
    expect(workerDockerfile).toMatch(/ENV NODE_ENV=production/);
    expect(workerDockerfile).not.toMatch(/ENV NODE_ENV=development/);
  });

  it("本地开发 compose 显式声明 development（显式覆盖镜像默认），而非依赖默认", () => {
    // 开发环境：compose 通过 ${NODE_ENV:-development} 显式提供 development。
    // 两个 worker 服务（worker-migrate + worker）都显式设置 NODE_ENV。
    const nodeEnvLines = devCompose.match(/NODE_ENV: \$\{NODE_ENV:-development\}/g) ?? [];
    expect(nodeEnvLines.length).toBeGreaterThanOrEqual(2);
  });

  it("E2E compose 显式使用 development 运行时（隔离测试的显式覆盖）", () => {
    // E2E 是隔离测试栈，需要 development 语义（非 Secure cookie、本地密钥）；
    // 这是镜像默认 production 之上的显式覆盖。api / worker-migrate / worker 三个服务显式声明
    // （web 是纯前端静态服务，无 Node 运行时进程）。
    const devLines = e2eCompose.match(/NODE_ENV: development/g) ?? [];
    expect(devLines.length).toBeGreaterThanOrEqual(3);
  });

  it("E2E compose 使用独立 host/port/db/secret 命名空间，不触碰共享栈", () => {
    // 独立数据库：端口 5433、库名 motro_e2e_import、用户 motro_e2e。
    expect(e2eCompose).toMatch(/E2E_POSTGRES_PORT:-5433/);
    expect(e2eCompose).toMatch(/E2E_IMPORT_DB:-motro_e2e_import/);
    expect(e2eCompose).toMatch(/E2E_POSTGRES_USER:-motro_e2e/);
    // 独立服务端口：api 3100、web 3101。
    expect(e2eCompose).toMatch(/3100:3100/);
    expect(e2eCompose).toMatch(/3101:3101/);
    // 独立 secret 命名空间（E2E 专用 session/CSRF key）。
    expect(e2eCompose).toMatch(/E2E_SESSION_KEY:-e2e-import-only-session-key/);
    expect(e2eCompose).toMatch(/E2E_CSRF_KEY:-e2e-import-only-csrf-key/);
    expect(e2eCompose).toMatch(/E2E_POSTGRES_PASSWORD:-e2e_only_change_me/);
    // 绝不共享开发库的密钥。
    expect(e2eCompose).not.toMatch(/development-only-session-key/);
  });

  it("API 仍等待 worker-migrate 成功后才启动（worker-migrate → worker → api 依赖链）", () => {
    // 本地开发 compose：api 依赖 worker-migrate 完成。
    expect(devCompose).toMatch(
      /depends_on:\n\s+db:\n\s+condition: service_healthy\n\s+worker-migrate:\n\s+condition: service_completed_successfully/,
    );
    // E2E compose：api-e2e 依赖 worker-migrate-e2e 完成。
    expect(e2eCompose).toMatch(/worker-migrate-e2e:\n\s+condition: service_completed_successfully/);
  });

  it("worker 进程不依赖 API 内部模块（隔离边界）", () => {
    // 源码扫描守卫：apps/worker/src 不得 import @nest / apps/api 内部模块 / operations 模块。
    const files = [
      "apps/worker/src/worker-main.ts",
      "apps/worker/src/worker-runtime.ts",
      "apps/worker/src/worker-migrate.ts",
      "apps/worker/src/worker-once.ts",
      "apps/worker/src/task-list.ts",
      "apps/worker/src/recovery-scan.ts",
      "apps/worker/src/operation-executor.ts",
      "apps/worker/src/fixture-handler.ts",
    ];
    for (const f of files) {
      if (!existsSync(resolve(ROOT, f))) continue;
      const content = read(f);
      expect(content).not.toMatch(/@nest/);
      expect(content).not.toMatch(/apps\/api/);
      expect(content).not.toMatch(/modules\/operations/);
    }
  });

  it("worker compose 显式传递 recovery 扫描配置（受控、低频）", () => {
    // 本地开发与 E2E 都通过 env 显式注入 recovery 参数，便于测试可观测性与低频约束。
    for (const compose of [devCompose, e2eCompose]) {
      expect(compose).toMatch(/WORKER_RECOVER_INTERVAL_MS/);
      expect(compose).toMatch(/WORKER_RECOVER_BATCH_SIZE/);
    }
  });
});
