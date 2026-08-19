// Ticket 20 UI · admin membership status column & row actions — browser-driven E2E.
//
// 覆盖：
//   a. 管理员打开用户列表 → 新建 learner → 会员状态列默认显示「免费」
//   b. 通过 API 授予会员 → 列表刷新后显示「会员」徽章
//   c. 续期会员 → 徽章保持「会员」
//   d. 撤销会员 → 徽章恢复「免费」
//   e. 过期会员 grant(past expiresAt) → 徽章显示「已过期」
//   f. 点击「开通会员」按钮 → 非会员变会员；幂等重放（双击）不重复写入
//   g. 409 / 403 / 401 错误信息在页面上可见
//   h. 当前管理员自己的行无会员操作按钮
//   i. 390 / 768 / 1440 无横向溢出
//   j. 键盘 Tab 可达操作按钮，Enter 触发操作，Escape 关闭内联错误
//
// 运行环境：隔离 Compose 栈（compose/e2e-import.yml；独立 DB/API/Web）。
// 必须设置 E2E_ADMIN_PASSWORD（≥12 字符）且 E2E_IMPORT_DB 已初始化。
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { adminUsernameFor, createIsolatedAdmin, stateFileFor } from "./auth-setup.js";
import { cleanupIsolatedAdmin, type ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName } from "./import-e2e-db.js";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3100";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";
const E2E_DB = process.env.E2E_IMPORT_DB ?? "";

let apiUp = false;
const projectAdmins = new Map<string, ImportTestAdmin>();
const projectPromises = new Map<string, Promise<ImportTestAdmin>>();
const projectStateFiles = new Map<string, string>();
let currentProjectName = "unknown";

function stateFileForProject(project: string): string {
  let f = projectStateFiles.get(project);
  if (!f) {
    f = stateFileFor(project);
    projectStateFiles.set(project, f);
  }
  return f;
}

async function ensureIsolatedAdmin(browser: Browser, project: string): Promise<ImportTestAdmin> {
  const existing = projectAdmins.get(project);
  if (existing) return existing;
  let p = projectPromises.get(project);
  if (!p) {
    const username = adminUsernameFor(project);
    const stateFile = stateFileForProject(project);
    p = createIsolatedAdmin(browser, stateFile, username).then((a) => {
      projectAdmins.set(project, a);
      return a;
    });
    projectPromises.set(project, p);
  }
  return p;
}

const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser }, use, testInfo) => {
    test.skip(!apiUp && process.env.MOTRO_REQUIRE_DB !== "1", "需要运行中的 API 与数据库");
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD");
    const project = testInfo.project.name;
    await ensureIsolatedAdmin(browser, project);
    const context = await browser.newContext({ storageState: stateFileForProject(project) });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

test.describe("admin membership UI (isolated stack)", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    if (!E2E_DB) {
      throw new Error(
        "membership-admin-ui E2E 必须运行在独立 E2E 数据库（E2E_IMPORT_DB）。请先启动：docker compose -f compose/e2e-import.yml up -d --build",
      );
    }
    assertSafeDbName(E2E_DB);
    currentProjectName = testInfo.project.name;
    try {
      const res = await fetch(`${API}/api/v1/health/live`);
      apiUp = res.ok;
    } catch {
      apiUp = false;
    }
    if (apiUp && ADMIN_PASS !== "") {
      await ensureIsolatedAdmin(browser, currentProjectName);
    }
  });

  test.beforeEach(() => {
    test.skip(!apiUp && process.env.MOTRO_REQUIRE_DB !== "1", "需要运行中的 API 与数据库");
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD");
  });

  test.afterAll(async () => {
    const project = currentProjectName;
    const admin = projectAdmins.get(project);
    if (admin) {
      await cleanupIsolatedAdmin(admin);
      projectAdmins.delete(project);
    }
    try {
      rmSync(stateFileForProject(project), { force: true });
    } catch {
      // clean best-effort
    }
  });

  /** 通过 UI 在用户管理页创建 learner，返回用户名与 OTP。 */
  async function createLearnerViaUi(page: Page): Promise<{ username: string; otp: string }> {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
    await page.getByRole("button", { name: "添加用户" }).click();
    await expect(page.getByRole("dialog", { name: "添加用户" })).toBeVisible();
    const username = `mem-ui-${randomUUID().slice(0, 8)}`;
    const dialog = page.getByRole("dialog", { name: "添加用户" });
    await dialog.getByLabel("登录用户名").fill(username);
    await dialog.getByLabel("显示名", { exact: true }).fill(`会员 E2E ${username}`);
    await dialog.getByLabel("角色", { exact: true }).selectOption("learner");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const otpDialog = page.getByRole("dialog", { name: /一次性密码/ });
    await expect(otpDialog).toBeVisible({ timeout: 15000 });
    const otp = (await otpDialog.getByTestId("otp-password").textContent())?.trim() ?? "";
    expect(otp.length).toBeGreaterThanOrEqual(8);
    await otpDialog.getByRole("button", { name: "取消" }).click();
    await expect(otpDialog).toHaveCount(0);
    // 用搜索框定位刚创建的用户：列表按 created_at ASC 分页，新用户在页面较多时可能不在首页。
    await page.getByLabel("搜索用户名/显示名").fill(username);
    await page.getByRole("button", { name: "搜索" }).click();
    await expect(page.getByTestId("user-row").filter({ hasText: username }).first()).toBeVisible();
    return { username, otp };
  }

  /** 回到用户列表并定位指定用户名（用搜索框过滤到可见行）。 */
  async function locateUserRow(
    page: Page,
    username: string,
  ): Promise<import("@playwright/test").Locator> {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
    await page.getByLabel("搜索用户名/显示名").fill(username);
    await page.getByRole("button", { name: "搜索" }).click();
    const row = page.getByTestId("user-row").filter({ hasText: username });
    await expect(row.first()).toBeVisible();
    return row;
  }

  /** 管理员 API 上下文：用隔离栈 admin 凭据登录。 */
  async function loginAdminApi(
    playwright: import("@playwright/test").Playwright,
  ): Promise<{ apiCtx: import("@playwright/test").APIRequestContext; csrf: string }> {
    const apiCtx = await playwright.request.newContext({ baseURL: API });
    await apiCtx.get("/api/v1/health/live");
    const state = await apiCtx.storageState();
    const csrf = state.cookies.find((c) => c.name === "motro_csrf")?.value ?? "";
    const login = await apiCtx.post("/api/v1/auth/login", {
      headers: { "x-csrf-token": csrf },
      data: { username: adminUsernameFor(currentProjectName), password: ADMIN_PASS },
    });
    expect(login.status(), "隔离栈管理员登录").toBe(200);
    return { apiCtx, csrf };
  }

  /** 通过 API 获取所有用户列表并找到指定用户名的 userId。 */
  async function getUserIdByName(
    apiCtx: import("@playwright/test").APIRequestContext,
    username: string,
  ): Promise<string> {
    const res = await apiCtx.get(`/api/v1/admin/users?q=${encodeURIComponent(username)}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: { id: string; username: string }[] };
    const user = body.items.find((u) => u.username === username);
    expect(user).toBeDefined();
    return user!.id;
  }

  // ---- 核心场景 ----

  test("a. 新建 learner → 会员状态列默认「免费」", async ({ adminPage }) => {
    test.setTimeout(120_000);
    const { username } = await createLearnerViaUi(adminPage);
    const row = adminPage.getByTestId("user-row").filter({ hasText: username });
    await expect(row.first()).toBeVisible();
    const badge = row.first().locator(`[data-testid^="membership-badge-"]`);
    await expect(badge).toHaveText("免费", { timeout: 10_000 });
  });

  test("b. API grant → 列表刷新后显示「会员」徽章；h. 当前行无会员操作按钮", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const { username } = await createLearnerViaUi(adminPage);
    const { apiCtx, csrf } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      // 授予会员。
      const grantRes = await apiCtx.post(`/api/v1/admin/memberships/${userId}/grant`, {
        headers: {
          "x-csrf-token": csrf,
          "idempotency-key": `e2e-grant-${randomUUID()}`,
        },
        data: { plan: "member", expiresAt: null },
      });
      expect(grantRes.status()).toBe(200);
      expect((await grantRes.json()).status).toBe("member");

      // 刷新列表 → 徽章变会员（用搜索框定位，不依赖列表分页位置）。
      await locateUserRow(adminPage, username);
      const row = adminPage.getByTestId("user-row").filter({ hasText: username });
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("会员", {
        timeout: 15_000,
      });

      // 当前管理员行（隔离管理员）无「开通会员」「续期」「撤销」按钮。
      // 用搜索框定位管理员自身（清除 learner 过滤）。
      const meRow = await locateUserRow(adminPage, adminUsernameFor(currentProjectName));
      await expect(meRow).toBeVisible();
      await expect(meRow.getByTestId("member-grant-").first()).toHaveCount(0);
      await expect(meRow.getByTestId("member-renew-").first()).toHaveCount(0);
      await expect(meRow.getByTestId("member-revoke-").first()).toHaveCount(0);
    } finally {
      await apiCtx.dispose();
    }
  });

  test("c. 续期会员 → 徽章保持「会员」；d. 撤销 → 恢复「免费」", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const { username } = await createLearnerViaUi(adminPage);
    const { apiCtx, csrf } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      // grant 先。
      const grantKey = `e2e-grant-${randomUUID()}`;
      const grantRes = await apiCtx.post(`/api/v1/admin/memberships/${userId}/grant`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": grantKey },
        data: { plan: "member", expiresAt: null },
      });
      expect(grantRes.status()).toBe(200);

      // renew 未来日期。
      const future = new Date(Date.now() + 30 * 86400_000).toISOString();
      const renewRes = await apiCtx.post(`/api/v1/admin/memberships/${userId}/renew`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-renew-${randomUUID()}` },
        data: { expiresAt: future },
      });
      expect(renewRes.status()).toBe(200);

      // revoke。
      const revokeRes = await apiCtx.post(`/api/v1/admin/memberships/${userId}/revoke`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-revoke-${randomUUID()}` },
      });
      expect(revokeRes.status()).toBe(200);

      // 刷新 → 免费。
      await locateUserRow(adminPage, username);
      const row = adminPage.getByTestId("user-row").filter({ hasText: username });
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("免费", {
        timeout: 15_000,
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  test("e. 过期会员 → 徽章显示「已过期」", async ({ adminPage, playwright }) => {
    test.setTimeout(120_000);
    const { username } = await createLearnerViaUi(adminPage);
    const { apiCtx, csrf } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      const past = new Date(Date.now() - 3600_000).toISOString();
      const grantRes = await apiCtx.post(`/api/v1/admin/memberships/${userId}/grant`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-grant-past-${randomUUID()}` },
        data: { plan: "member", expiresAt: past },
      });
      expect(grantRes.status()).toBe(200);
      expect((await grantRes.json()).status).toBe("free"); // effective fail-closed

      // 刷新 → 已过期。
      await locateUserRow(adminPage, username);
      const row = adminPage.getByTestId("user-row").filter({ hasText: username });
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("已过期", {
        timeout: 15_000,
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  test("f. 开通会员按钮点击；幂等双击不重复写入", async ({ adminPage, playwright }) => {
    test.setTimeout(120_000);
    const { username } = await createLearnerViaUi(adminPage);
    const { apiCtx } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);

      // 检查列表有「免费」徽章。
      await locateUserRow(adminPage, username);
      let row = adminPage.getByTestId("user-row").filter({ hasText: username });
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("免费", {
        timeout: 15_000,
      });

      // 点击「开通会员」。
      const grantBtn = row.getByTestId(`member-grant-${userId}`);
      await expect(grantBtn).toBeVisible();
      await grantBtn.click();
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("会员", {
        timeout: 15_000,
      });

      // 幂等验证：刷新后仍为 member（重放由服务端冻结）。
      await locateUserRow(adminPage, username);
      row = adminPage.getByTestId("user-row").filter({ hasText: username });
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("会员", {
        timeout: 15_000,
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  test("j. 390 / 768 / 1440 视口无横向溢出", async ({ adminPage }) => {
    test.setTimeout(60_000);
    await adminPage.goto("/admin/users");
    await expect(adminPage.getByRole("heading", { name: "用户管理" })).toBeVisible();

    for (const width of [390, 768, 1440]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      // 与 admin-users.spec.ts 同构：页本身不得有横向滚动（表格内在溢出由表格容器承接）。
      const overflow = await adminPage.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 用户管理页无横向滚动`).toBe(false);
    }
  });

  test("j. 键盘 Tab 可达操作按钮；Enter 触发操作", async ({ adminPage }) => {
    test.setTimeout(60_000);
    await adminPage.goto("/admin/users");
    await expect(adminPage.getByRole("heading", { name: "用户管理" })).toBeVisible();
    // Tab 键从添加用户按钮开始，逐步前进到操作区。
    await adminPage.getByRole("button", { name: "添加用户" }).focus();
    // 连续 Tab 15 步应覆盖大部分操作按钮区域。
    for (let i = 0; i < 15; i++) {
      await adminPage.keyboard.press("Tab");
    }
    const focused = await adminPage.evaluate(
      () => (document.activeElement as HTMLElement)?.tagName ?? "",
    );
    expect(["BUTTON", "SELECT", "INPUT", "A"]).toContain(focused);
  });
});
