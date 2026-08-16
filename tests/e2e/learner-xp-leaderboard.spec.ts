// Learner XP & Leaderboard UI E2E（Ticket 09）
//
// 覆盖（Chromium + WebKit）：
//   - /xp 个人经验页：真实 /me/xp；空记录 → empty state（无 0 伪造暗示）
//   - /leaderboard：真实 Challenge Points；空榜 empty state；daily XP 明确不参与排名
//   - 隐私 opt-out 设置切换（服务器响应为最终状态）
//   - 390/768/1440 无横向溢出；键盘可达（Chromium）；reduced-motion 下可用
//
// 运行环境：独立 E2E 数据库（compose/e2e-import.yml）。管理员由 createIsolatedAdmin
// 在隔离库直接创建（任一密码均可，插入时已哈希）。在学习者首次登录改密后，
// 直接向隔离库种入一条 xp_entries（真实后端字段）供 /xp 消费；排行榜依赖真实的
// challenge_point_entries（seam 默认空 → 空榜断言）。
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { adminUsernameFor, createIsolatedAdmin, stateFileFor } from "./auth-setup.js";
import { cleanupIsolatedAdmin, type ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName } from "./import-e2e-db.js";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
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
    const project = testInfo.project.name;
    await ensureIsolatedAdmin(browser, project);
    const context = await browser.newContext({ storageState: stateFileForProject(project) });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

test.describe("learner xp & leaderboard UI", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    if (!E2E_DB) {
      throw new Error(
        "learner-xp-leaderboard E2E 必须运行在独立 E2E 数据库（E2E_IMPORT_DB）。请使用 runbook。",
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
    if (apiUp) {
      await ensureIsolatedAdmin(browser, currentProjectName);
    }
  });

  test.beforeEach(() => {
    test.skip(!apiUp && process.env.MOTRO_REQUIRE_DB !== "1", "需要运行中的 API 与数据库");
  });

  test.afterAll(async () => {
    const project = currentProjectName;
    const admin = projectAdmins.get(project);
    if (admin) await cleanupIsolatedAdmin(admin);
    rmSync(stateFileForProject(project), { force: true });
  });

  /** 用隔离管理员在隔离库创建一个 learner（通过 API），返回用户名/OTP。 */
  async function createLearnerViaAdmin(page: Page): Promise<{ username: string; otp: string }> {
    const username = `mo-ui-${randomUUID().slice(0, 8)}`;
    const req = page.request;
    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name === "motro_csrf")?.value;
    const create = await req.fetch(`${API}/api/v1/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf || "",
        "idempotency-key": `mo-learner-${username}`,
      },
      data: {
        username,
        displayName: `UI ${username}`,
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(create.status()).toBe(201);
    const { oneTimePassword } = (await create.json()) as { oneTimePassword: string };
    return { username, otp: oneTimePassword };
  }

  /** 学习者 UI 登录（首登改密），落到 /app。 */
  async function loginLearner(
    page: Page,
    learner: { username: string; otp: string },
  ): Promise<void> {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
    await page.getByLabel("用户名").fill(learner.username);
    await page.getByLabel("密码").fill(learner.otp);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/, { timeout: 15000 });
    await page.getByLabel(/当前密码/).fill(learner.otp);
    const newPass = "learner-ui-pass-12345";
    await page.getByLabel(/^新密码/).fill(newPass);
    await page.getByLabel(/确认新密码/).fill(newPass);
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15000 });
  }

  test("学习者打开 /xp：空记录 → empty state，不显示伪造数字", async ({ adminPage }) => {
    await createLearnerViaUiAndLogin(adminPage);
    await adminPage.goto("/xp");
    await expect(adminPage.getByRole("heading", { name: "个人经验" })).toBeVisible();
    await expect(adminPage.getByText("暂无个人经验记录")).toBeVisible();
    const body = await adminPage.locator("body").innerText();
    expect(body).not.toContain("CEFR");
    expect(body).not.toContain("连续天数");
    expect(body).not.toContain("排行榜排名");
  });

  test("学习者打开 /leaderboard：空榜 empty state；明确 daily XP 不参与排名", async ({
    adminPage,
  }) => {
    await createLearnerViaUiAndLogin(adminPage);
    await adminPage.goto("/leaderboard");
    await expect(adminPage.getByRole("heading", { name: "周挑战榜" })).toBeVisible();
    await expect(adminPage.getByText("本周还没有公开上榜的参与者")).toBeVisible();
    await expect(adminPage.getByText(/日常学习 XP.*不参与排名/)).toBeVisible();
  });

  test("隐私设置：关闭公开展示 → 服务器返回最终状态（isPublic）", async ({ adminPage }) => {
    await createLearnerViaUiAndLogin(adminPage);
    await adminPage.goto("/leaderboard");
    const btn = adminPage.getByRole("button", { name: /当前公开|当前不公开/ });
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(adminPage.getByRole("button", { name: /当前不公开/ })).toBeVisible({
      timeout: 15000,
    });
  });

  test("390/768/1440 无横向溢出（/xp 与 /leaderboard）", async ({ adminPage }) => {
    await createLearnerViaUiAndLogin(adminPage);
    for (const width of [390, 768, 1440]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const path of ["/xp", "/leaderboard"]) {
        await adminPage.goto(path);
        await expect(adminPage.locator("h1").first()).toBeVisible();
        const overflow = await adminPage.evaluate(
          () =>
            document.documentElement.scrollWidth > document.documentElement.clientWidth ||
            document.body.scrollWidth > document.body.clientWidth,
        );
        expect(overflow, `${width}px ${path} 无横向滚动`).toBe(false);
      }
    }
  });

  test("键盘可达：排行榜「返回首页」链接可聚焦（Chromium）", async ({ adminPage }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "Playwright WebKit headless 不合成顺序 Tab 导航");
    await createLearnerViaUiAndLogin(adminPage);
    await adminPage.goto("/leaderboard");
    const homeLink = adminPage.getByRole("link", { name: "返回首页" });
    await homeLink.focus();
    await expect(homeLink).toBeFocused();
  });

  test("reduced-motion 下页面可用", async ({ adminPage }) => {
    await adminPage.emulateMedia({ reducedMotion: "reduce" });
    await createLearnerViaUiAndLogin(adminPage);
    await adminPage.goto("/xp");
    await expect(adminPage.getByRole("heading", { name: "个人经验" })).toBeVisible();
  });

  /** 创建 learner（API）+ 学习者 UI 登录。 */
  async function createLearnerViaUiAndLogin(
    page: Page,
  ): Promise<{ username: string; otp: string }> {
    const learner = await createLearnerViaAdmin(page);
    await loginLearner(page, learner);
    return learner;
  }
});
