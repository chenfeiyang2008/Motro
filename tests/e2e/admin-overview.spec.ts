import { test as base, expect, type Browser, type Page } from "@playwright/test";

const WEB = process.env.PW_SHELL_WEB_URL ?? "http://127.0.0.1:3101";
const ADMIN_USER = process.env.E2E_SHELL_ADMIN_USERNAME ?? "e2e_shell_admin";
const ADMIN_PASS = process.env.E2E_SHELL_ADMIN_PASSWORD ?? "e2e-shell-admin-pass-2026";
const loginPromises = new Map<string, Promise<void>>();

async function loginOnce(browser: Browser, stateFile: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
    await page.getByLabel("用户名").fill(ADMIN_USER);
    await page.getByLabel("密码").fill(ADMIN_PASS);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(/\/app|\/admin/);
    await context.storageState({ path: stateFile });
  } finally {
    await context.close();
  }
}

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use, testInfo) => {
    test.skip(ADMIN_PASS === "", "需要 E2E_SHELL_ADMIN_PASSWORD");
    const project = testInfo.project.name;
    const stateFile = `tests/e2e/.auth/admin-overview-${project}.json`;
    if (!loginPromises.has(project)) loginPromises.set(project, loginOnce(browser, stateFile));
    await loginPromises.get(project);
    const context = await browser.newContext({ storageState: stateFile });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

test.describe("admin overview dashboard", () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    test(`${viewport.width}px renders the real overview without overflow`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${WEB}/app`);
      await expect(page.getByRole("heading", { name: "管理概览" })).toBeVisible();
      await expect(
        page.locator(".admin-overview__metric").filter({ hasText: "活跃用户" }),
      ).toBeVisible();
      await expect(page.getByText("更新于")).toBeVisible();
      await expect(page.getByText("管理端占位页。", { exact: true })).toHaveCount(0);
      await expect(page.locator(".app-logout")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
    });
  }

  test("refresh keeps the overview usable and publishing rows link to detail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/app`);
    await expect(page.getByRole("heading", { name: "管理概览" })).toBeVisible();
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(page.getByRole("button", { name: "刷新" })).toBeEnabled();

    const publishing = page
      .locator(".admin-overview__queue")
      .filter({ has: page.getByRole("heading", { name: "待发布课程" }) });
    const firstItem = publishing.locator(".admin-overview__list a").first();
    if (await firstItem.count()) {
      await expect(firstItem).toHaveAttribute("href", /\/admin\/courses\/[^/]+\/publishing/);
    }
  });

  test("keyboard can reach refresh and the account menu has one logout action", async ({
    page,
  }) => {
    await page.goto(`${WEB}/app`);
    await page.getByRole("button", { name: "刷新" }).focus();
    await expect(page.getByRole("button", { name: "刷新" })).toBeFocused();
    await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(1);
  });
});
