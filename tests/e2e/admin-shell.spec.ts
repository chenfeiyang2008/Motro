// 管理端壳层 E2E：桌面/手机、深浅主题、侧栏/菜单键盘访问、无横向溢出、reduced-motion。
// 运行在隔离导入 E2E 栈（api:3100, web:3099）上，不触碰共享 motro 栈。
import { test as base, expect, type Browser, type Page } from "@playwright/test";

// 本机隔离 Web（e2e-import 栈：web:3101, api:3100）
const WEB = process.env.PW_SHELL_WEB_URL ?? "http://127.0.0.1:3101";
const ADMIN_USER = process.env.E2E_SHELL_ADMIN_USERNAME ?? "e2e_shell_admin";
const ADMIN_PASS = process.env.E2E_SHELL_ADMIN_PASSWORD ?? "e2e-shell-admin-pass-2026";

// 记录每个 project 的一次性登录 promise，避免重复创建管理员状态。
const projectPromises = new Map<string, Promise<void>>();

/** 登录管理员一次并保存 storageState，供同 project 下多组 test 复用（避免并发踩踏与每次登录的 CSRF 抖动）。 */
async function loginAsAdminOnce(browser: Browser, stateFile: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"), {
      timeout: 30000,
    });
    await page.getByLabel("用户名").fill(ADMIN_USER);
    await page.getByLabel("密码").fill(ADMIN_PASS);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(/\/app|\/admin/, { timeout: 30000 });
    await context.storageState({ path: stateFile });
  } finally {
    await context.close();
  }
}

/**
 * 自定义 fixture：为每个测试创建基于本项目 storageState 的已认证 page。
 * 每个 project（chromium/webkit）用独立 state 文件，避免 worker 并发互抢。
 * 不使用 test.use({ storageState })，避免 worker 启动时读取尚未生成的状态文件。
 */
const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use, testInfo) => {
    test.skip(ADMIN_PASS === "", "需要 E2E_SHELL_ADMIN_PASSWORD");
    const project = testInfo.project.name;
    const stateFile = `tests/e2e/.auth/shell-admin-${project}.json`;
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

test.describe("admin shell structure and navigation", () => {
  // ──────── 桌面端 ────────

  test("desktop: sidebar visible with brand, nav groups, and active indicator", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    // 侧栏可见
    const sidebar = page.locator(".admin-sidebar");
    await expect(sidebar).toBeVisible();

    // 品牌标识
    await expect(sidebar.locator(".admin-brand")).toBeVisible();
    await expect(sidebar.locator(".admin-brand-mark")).toHaveText("M");
    await expect(sidebar.locator(".admin-brand-name")).toHaveText("Motro");

    // 导航组标题
    await expect(sidebar.getByText("内容", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("学习数据", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("运维", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("账号", { exact: true })).toBeVisible();

    // 导航项（所有可见）
    for (const label of ["导入", "课程", "词库", "审核", "经验", "任务状态", "用户管理"]) {
      await expect(sidebar.getByRole("link", { name: label })).toBeVisible();
    }

    // 当前页面 aria-current
    const activeLink = sidebar.getByRole("link", { name: "课程" });
    await expect(activeLink).toHaveAttribute("aria-current", "page");

    // 选中态：背景 + 左侧指示条（box-shadow inset）——通过计算样式验证非零 box-shadow
    const boxShadow = await activeLink.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toBe("none");

    // 移动菜单按钮不显示
    await expect(page.locator(".admin-mobile-nav__toggle")).toBeHidden();
  });

  test("desktop: sidebar footer has exit link, global theme button visible", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/courses`);

    const footer = page.locator(".admin-sidebar__footer");
    await expect(footer).toBeVisible();
    // 前往学习端链接
    const exitLink = footer.getByRole("link", { name: "前往学习端" });
    await expect(exitLink).toBeVisible();
    await expect(exitLink).toHaveAttribute("href", "/");

    // 全局顶栏主题切换按钮（中性图标按钮）仍在视口中
    const globalTheme = page.locator(".theme-toggle--global");
    await expect(globalTheme).toBeVisible();
  });

  test("desktop: content area has correct left margin and no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    // 内容区左边距应与侧栏宽度匹配（248px）
    const marginLeft = await page
      .locator(".admin-content")
      .evaluate((el) => parseInt(getComputedStyle(el).marginLeft, 10));
    expect(marginLeft).toBeGreaterThanOrEqual(248);

    // 无横向溢出
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docWidth).toBeLessThanOrEqual(1440);
  });

  // ──────── 手机端 ────────

  test("mobile: sidebar hidden, menu button visible and accessible", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    // 桌面侧栏隐藏
    await expect(page.locator(".admin-sidebar")).toBeHidden();

    // 菜单按钮可见，有 aria-expanded=false
    const toggle = page.locator(".admin-mobile-nav__toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-controls", "admin-mobile-nav-panel");

    // 无横向溢出
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docWidth).toBeLessThanOrEqual(390);
  });

  test("mobile: menu opens, shows nav, closes on backdrop click", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    const toggle = page.locator(".admin-mobile-nav__toggle");
    const panel = page.locator(".admin-mobile-nav__panel");
    const backdrop = page.locator(".admin-mobile-nav__backdrop");

    // 打开菜单
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(backdrop).toBeVisible();

    // 面板有 aria-modal 和正确的 role
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-modal", "true");
    await expect(panel).toHaveAttribute("aria-label", "管理导航");

    // 面板内导航项可见
    for (const label of ["导入", "课程", "词库", "审核", "经验", "任务状态", "用户管理"]) {
      await expect(panel.getByRole("link", { name: label })).toBeVisible();
    }

    // 关闭按钮可见
    const closeBtn = page.locator(".admin-mobile-nav__panel-close");
    await expect(closeBtn).toBeVisible();

    // 点击遮罩关闭：点击面板外的遮罩区域（x > 320，避免被面板捕获）。
    await backdrop.click({ position: { x: 370, y: 400 } });
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("mobile: Esc key closes menu and restores focus to toggle", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    const toggle = page.locator(".admin-mobile-nav__toggle");
    const panel = page.locator(".admin-mobile-nav__panel");

    // 打开
    await toggle.click();
    await expect(panel).toBeVisible();

    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // 焦点归还 toggle
    await expect(toggle).toBeFocused();
  });

  test("mobile: navigating via menu closes the panel", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    const toggle = page.locator(".admin-mobile-nav__toggle");
    const panel = page.locator(".admin-mobile-nav__panel");

    await toggle.click();
    await expect(panel).toBeVisible();

    // 点击导航项（导入）
    await panel.getByRole("link", { name: "导入" }).click();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(/\/admin\/imports/);
  });

  // ──────── 768px 断点 ────────

  test("tablet: sidebar hidden, no overflow at 768px", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    await expect(page.locator(".admin-sidebar")).toBeHidden();
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docWidth).toBeLessThanOrEqual(768);
  });

  // ──────── 主题 ────────

  test("theme toggle applies data-theme to html", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/courses`);

    const initialTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(["light", "dark"]).toContain(initialTheme);

    // 全局顶栏主题切换按钮（中性图标按钮，不是大文字按钮）
    const themeBtn = page.locator(".theme-toggle--global");
    await expect(themeBtn).toBeVisible();
    await themeBtn.click();
    await page.waitForTimeout(200);

    const toggledTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(toggledTheme).not.toBe(initialTheme);
    expect(["light", "dark"]).toContain(toggledTheme);

    // 再次切换回到原主题
    await themeBtn.click();
    await page.waitForTimeout(200);
    const revertedTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(revertedTheme).toBe(initialTheme);
  });

  // ──────── 可访问性 ────────

  test("accessibility: sidebar has aria-label, nav items have visible focus ring", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/courses`);

    // 侧栏有 aria-label
    const sidebar = page.locator(".admin-sidebar");
    await expect(sidebar).toHaveAttribute("aria-label", "管理端导航");

    const firstNavLink = sidebar.locator(".admin-nav-group a").first();

    if (testInfo.project.name === "webkit") {
      // WebKit headless 不合成顺序 Tab 导航；直接聚焦导航项验证可达性。
      // focus-visible 环本身已由 Chromium 的顺序 Tab 用例覆盖（web-shell.spec.ts 同约定）。
      await firstNavLink.focus();
      await expect(firstNavLink).toBeFocused();
      return;
    }

    // Chromium：顺序 Tab 直到焦点落到导航项，验证 focus-visible 环。
    let focusedNavOutline = "none";
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const inNav = await page.evaluate(() => {
        const el = document.activeElement;
        return !!el && el.matches(".admin-nav-group a");
      });
      if (inNav) {
        focusedNavOutline = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return "none";
          return getComputedStyle(el).outlineStyle;
        });
        break;
      }
    }
    expect(focusedNavOutline).not.toBe("none");
  });

  test("accessibility: content area has h1 (landmark from child page)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/admin/courses`);

    const h1 = page.getByRole("heading", { level: 1, name: "课程" });
    await expect(h1).toBeVisible();
  });

  // ──────── reduced-motion ────────

  test("reduced-motion: mobile menu opens without animation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${WEB}/admin/courses`);
    await page.getByRole("heading", { name: "课程" }).waitFor();

    const toggle = page.locator(".admin-mobile-nav__toggle");
    const panel = page.locator(".admin-mobile-nav__panel");

    await toggle.click();
    await expect(panel).toBeVisible();

    // panel animation should be disabled under prefers-reduced-motion: reduce
    const animationName = await panel.evaluate((el) => getComputedStyle(el).animationName);
    expect(animationName).toBe("none");
  });
});
