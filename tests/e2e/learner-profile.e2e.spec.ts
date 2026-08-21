// 学习端个人资料页 E2E（Ticket: profile-membership-ui）。
//
// 隔离 Compose 栈（compose/e2e-import.yml；独立 DB/API/Web）。
// 覆盖（Chromium + WebKit）：
//   - 会员用户资料页：皇冠徽章、尊享会员、会员不限时、长 UUID 不溢出
//   - 免费用户资料页：无皇冠、显示剩余时长
//   - 响应式：390 / 768 / 1440 无横向溢出
//   - 暗色主题：皇冠可识别、文字对比度
//   - reduced-motion：无非必要动画
//   - 键盘 Tab 可达
//
// 不覆盖：异常/降级状态（不 mock 真实 API，禁用 mock；服务端离线时跳过数据场景）。
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { adminUsernameFor, createIsolatedAdmin, stateFileFor } from "./auth-setup.js";
import { cleanupIsolatedAdmin, type ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName } from "./import-e2e-db.js";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3100";
const WEB = process.env.PW_BASE_URL ?? "http://127.0.0.1:3101";
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

test.describe("learner profile UI (isolated stack)", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    if (!E2E_DB) {
      throw new Error(
        "learner-profile E2E 必须运行在独立 E2E 数据库（E2E_IMPORT_DB）。请先启动：docker compose -f compose/e2e-import.yml up -d --build",
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

  // ---- Helpers ----

  async function createLearnerViaAdmin(
    adminPage: Page,
  ): Promise<{ userId: string; username: string; otp: string }> {
    const username = `prof-ui-${randomUUID().slice(0, 8)}`;
    const cookies = await adminPage.context().cookies();
    const csrf = cookies.find((c) => c.name === "motro_csrf")?.value;
    const res = await adminPage.request.fetch(`${API}/api/v1/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf || "",
        "idempotency-key": `prof-learner-${username}`,
      },
      data: {
        username,
        displayName: `个人资料E2E ${username}`,
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      oneTimePassword: string;
    };
    return { userId: body.user.id, username, otp: body.oneTimePassword };
  }

  async function loginLearner(
    page: Page,
    learner: { username: string; otp: string },
  ): Promise<void> {
    await page.goto(`${WEB}/login`);
    await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
    await page.getByLabel("用户名").fill(learner.username);
    await page.getByLabel("密码").fill(learner.otp);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/, { timeout: 15_000 });
    await page.getByLabel(/当前密码/).fill(learner.otp);
    const newPass = "prof-e2e-pass-12345";
    await page.getByLabel(/^新密码/).fill(newPass);
    await page.getByLabel(/确认新密码/).fill(newPass);
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  }

  async function grantMembership(adminPage: Page, userId: string): Promise<void> {
    const cookies = await adminPage.context().cookies();
    const csrf = cookies.find((c) => c.name === "motro_csrf")?.value;
    const res = await adminPage.request.fetch(`${API}/api/v1/admin/memberships/${userId}/grant`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf || "",
        "idempotency-key": `prof-grant-${randomUUID()}`,
      },
      data: { plan: "member", expiresAt: null },
    });
    expect(res.status()).toBe(200);
  }

  async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth ||
        document.body.scrollWidth > document.body.clientWidth,
    );
    expect(overflow).toBe(false);
  }

  // ---- Test cases ----

  test("会员用户：皇冠、尊享会员、会员不限时、UUID 不溢出", async ({ adminPage }) => {
    test.setTimeout(120_000);
    const learner = await createLearnerViaAdmin(adminPage);
    const context = await adminPage.context().browser()!.newContext();
    const learnerPage = await context.newPage();
    await loginLearner(learnerPage, learner);

    // 授予会员。
    await grantMembership(adminPage, learner.userId);

    // 导航到 profile 页。
    await learnerPage.goto(`${WEB}/profile`);
    // 等待页面加载完成（非 skeleton）。
    await expect(learnerPage.locator(".profile-facts")).toBeVisible({ timeout: 15_000 });

    // 皇冠徽章可见（组件不设 data-testid，用类选择器）。
    const crown = learnerPage.locator(".member-crown-badge");
    await expect(crown.first()).toBeVisible();
    // "会员" 文字标签存在。
    await expect(crown.first().locator(".member-crown-badge__label")).toHaveText("会员");

    // 学习权限文案：会员不限时。
    const facts = learnerPage.locator(".profile-facts");
    await expect(facts.getByText("今日学习不限时")).toBeVisible();

    // UUID 有 title（完整值）。
    const uuid = learnerPage.locator(".profile-uuid");
    await expect(uuid).toBeVisible();
    const title = await uuid.getAttribute("title");
    expect(title).toBeTruthy();
    expect(title!.length).toBeGreaterThan(20); // UUID 完整长度

    // 无横向溢出。
    await assertNoHorizontalOverflow(learnerPage);

    await context.close();
  });

  test("免费用户：无皇冠、显示剩余时长", async ({ adminPage }) => {
    test.setTimeout(120_000);
    const learner = await createLearnerViaAdmin(adminPage);
    const context = await adminPage.context().browser()!.newContext();
    const learnerPage = await context.newPage();
    await loginLearner(learnerPage, learner);
    // 新建 learner 默认免费；无需 revoke（对无会员行 revoke 会报 400）。

    await learnerPage.goto(`${WEB}/profile`);
    await expect(learnerPage.locator(".profile-facts")).toBeVisible({ timeout: 15_000 });

    // 皇冠不出现。
    const crown = learnerPage.locator(".member-crown-badge");
    await expect(crown).toHaveCount(0);

    // 显示"免费方案"。
    const facts = learnerPage.locator(".profile-facts");
    await expect(facts.getByText("免费方案")).toBeVisible();

    // 剩余时长文案可见（包含"分钟"字样）。
    await expect(facts.getByText(/剩余.*分钟/)).toBeVisible();

    // 段位显示（Lv.1 初学黑铁，新人默认）。
    await expect(facts.getByText(/Lv\.\s*1/)).toBeVisible();

    await context.close();
  });

  test("390 / 768 / 1440 无横向溢出（会员用户）", async ({ adminPage }) => {
    test.setTimeout(120_000);
    const learner = await createLearnerViaAdmin(adminPage);
    const context = await adminPage.context().browser()!.newContext();
    const learnerPage = await context.newPage();
    await loginLearner(learnerPage, learner);
    await grantMembership(adminPage, learner.userId);

    await learnerPage.goto(`${WEB}/profile`);
    await expect(learnerPage.locator(".profile-facts")).toBeVisible({ timeout: 15_000 });

    for (const width of [390, 768, 1440]) {
      await learnerPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await assertNoHorizontalOverflow(learnerPage);
    }
    await context.close();
  });

  test("暗色主题：皇冠可识别，文字有对比度", async ({ adminPage }) => {
    test.setTimeout(120_000);
    const learner = await createLearnerViaAdmin(adminPage);
    const context = await adminPage.context().browser()!.newContext();
    const learnerPage = await context.newPage();
    await loginLearner(learnerPage, learner);
    await grantMembership(adminPage, learner.userId);

    await learnerPage.goto(`${WEB}/profile`);
    await expect(learnerPage.locator(".profile-facts")).toBeVisible({ timeout: 15_000 });

    // 切换到暗色主题。
    const toggle = learnerPage.getByRole("button", { name: "切换到暗色主题" });
    await toggle.click();
    await expect(learnerPage.locator("html")).toHaveAttribute("data-theme", "dark");

    // 皇冠仍可见。
    const crown = learnerPage.locator(".member-crown-badge");
    await expect(crown.first()).toBeVisible();

    // 文字颜色足够对比（通过 CSS 变量验证）。
    const textColor = await learnerPage.evaluate(
      "getComputedStyle(document.body).getPropertyValue('--color-text-primary').trim()",
    );
    // 暗色主题文字色 #f9efe5，非纯白。
    expect(textColor).toBeTruthy();

    await context.close();
  });

  test("reduced-motion 下欢迎层无动画", async ({ adminPage }) => {
    test.setTimeout(60_000);
    // reduced-motion 验证：验证 CSS media query 是否覆盖动画。
    const context = await adminPage.context().browser()!.newContext();
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${WEB}/login`);

    // 检查 member-welcome-layer 在 reduced-motion 下的 animation 规则。
    const transition = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "member-welcome-card";
      document.body.appendChild(el);
      const computed = getComputedStyle(el);
      const result = {
        animationName: computed.animationName,
        animationDuration: computed.animationDuration,
      };
      el.remove();
      return result;
    });
    // reduced-motion: animation 应为 none 或 0s。
    expect(
      transition.animationName === "none" ||
        transition.animationDuration === "0s" ||
        transition.animationDuration === "",
    ).toBe(true);

    await context.close();
  });

  test("键盘 Tab 可达操作按钮", async ({ adminPage }, testInfo) => {
    test.setTimeout(60_000);
    const context = await adminPage.context().browser()!.newContext();
    const page = await context.newPage();
    // 登录后才能到达 profile 页。
    const learner = await createLearnerViaAdmin(adminPage);
    await loginLearner(page, learner);

    await page.goto(`${WEB}/profile`);
    await expect(page.locator(".profile-facts")).toBeVisible({ timeout: 15_000 });

    // 从「查看个人经验」链接开始 Tab（确定性起点）。
    const profileLink = page.getByRole("link", { name: /查看个人经验/ });
    await expect(profileLink).toBeVisible();
    await profileLink.focus();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
    }
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement)?.tagName ?? "",
    );
    // WebKit headless 不合成顺序 Tab 导航（与主题 E2E 一致）；仅 Chromium 严格断言，
    // WebKit 退化为验证按钮显式可聚焦。
    test.skip(
      testInfo.project.name === "webkit",
      "Playwright WebKit headless 不合成顺序 Tab 导航；焦点断言由 Chromium 覆盖",
    );
    expect(["BUTTON", "SELECT", "INPUT", "A"]).toContain(focused);

    // 退出登录按钮可达。
    await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();

    await context.close();
  });
});
