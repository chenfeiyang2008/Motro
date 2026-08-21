// 一次性截图脚本（不提交）：登录管理端 /admin 并截图，验证概览重排。
// 通过隔离 E2E DB 插入临时管理员，Playwright 登录后导航截图。
// 不改共享库、不写 .auth、不从 git 提交。
import { chromium } from "@playwright/test";
import { createPool } from "@motro/db";
import { PasswordService } from "../../apps/api/src/auth/password.service.js";

const WEB = process.env.PW_BASE_URL ?? "http://127.0.0.1:3101";
const E2E_DB = process.env.E2E_IMPORT_DB ?? "";
const E2E_PORT = Number(process.env.E2E_POSTGRES_PORT ?? 5433);

const user = `screenshot-admin-${Date.now().toString(36)}`;
const pass = "Screencap!2026";

async function main(): Promise<void> {
  if (!E2E_DB) throw new Error("E2E_IMPORT_DB 必须设置");
  const pool = createPool({
    host: "127.0.0.1",
    port: E2E_PORT,
    database: E2E_DB,
    user: "motro",
    password: "dev_only_change_me",
    max: 1,
  });
  const ps = new PasswordService();
  const hashed = await ps.hashPassword(pass);
  try {
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, '截图管理员', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT DO NOTHING`,
      [user, hashed],
    );
  } finally {
    await pool.end();
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${WEB}/login`);
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 15_000 });
  await page.getByLabel("用户名").fill(user);
  await page.getByLabel("密码").fill(pass);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(/\/admin|\/app|\/change-password/, { timeout: 20_000 });
  if (page.url().includes("change-password")) {
    const newP = pass + pass;
    await page.getByLabel(/当前密码/).fill(pass);
    await page.getByLabel(/^新密码/).fill(newP);
    await page.getByLabel(/确认新密码/).fill(newP);
    await page.getByRole("button", { name: "保存新密码" }).click();
    await page.waitForURL(/\/admin|\/app/, { timeout: 15_000 });
  }

  await page.goto(`${WEB}/admin`);
  await page.waitForSelector(".admin-overview__header", { timeout: 15_000 });
  await page.waitForSelector(
    ".admin-overview__metric-value, .admin-overview__error, .admin-overview__donut",
    { timeout: 15_000 },
  );

  const outPath = "/tmp/motro-admin-overview.png";
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`SCREENSHOT_OK ${outPath}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
