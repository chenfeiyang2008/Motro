// admin-imports E2E 官方 runner（P1-1 / P2）。
//
// 唯一推荐入口：`pnpm run e2e:import`。
// 流程（严格按序，全部只作用于独立 E2E 栈，绝不触碰共享 motro 栈）：
//   1) 启动独立栈：docker compose -f compose/e2e-import.yml up -d --build
//   2) 等待 db-e2e 与 api-e2e readiness
//   3) 对独立库 motro_e2e_import 执行 migration 0001–0024（安全库名白名单）
//   4) 校验独立库已迁移到 24
//   5) 运行 Playwright（Chromium + WebKit 并发）
//   6) 无论成败，最后提示/执行清理命令（只移除 motro-e2e-import 资源与卷）
//
// 环境变量：
//   E2E_ADMIN_PASSWORD  — 隔离管理员口令（必需）
//   E2E_POSTGRES_PORT   — 独立库宿主端口（默认 5433）
//   E2E_IMPORT_DB       — 独立库名（默认 motro_e2e_import）
//   API_PUBLIC_URL      — 独立 API 地址（默认 http://127.0.0.1:3100）
//   PW_BASE_URL         — 独立 Web 地址（默认 http://127.0.0.1:3101）
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { migrateIsolatedDatabase, assertIsolatedDatabaseReady } from "./import-e2e-db.js";

const COMPOSE = "compose/e2e-import.yml";
const E2E_DB = process.env.E2E_IMPORT_DB ?? "motro_e2e_import";
const E2E_PORT = process.env.E2E_POSTGRES_PORT ?? "5433";
const API_URL = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3100";
const WEB_URL = process.env.PW_BASE_URL ?? "http://127.0.0.1:3101";

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): boolean {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
    cwd: resolve(process.cwd()),
  });
  return res.status === 0;
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
  if (process.env.MOTRO_REQUIRE_DB !== "1") {
    // runner 本身已确保独立库；不要求用户额外设 MOTRO_REQUIRE_DB，但保留传递。
  }

  // 1) 启动独立栈。
  console.log("\n[1/5] 启动独立 E2E 栈…");
  if (!run("docker", ["compose", "-f", COMPOSE, "up", "-d", "--build"])) {
    console.error(
      "独立栈启动失败。查看日志：docker compose -f compose/e2e-import.yml logs api-e2e web-e2e db-e2e",
    );
    process.exitCode = 1;
    return;
  }

  try {
    // 2) 等待 readiness。
    await waitFor(`${API_URL}/api/v1/health/live`, "api-e2e");
    await waitFor(WEB_URL, "web-e2e");

    // 3) 迁移独立库（明确指向独立库端口/库名，避免误连共享 5432/motro）。
    console.log(`[2/5] 迁移独立库 ${E2E_DB}（0001–0024）…`);
    const prior = {
      port: process.env.E2E_POSTGRES_PORT,
      db: process.env.E2E_IMPORT_DB,
    };
    process.env.E2E_POSTGRES_PORT = E2E_PORT;
    process.env.E2E_IMPORT_DB = E2E_DB;
    try {
      await migrateIsolatedDatabase(E2E_DB);
      // 4) 校验已迁移。
      await assertIsolatedDatabaseReady(E2E_DB);
      console.log("独立库迁移完成：0001–0024 已应用。");
    } finally {
      // 恢复调用方环境。
      if (prior.port === undefined) delete process.env.E2E_POSTGRES_PORT;
      else process.env.E2E_POSTGRES_PORT = prior.port;
      if (prior.db === undefined) delete process.env.E2E_IMPORT_DB;
      else process.env.E2E_IMPORT_DB = prior.db;
    }

    // 5) 运行 Playwright（Chromium + WebKit 并发；每个 project 独立 state 文件与管理员）。
    console.log("[3/5] 运行 admin-imports E2E（Chromium + WebKit）…");
    const ok = run(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "tests/e2e/admin-imports.spec.ts",
        "--project=chromium",
        "--project=webkit",
      ],
      {
        env: {
          E2E_IMPORT_DB: E2E_DB,
          E2E_POSTGRES_PORT: E2E_PORT,
          API_PUBLIC_URL: API_URL,
          PW_BASE_URL: WEB_URL,
          PW_WEB_PORT: process.env.PW_WEB_PORT ?? "3101",
          PW_REUSE_SERVER: "1",
        },
      },
    );
    if (!ok) {
      console.error(
        "\nE2E 失败。查看日志：docker compose -f compose/e2e-import.yml logs api-e2e web-e2e db-e2e",
      );
      process.exitCode = 1;
    }
  } catch (e) {
    console.error("\nE2E 运行失败：", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    // 6) 清理（只移除 motro-e2e-import 资源与卷；绝不触碰共享 motro 栈）。
    console.log("\n[4/5] 清理独立 E2E 栈（down -v，只移除独立卷）…");
    if (!run("docker", ["compose", "-f", COMPOSE, "down", "-v"])) {
      console.error("清理命令失败，请手动执行：docker compose -f compose/e2e-import.yml down -v");
      process.exitCode = 1;
    }
    console.log("[5/5] 完成。共享 motro 数据库未受影响。");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
