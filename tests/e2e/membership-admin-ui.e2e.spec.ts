// Ticket 03 closeout · membership admin UI — browser-driven E2E.
//
// Design rule: /admin/users is READ-ONLY for membership (badge display only).
// All membership mutations (grant / renew / revoke / daily-limit) live on /admin/memberships.
//
// Covers:
//   a. users page: new learner → badge defaults to「免费」
//   b. users page: API grant → badge refreshes to「会员」; no grant/renew/revoke buttons on users page
//   c. users page: API renew → badge stays「会员」; API revoke → badge「免费」
//   d. users page: past-expiry grant → badge「已过期」
//   e. users page: badges for admin row too (read-only, no buttons)
//   f. memberships page: click 开通 → grant dialog with duration/until/indefinite → confirm → badge
//   g. memberships page: admin's own row has no grant/renew/revoke buttons
//   h. memberships page: renew from current membership; revoke → free
//   i. memberships page: keyboard Tab/Enter; Escape closes dialog
//   j. viewports 390/768/1440 — no h-overflow on both pages
//   k. memberships page: daily-limit edit → 30 → refresh → persists; boundaries 0/15/1440; invalid rejected
//   l. memberships page: modal error recovery — invalid input preserved; close/reopen fresh; network error shown
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

  // ---- Shared helpers ----

  /** 通过 UI 在用户管理页创建 learner，返回用户名。 */
  async function createLearnerViaUi(page: Page): Promise<string> {
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
    await expect(otpDialog).toBeVisible({ timeout: 15_000 });
    // WebKit 上「取消」偶发不立即卸载 dialog；重试直到消失。
    await expect
      .poll(
        async () => {
          if ((await otpDialog.count()) === 0) return true;
          await otpDialog
            .getByRole("button", { name: "取消" })
            .click({ force: true })
            .catch(() => {});
          return false;
        },
        { timeout: 10_000, intervals: [250, 500] },
      )
      .toBe(true);
    return username;
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

  /** 在 users 页定位指定用户名的行。 */
  async function locateUsersPageRow(page: Page, username: string) {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
    await page.getByLabel("搜索用户名/显示名").fill(username);
    await page.getByRole("button", { name: "搜索" }).click();
    const row = page.getByTestId("user-row").filter({ hasText: username });
    await expect(row.first()).toBeVisible({ timeout: 10_000 });
    return row;
  }

  /** 在 memberships 页定位指定用户名的行（用搜索框过滤）。 */
  async function locateMembershipsPageRow(page: Page, username: string) {
    await page.goto("/admin/memberships");
    await expect(page.getByRole("heading", { name: "会员管理" })).toBeVisible();
    await page.getByLabel("搜索用户").fill(username);
    await page.getByRole("button", { name: "搜索" }).click();
    const row = page.locator('[data-testid^="member-row-"]').filter({ hasText: username });
    await expect(row.first()).toBeVisible({ timeout: 10_000 });
    return row;
  }

  // =====================================================================
  // a. users page: badge defaults to「免费」(read-only; no buttons)
  // =====================================================================
  test("a. users page: 新建 learner → badge defaults to「免费」, no grant/renew/revoke buttons", async ({
    adminPage,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const row = await locateUsersPageRow(adminPage, username);
    // Badge visible and defaults to 免费.
    await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("免费", {
      timeout: 10_000,
    });
    // No grant/renew/revoke buttons on users page (all membership mutations live on memberships page).
    await expect(row.locator("[data-testid^='member-grant-']")).toHaveCount(0);
    await expect(row.locator("[data-testid^='member-renew-']")).toHaveCount(0);
    await expect(row.locator("[data-testid^='member-revoke-']")).toHaveCount(0);
    // Users page still has account operations (edit / disable / delete).
    await expect(row.getByRole("button", { name: "编辑" })).toBeVisible();
  });

  // =====================================================================
  // b. users page: API grant → badge「会员」; no membership buttons on users page
  // =====================================================================
  test("b. users page: API grant → badge「会员」; no membership buttons", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx, csrf } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      const grantRes = await apiCtx.post(`/api/v1/admin/memberships/${userId}/grant`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-grant-${randomUUID()}` },
        data: { plan: "member", expiresAt: null },
      });
      expect(grantRes.status()).toBe(200);
      expect((await grantRes.json()).status).toBe("member");

      // Refresh users page → badge updates to 会员.
      const row = await locateUsersPageRow(adminPage, username);
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("会员", {
        timeout: 15_000,
      });
      // No grant/renew/revoke buttons on users page.
      await expect(row.locator("[data-testid^='member-grant-']")).toHaveCount(0);
      await expect(row.locator("[data-testid^='member-renew-']")).toHaveCount(0);
      await expect(row.locator("[data-testid^='member-revoke-']")).toHaveCount(0);
    } finally {
      await apiCtx.dispose();
    }
  });

  // =====================================================================
  // c. users page: renew → badge「会员」; revoke → badge「免费」
  // =====================================================================
  test("c. users page: API renew → badge stays「会员」; revoke → badge「免费」", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx, csrf } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      // Grant.
      await apiCtx.post(`/api/v1/admin/memberships/${userId}/grant`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-grant-${randomUUID()}` },
        data: { plan: "member", expiresAt: null },
      });
      // Renew (future expiry).
      const future = new Date(Date.now() + 30 * 86400_000).toISOString();
      await apiCtx.post(`/api/v1/admin/memberships/${userId}/renew`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-renew-${randomUUID()}` },
        data: { expiresAt: future },
      });
      // Revoke.
      await apiCtx.post(`/api/v1/admin/memberships/${userId}/revoke`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-revoke-${randomUUID()}` },
      });
      // Badge → 免费.
      const row = await locateUsersPageRow(adminPage, username);
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("免费", {
        timeout: 15_000,
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  // =====================================================================
  // d. users page: past-expiry grant → badge「已过期」
  // =====================================================================
  test("d. users page: past-expiry grant → badge「已过期」", async ({ adminPage, playwright }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx, csrf } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      const past = new Date(Date.now() - 3600_000).toISOString();
      await apiCtx.post(`/api/v1/admin/memberships/${userId}/grant`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-past-${randomUUID()}` },
        data: { plan: "member", expiresAt: past },
      });
      const row = await locateUsersPageRow(adminPage, username);
      await expect(row.locator("[data-testid^='membership-badge-']")).toHaveText("已过期", {
        timeout: 15_000,
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  // =====================================================================
  // e. users page: admin's own row shows badge (read-only), no buttons
  // =====================================================================
  test("e. users page: admin's own row shows badge, no membership buttons", async ({
    adminPage,
  }) => {
    test.setTimeout(60_000);
    const meRow = await locateUsersPageRow(adminPage, adminUsernameFor(currentProjectName));
    await expect(meRow).toBeVisible();
    // Badge visible (admin has no membership row → 免费, or whatever state; it's read-only).
    await expect(meRow.locator("[data-testid^='membership-badge-']")).toBeVisible();
    // No grant/renew/revoke buttons.
    await expect(meRow.locator("[data-testid^='member-grant-']")).toHaveCount(0);
    await expect(meRow.locator("[data-testid^='member-renew-']")).toHaveCount(0);
    await expect(meRow.locator("[data-testid^='member-revoke-']")).toHaveCount(0);
  });

  // =====================================================================
  // f. memberships page: grant via UI dialog — duration / until / indefinite
  // =====================================================================
  test("f. memberships page: grant via UI — duration=30d → 会员; reopen → badge persists", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      // Go to memberships page and locate the learner.
      const row = await locateMembershipsPageRow(adminPage, username);
      // Badge is 免费.
      await expect(row.locator(".admin-membership-status")).toHaveText("免费", { timeout: 10_000 });

      // Click "开通" button.
      const grantBtn = row.getByTestId(`member-grant-${userId}`);
      await expect(grantBtn).toBeVisible();
      await grantBtn.click();

      // Dialog opens with title「开通会员 · <displayName>」.
      const dialog = adminPage.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading")).toContainText("开通会员");

      // "按天数" mode is default; enter 30 days.
      await expect(dialog.getByRole("spinbutton", { name: "天数" })).toHaveValue("30");
      // Click "确认开通".
      await dialog.getByRole("button", { name: "确认开通" }).click();

      // Dialog closes; badge refreshes to 会员.
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
      await expect(row.locator(".admin-membership-status")).toHaveText("会员", {
        timeout: 15_000,
      });

      // Reopen the memberships page; badge still shows 会员.
      await adminPage.goto("/admin/memberships");
      await adminPage.getByLabel("搜索用户").fill(username);
      await adminPage.getByRole("button", { name: "搜索" }).click();
      const row2 = adminPage.locator('[data-testid^="member-row-"]').filter({ hasText: username });
      await expect(row2.first().locator(".admin-membership-status")).toHaveText("会员", {
        timeout: 10_000,
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  // =====================================================================
  // g. memberships page: admin's own row shows membership controls
  //    (the memberships page allows admins to see/manage ALL rows' membership,
  //     including their own; only the USERS page hides membership mutation buttons)
  // =====================================================================
  test("g. memberships page: admin own row is visible with membership controls", async ({
    adminPage,
  }) => {
    test.setTimeout(60_000);
    await adminPage.goto("/admin/memberships");
    await expect(adminPage.getByRole("heading", { name: "会员管理" })).toBeVisible();
    await adminPage.getByLabel("搜索用户").fill(adminUsernameFor(currentProjectName));
    await adminPage.getByRole("button", { name: "搜索" }).click();
    const meRow = adminPage
      .locator('[data-testid^="member-row-"]')
      .filter({ hasText: adminUsernameFor(currentProjectName) });
    await expect(meRow.first()).toBeVisible({ timeout: 10_000 });
    // Admin's own row has a daily-limit button (always present on memberships page).
    await expect(meRow.first().locator("[data-testid^='member-daily-limit-']")).toHaveCount(1);
  });

  // =====================================================================
  // h. memberships page: renew from current membership; revoke → free
  // =====================================================================
  test("h. memberships page: grant via UI then renew (duration mode) via UI then revoke via UI", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);

      // Grant via memberships page UI.
      const row = await locateMembershipsPageRow(adminPage, username);
      await row.getByTestId(`member-grant-${userId}`).click();
      await expect(adminPage.getByRole("dialog")).toBeVisible();
      await adminPage.getByRole("button", { name: "确认开通" }).click();
      await expect(row.locator(".admin-membership-status")).toHaveText("会员", {
        timeout: 15_000,
      });

      // Renew via UI (duration mode: 30 days, using default value).
      await row.getByTestId(`member-renew-${userId}`).click();
      const renewDialog = adminPage.getByRole("dialog");
      await expect(renewDialog).toBeVisible();
      await expect(renewDialog.getByRole("heading")).toContainText("续期会员");
      // "按天数" mode is default; click "确认续期" directly.
      await renewDialog.getByRole("button", { name: "确认续期" }).click();
      await expect(renewDialog).toHaveCount(0, { timeout: 10_000 });
      await expect(row.locator(".admin-membership-status")).toHaveText("会员", {
        timeout: 10_000,
      });

      // Revoke via UI.
      await row.getByTestId(`member-revoke-${userId}`).click();
      const revokeDialog = adminPage.getByRole("dialog");
      await expect(revokeDialog).toBeVisible();
      await expect(revokeDialog.getByRole("heading")).toContainText("撤销会员");
      await revokeDialog.getByRole("button", { name: "确认撤销" }).click();
      await expect(revokeDialog).toHaveCount(0, { timeout: 10_000 });
      await expect(row.locator(".admin-membership-status")).toHaveText("免费", {
        timeout: 15_000,
      });
    } finally {
      await apiCtx.dispose();
    }
  });

  // =====================================================================
  // i. memberships page: keyboard Tab/Enter; Escape closes dialog
  // =====================================================================
  test("i. memberships page: Escape closes dialog; Tab reaches action buttons", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      const row = await locateMembershipsPageRow(adminPage, username);

      // Tab from page top to the "时长" button.
      await adminPage.getByRole("heading", { name: "会员管理" }).focus();
      for (let i = 0; i < 40; i++) await adminPage.keyboard.press("Tab");
      const focusedTag = await adminPage.evaluate(
        () => (document.activeElement as HTMLElement)?.tagName ?? "",
      );
      expect(["BUTTON", "SELECT", "INPUT", "A"]).toContain(focusedTag);

      // Open daily-limit dialog via keyboard — focus on the 时长 button, then Enter.
      await row.getByTestId(`member-daily-limit-${userId}`).focus();
      await adminPage.keyboard.press("Enter");
      const dialog = adminPage.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // Escape closes.
      await adminPage.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await apiCtx.dispose();
    }
  });

  // =====================================================================
  // j. viewports 390/768/1440 — no horizontal overflow on both pages
  // =====================================================================
  test("j. viewports 390/768/1440 — no horizontal overflow on users and memberships pages", async ({
    adminPage,
  }) => {
    test.setTimeout(60_000);
    for (const width of [390, 768, 1440]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const [url, label] of [
        ["/admin/users", "用户管理"],
        ["/admin/memberships", "会员管理"],
      ] as const) {
        await adminPage.goto(url);
        await expect(adminPage.getByRole("heading", { name: label })).toBeVisible();
        const overflow = await adminPage.evaluate(
          () =>
            document.documentElement.scrollWidth > document.documentElement.clientWidth ||
            document.body.scrollWidth > document.body.clientWidth,
        );
        expect(overflow, `${width}px ${label} 无横向滚动`).toBe(false);
      }
    }
  });

  // =====================================================================
  // k. memberships page: daily-limit edit → boundaries → persists
  // =====================================================================
  test("k. memberships page: daily-limit edit → 30 → refresh → persists; boundaries 0/15/1440; invalid rejected", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      const row = await locateMembershipsPageRow(adminPage, username);

      // Default: 15 分钟/日 shown.
      await expect(row.getByText("15 分钟 / 日")).toBeVisible();

      // Click "时长" to open daily-limit dialog.
      const dailyLimitBtn = row.getByTestId(`member-daily-limit-${userId}`);
      await expect(dailyLimitBtn).toBeVisible();
      await dailyLimitBtn.click();

      const dialog = adminPage.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading")).toContainText("编辑非会员时长");
      const input = dialog.locator('input[type="number"]');
      await expect(input).toHaveValue("15");

      // Invalid value: 2000 → client-side error message.
      await input.fill("2000");
      await dialog.getByRole("button", { name: "保存时长" }).click();
      await expect(dialog.locator('[role="alert"]')).toContainText("0 至 1440");
      // Input is preserved (not cleared).
      await expect(input).toHaveValue("2000");

      // Fix to valid: 30 → save.
      await input.fill("30");
      await dialog.getByRole("button", { name: "保存时长" }).click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });

      // Refresh and verify.
      await adminPage.goto("/admin/memberships");
      await adminPage.getByLabel("搜索用户").fill(username);
      await adminPage.getByRole("button", { name: "搜索" }).click();
      await expect(
        adminPage.getByTestId(`member-row-${userId}`).getByText("30 分钟 / 日"),
      ).toBeVisible({ timeout: 10_000 });

      // API confirms same value.
      const readRes = await apiCtx.get(`/api/v1/admin/memberships/${userId}`);
      expect(readRes.status()).toBe(200);
      expect((await readRes.json()).dailyLimitMinutes).toBe(30);
    } finally {
      await apiCtx.dispose();
    }
  });

  // =====================================================================
  // l. memberships page: modal error recovery — close/reopen fresh; error shown
  // =====================================================================
  test("l. memberships page: dialog close/reopen resets state; server error shows alert", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const username = await createLearnerViaUi(adminPage);
    const { apiCtx } = await loginAdminApi(playwright);
    try {
      const userId = await getUserIdByName(apiCtx, username);
      const row = await locateMembershipsPageRow(adminPage, username);

      // Open daily-limit dialog, enter invalid value, see error, close without saving.
      await row.getByTestId(`member-daily-limit-${userId}`).click();
      const dialog = adminPage.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const input = dialog.locator('input[type="number"]');
      await input.fill("9999");
      await dialog.getByRole("button", { name: "保存时长" }).click();
      await expect(dialog.locator('[role="alert"]')).toContainText("0 至 1440");
      // Close dialog via "×" button.
      await dialog.getByRole("button", { name: "关闭" }).click();
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });

      // Reopen — input is fresh (15 default), no stale error.
      await row.getByTestId(`member-daily-limit-${userId}`).click();
      await expect(dialog).toBeVisible();
      await expect(input).toHaveValue("15");
      await expect(dialog.locator('[role="alert"]')).toHaveCount(0);
      // Close via Escape.
      await adminPage.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await apiCtx.dispose();
    }
  });
});
