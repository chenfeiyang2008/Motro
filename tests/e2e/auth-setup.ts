// Playwright setup helper：为 admin-imports E2E 准备「隔离管理员」账户并登录。
// 由 admin-imports.spec.ts 的 test.beforeAll 导入并调用。
//
// 并发隔离（P1-2）：每个 Playwright project（chromium / webkit）使用独立的：
//   - state 文件（tests/e2e/.auth/imports-<run-id>-<project>.json）
//   - 隔离管理员用户名（e2e-import-admin-<run-id>-<project>）
// 绝不删除整个 .auth 目录，只写/删自己的文件；Chromium 与 WebKit 并发时互不抢占。
//
// 连接【独立 E2E 数据库】（E2E_IMPORT_DB / E2E_POSTGRES_PORT）。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "@playwright/test";
import { createPool, loadDbConfigFromEnv } from "@motro/db";
// 复用 API 的密码服务（内部使用 @node-rs/argon2，从 apps/api 解析依赖）。
import { PasswordService } from "../../apps/api/src/auth/password.service.js";
import type { ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName } from "./import-e2e-db.js";

const WEB = process.env.PW_BASE_URL ?? "http://127.0.0.1:3001";
const AUTH_DIR = resolve(process.cwd(), "tests/e2e/.auth");
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";

/** 每次进程运行生成一次 run id（稳定、非用户输入）。 */
export const RUN_ID = `r${process.pid.toString(36)}${Date.now().toString(36)}`;

/**
 * 返回本项目专属 state 文件路径。
 * @param project Playwright project 名（chromium / webkit）。
 */
export function stateFileFor(project: string): string {
  return resolve(AUTH_DIR, `imports-${RUN_ID}-${project}.json`);
}

/** 本项目专属管理员用户名前缀。 */
export function adminUsernameFor(project: string): string {
  return `e2e-import-admin-${RUN_ID}-${project}`;
}

/** 隔离 E2E 数据库名（runbook 必须设置；安全白名单拒绝共享库名）。 */
function dbName(): string {
  const name = process.env.E2E_IMPORT_DB ?? "";
  assertSafeDbName(name);
  return name;
}

/** 隔离 E2E 数据库端口（runbook 设置；默认回退环境 POSTGRES_PORT）。 */
function dbPort(): number {
  return Number(process.env.E2E_POSTGRES_PORT ?? process.env.POSTGRES_PORT ?? 5432);
}

/**
 * 创建隔离管理员（项目专属用户名）+ 登录并写入【本项目专属】storageState。
 * 只清理自己的 state 文件，绝不删除整个 .auth 目录（避免删掉另一 project 的 state）。
 * @param browser 复用当前 worker 的浏览器。
 * @param stateFile 本项目专属 state 文件路径。
 * @param username 本项目专属管理员用户名。
 */
export async function createIsolatedAdmin(
  browser: Browser,
  stateFile: string,
  username: string,
): Promise<ImportTestAdmin> {
  if (!ADMIN_PASS) {
    throw new Error("E2E_ADMIN_PASSWORD 未设置，无法创建隔离管理员");
  }
  // 只删除自己的 state 文件（避免误删并发项目的文件）。
  rmSync(stateFile, { force: true });
  mkdirSync(AUTH_DIR, { recursive: true });

  const pool = createPool({ ...loadDbConfigFromEnv(), database: dbName(), port: dbPort() });
  let userId: string;
  try {
    const ps = new PasswordService();
    const hashed = await ps.hashPassword(ADMIN_PASS);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'E2E Import Admin', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       RETURNING id`,
      [username, hashed],
    );
    userId = result.rows[0]!.id;
  } finally {
    await pool.end();
  }

  // 登录该隔离管理员，写本项目专属 storageState。
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${WEB}/login`);
    await page.getByRole("heading", { name: "登录 Motro" }).waitFor();
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码").fill(ADMIN_PASS);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(/\/change-password|\/app/, { timeout: 30000 });
    if (page.url().includes("change-password")) {
      await page.getByLabel(/当前密码/).fill(ADMIN_PASS);
      await page.getByLabel(/^新密码/).fill(`${ADMIN_PASS}${ADMIN_PASS}`);
      await page.getByLabel(/确认新密码/).fill(`${ADMIN_PASS}${ADMIN_PASS}`);
      await page.getByRole("button", { name: "保存新密码" }).click();
      await page.waitForURL(/\/app/, { timeout: 15000 });
    }
    const cookies = await context.cookies();
    writeFileSync(stateFile, JSON.stringify({ cookies, origins: [] }, null, 2));
  } finally {
    await context.close();
  }

  console.log(`[auth-setup] 隔离管理员 ${username} 已就绪（userId=${userId}）`);
  return { userId, username };
}
