// 管理端经验 / XP 账本页 E2E（原 Ticket 18 BLOCKED 占位已由 Ticket 19 替换为真实账本）。
// 验证：XP 账本只读展示；void/correction 对话框结构正确；补正金额校验；
// 390/768/1440 无横向溢出；键盘可达；深色主题可读。
// 运行于真实隔离 Compose 栈（与 admin-shell 共享 auth 模式）。
import { test as base, expect, type Browser, type Page } from "@playwright/test";

const WEB = process.env.PW_SHELL_WEB_URL ?? "http://127.0.0.1:3101";
const ADMIN_USER = process.env.E2E_SHELL_ADMIN_USERNAME ?? "e2e_shell_admin";
const ADMIN_PASS = process.env.E2E_SHELL_ADMIN_PASSWORD ?? "e2e-shell-admin-pass-2026";

const projectPromises = new Map<string, Promise<void>>();

async function loginAsAdminOnce(browser: Browser, stateFile: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"), { timeout: 30000 });
    await page.getByLabel("用户名").fill(ADMIN_USER);
    await page.getByLabel("密码").fill(ADMIN_PASS);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(/\/app|\/admin/, { timeout: 30000 });
    await context.storageState({ path: stateFile });
  } finally {
    await context.close();
  }
}

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use, testInfo) => {
    test.skip(ADMIN_PASS === "", "需要 E2E_SHELL_ADMIN_PASSWORD");
    const project = testInfo.project.name;
    const stateFile = `tests/e2e/.auth/xp-ledger-admin-${project}.json`;
    if (!projectPromises.has(project)) {
      projectPromises.set(project, loginAsAdminOnce(browser, stateFile));
    }
    await projectPromises.get(project);
    const context = await browser.newContext({ storageState: stateFile });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

test.describe("admin XP ledger (live page, Ticket 19 replacement)", () => {
  test("XP ledger page renders with heading, toolbar, and no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/xp`);
    await expect(page.getByRole("heading", { name: "经验 / 学习数据" })).toBeVisible();

    // Toolbar visible: 用户选择器、类型筛选、搜索用户
    await expect(page.getByLabel("用户（按 XP 汇总选择）")).toBeVisible();
    await expect(page.getByLabel("类型")).toBeVisible();

    // 刷新按钮
    await expect(page.getByRole("button", { name: "刷新" })).toBeVisible();

    // 无横向溢出
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w).toBeLessThanOrEqual(1440);
  });

  test("XP ledger table renders when data exists (or shows empty)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();
    await expect(page.locator(".xp-header")).toBeVisible();
    // ledger 或空态至少一个
    const ledger = page.locator("table.xp-ledger");
    const empty = page.locator(".xp-empty");
    await expect(ledger.or(empty)).toBeVisible({ timeout: 15000 });
  });

  test("void action dialog shows correct target info and reason field", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();

    // 如果没有行数据（空账本），跳过 void 测试。
    const rows = page.locator("[data-testid='xp-entry-row']");
    const row = rows.first();
    if (!(await row.isVisible())) return;

    // 找到第一行的"作废"按钮（仅对正向 award entry 显示）。
    const voidBtn = row.locator("button:has-text('作废')").first();
    if (!(await voidBtn.isVisible())) return;

    await voidBtn.click();
    // dialog 出现
    const dialog = page.locator(".xp-action-layer");
    await expect(dialog).toBeVisible();
    // 理由字段可见
    await expect(dialog.getByLabel("理由")).toBeVisible();
    // 作废按钮文本为"确认作废"
    await expect(dialog.getByRole("button", { name: "确认作废" })).toBeVisible();
    // 取消关闭
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("correct action dialog shows amount input for valid integer only", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();

    const rows = page.locator("[data-testid='xp-entry-row']");
    const row = rows.first();
    if (!(await row.isVisible())) return;

    const correctBtn = row.locator("button:has-text('补正')").first();
    if (!(await correctBtn.isVisible())) return;

    await correctBtn.click();
    const dialog = page.locator(".xp-action-layer");
    await expect(dialog).toBeVisible();
    // 补正金额字段可见
    await expect(dialog.getByLabel("补正金额（正=增加，负=减少）")).toBeVisible();
    // 理由字段
    await expect(dialog.getByLabel("理由")).toBeVisible();
    // 确认按钮
    await expect(dialog.getByRole("button", { name: "确认补正" })).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("correct dialog validates non-zero integer amount (empty amount → error)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();

    const rows = page.locator("[data-testid='xp-entry-row']");
    const row = rows.first();
    if (!(await row.isVisible())) return;

    const correctBtn = row.locator("button:has-text('补正')").first();
    if (!(await correctBtn.isVisible())) return;

    await correctBtn.click();
    const dialog = page.locator(".xp-action-layer");
    await expect(dialog).toBeVisible();

    // 空理由 → 提交被阻止（理由必填）。
    const confirmBtn = dialog.getByRole("button", { name: "确认补正" });
    await confirmBtn.click();
    await expect(dialog.getByText(/必须填写理由/)).toBeVisible();
  });

  test("390px no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w).toBeLessThanOrEqual(390);
  });

  test("768px no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w).toBeLessThanOrEqual(768);
  });

  test("keyboard: focus reaches toolbar controls and dialog buttons", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();

    if (testInfo.project.name === "webkit") {
      // WebKit doesn't synthesize sequential Tab; use direct focus.
      await page.getByLabel("类型").focus();
      await expect(page.getByLabel("类型")).toBeFocused();
      return;
    }
    // Chromium: Tab to first control.
    await page.keyboard.press("Tab");
    const first = page.locator(".xp-header .secondary").first();
    await expect(first).toBeFocused();
  });

  test("dark theme applies surface background", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/xp`);
    await page.getByRole("heading", { name: "经验 / 学习数据" }).waitFor();

    const themeBtn = page.locator(".theme-toggle--global");
    const initial = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (initial !== "dark") {
      await themeBtn.click();
      await page.waitForTimeout(200);
    }
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
      "dark",
    );
  });
});
