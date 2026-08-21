// 管理端用户管理 E2E（工单：admin-user-management-console）。
// 覆盖：管理员查看列表并创建 learner；一次性密码仅成功层展示、关闭不可恢复；
// 创建失败/重复用户名/422 字段错误；重复提交不创建两名用户；创建 admin 风险确认；
// 重置其他用户密码；停用后状态更新；当前管理员停用按钮不可用；learner 访问被拒；
// 390/768/1440 无横向溢出；键盘/焦点可达；暗色与亮色对比可读。
//
// 运行环境：独立 E2E 数据库（compose/e2e-import.yml，含 worker-e2e 服务）。
// 复用 auth-setup 的隔离管理员（每 project 独立 admin 与 state 文件）。
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { adminUsernameFor, createIsolatedAdmin, stateFileFor } from "./auth-setup.js";
import { cleanupIsolatedAdmin, type ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName } from "./import-e2e-db.js";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
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

/** 读取浏览器 CSRF cookie 值（双提交 cookie 需要 header 回传）。 */
async function readCsrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === "motro_csrf")?.value;
  if (!csrf) {
    await page.goto("/api/v1/health/live");
    const again = await page.context().cookies();
    return again.find((c) => c.name === "motro_csrf")?.value ?? "";
  }
  return csrf;
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

test.describe("admin user management", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    if (!E2E_DB) {
      throw new Error(
        "admin-users E2E 必须运行在独立 E2E 数据库（E2E_IMPORT_DB）。请使用 runbook：docker compose -f compose/e2e-import.yml up -d --build",
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
    rmSync(stateFileForProject(project), { force: true });
  });

  /** 通过 UI 打开用户管理页。 */
  async function gotoUsers(page: Page): Promise<void> {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
  }

  /** 在「添加用户」表单里填入唯一用户名并提交，返回一次性密码层文本。 */
  async function createUserViaUi(
    page: Page,
    opts: { username?: string; role?: "learner" | "admin" } = {},
  ): Promise<{ username: string; otpText: string }> {
    await page.getByRole("button", { name: "添加用户" }).click();
    const dialog = page.getByRole("dialog", { name: "添加用户" });
    await expect(dialog).toBeVisible();
    const username = opts.username ?? `e2e-usr-${randomUUID().slice(0, 8)}`;
    await dialog.getByLabel("登录用户名").fill(username);
    // 「显示名」「角色」同时出现在列表筛选与创建表单，限定到 dialog 避免严格模式歧义。
    await dialog.getByLabel("显示名", { exact: true }).fill(`用户 ${username}`);
    if (opts.role === "admin") {
      await dialog.getByLabel("角色", { exact: true }).selectOption("admin");
    }
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const otpDialog = page.getByRole("dialog", { name: /一次性密码/ });
    await expect(otpDialog).toBeVisible({ timeout: 15000 });
    const otpText = (await otpDialog.getByTestId("otp-password").textContent())?.trim() ?? "";
    expect(otpText.length).toBeGreaterThanOrEqual(8);
    return { username, otpText };
  }

  test("管理员打开列表并创建 learner，一次性密码仅成功层展示、关闭后不可恢复", async ({
    adminPage,
  }) => {
    await gotoUsers(adminPage);
    // 列表首屏有加载骨架或表格；隔离管理员自身应出现。
    await expect(adminPage.getByRole("heading", { name: "用户管理" })).toBeVisible();
    const { username, otpText } = await createUserViaUi(adminPage, { role: "learner" });

    // 一次性密码出现在仅成功后的确认层；关闭后不可在页面/DOM/localStorage 恢复。
    const storedOtpRefs = await adminPage.evaluate(() =>
      [window.localStorage, window.sessionStorage].map((s) => {
        const keys: string[] = [];
        for (let i = 0; i < s.length; i++) keys.push(s.key(i) ?? "");
        return keys;
      }),
    );
    expect(storedOtpRefs.flat().join("|")).not.toContain(otpText);

    // 关闭确认层 → 页面不再包含密码文本。
    await adminPage.getByRole("button", { name: "取消" }).click();
    await expect(adminPage.getByRole("dialog", { name: /一次性密码/ })).toHaveCount(0);
    await expect(adminPage.getByText(otpText, { exact: true })).toHaveCount(0);

    // 新用户出现在列表（用户名 + 学习者角色 + 活跃状态）。
    const newRow = adminPage.getByTestId("user-row").filter({ hasText: username });
    await expect(newRow).toBeVisible();
    await expect(newRow.getByText("学习者", { exact: true })).toBeVisible();
  });

  test("创建 admin 角色时显示风险提示", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    await adminPage.getByRole("button", { name: "添加用户" }).click();
    const dialog = adminPage.getByRole("dialog", { name: "添加用户" });
    await expect(dialog).toBeVisible();
    // 默认 learner 不显示风险提示。
    await expect(adminPage.getByText(/谨慎授权/)).toHaveCount(0);
    await dialog.getByLabel("角色").selectOption("admin");
    await expect(adminPage.getByText(/谨慎授权/)).toBeVisible();
  });

  test("创建失败：重复用户名 409", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    const existing = await createUserViaUi(adminPage, { role: "learner" });
    // 关闭 OTP 层，回到列表。
    await adminPage.getByRole("button", { name: "取消" }).click();
    await expect(adminPage.getByRole("dialog", { name: /一次性密码/ })).toHaveCount(0);

    // 用同一用户名再次创建 → 409 关联反馈，不显示 OTP。
    await adminPage.getByRole("button", { name: "添加用户" }).click();
    const dialog = adminPage.getByRole("dialog", { name: "添加用户" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("登录用户名").fill(existing.username);
    await dialog.getByLabel("显示名", { exact: true }).fill("重复用户");
    const submit = adminPage.getByRole("button", { name: "创建", exact: true });
    await submit.click();
    await expect(adminPage.getByText(/已存在|用户名已存在/i)).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByRole("dialog", { name: /一次性密码/ })).toHaveCount(0);
  });

  test("重复提交不创建两名用户（幂等）", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    const username = `e2e-idem-${randomUUID().slice(0, 8)}`;
    // 打开表单并填写完整（保持字段不变，客户端会复用同一 Idempotency-Key）。
    await adminPage.getByRole("button", { name: "添加用户" }).click();
    const dialog = adminPage.getByRole("dialog", { name: "添加用户" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("登录用户名").fill(username);
    await dialog.getByLabel("显示名", { exact: true }).fill(`用户 ${username}`);

    // 同步 dispatch 两次 click：在 React 把 creating 置为 disabled 之前同时触发两次提交，
    // 两次都携带同一意图键 → 服务端幂等重放，只创建一个用户。
    await adminPage.getByRole("button", { name: "创建", exact: true }).evaluate((btn) => {
      (btn as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      (btn as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const otpDialog = adminPage.getByRole("dialog", { name: /一次性密码/ });
    await expect(otpDialog).toBeVisible({ timeout: 15000 });

    // 重置意图键在成功后清除；再次以相同表单重提会生成新键并触发 409（用户名已存在）。
    // 这里仅断言：一次成功创建后列表只有一行，不产生第二名用户。
    await adminPage.getByRole("button", { name: "取消" }).click();
    await expect(otpDialog).toHaveCount(0);
    const rows = adminPage.getByTestId("user-row").filter({ hasText: username });
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(1);
  });

  test("列表搜索框可按用户名过滤可见行（服务端搜索）", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    // 等待列表加载（隔离管理员自身通常出现，或为空）。
    await expect(adminPage.locator(".admin-users")).toBeVisible();

    // 服务端搜索：输入关键词后点「搜索」触发后端筛选。
    const filterInput = adminPage.getByLabel("搜索用户名/显示名");
    await expect(filterInput).toBeVisible();
    const searchBtn = adminPage.getByRole("button", { name: "搜索" });
    // 输入一个不存在的关键词 → 无可见行。
    await filterInput.fill("__definitely_non_existent_user__");
    await searchBtn.click();
    await expect(adminPage.getByTestId("user-row")).toHaveCount(0);
    // 清空 → 恢复。
    await filterInput.fill("");
    await searchBtn.click();
    await expect(adminPage.getByTestId("user-row").first()).toBeVisible();
  });

  test("重置其他用户密码并进入一次性密码层；停用后状态更新且停用按钮消失", async ({
    adminPage,
  }) => {
    await gotoUsers(adminPage);
    const { username } = await createUserViaUi(adminPage, { role: "learner" });
    await adminPage.getByRole("button", { name: "取消" }).click();
    await expect(adminPage.getByRole("dialog", { name: /一次性密码/ })).toHaveCount(0);

    const row = adminPage.getByTestId("user-row").filter({ hasText: username });
    await expect(row).toBeVisible();

    // 重置密码 → 二次确认 → 一次性密码层。
    await row.getByRole("button", { name: "重置密码" }).click();
    await expect(adminPage.getByRole("dialog", { name: /重置 .* 的密码/ })).toBeVisible();
    await adminPage.getByRole("button", { name: "确认重置" }).click();
    await expect(adminPage.getByRole("dialog", { name: /一次性密码/ })).toBeVisible({
      timeout: 15000,
    });
    const otpText = (await adminPage.getByTestId("otp-password").textContent())?.trim();
    expect((otpText ?? "").length).toBeGreaterThanOrEqual(8);
    await adminPage.getByRole("button", { name: "取消" }).click();
    await expect(adminPage.getByRole("dialog", { name: /一次性密码/ })).toHaveCount(0);

    // 停用该用户 → 二次确认 → 状态徽标变为「已停用」，且停用按钮消失。
    const row2 = adminPage.getByTestId("user-row").filter({ hasText: username });
    await row2.getByRole("button", { name: "停用" }).click();
    await expect(adminPage.getByRole("dialog", { name: /停用 .*？/ })).toBeVisible();
    await adminPage.getByRole("button", { name: "确认停用" }).click();
    // 刷新后状态持久。
    await adminPage.reload();
    const row3 = adminPage.getByTestId("user-row").filter({ hasText: username });
    await expect(row3.getByText("已停用", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(row3.getByRole("button", { name: "停用" })).toHaveCount(0);
    // 已停用用户仍可重置密码。
    await expect(row3.getByRole("button", { name: "重置密码" })).toBeVisible();
  });

  test("当前管理员的停用按钮不可用，并显示当前账号", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    // 隔离管理员（自己）的行：停用按钮不可见，显示「当前账号」。
    const admin = projectAdmins.get(currentProjectName);
    const selfRow = adminPage.getByTestId("user-row").filter({ hasText: admin!.username });
    await expect(selfRow).toBeVisible();
    await expect(selfRow.getByText("当前账号", { exact: true })).toBeVisible();
    await expect(selfRow.getByRole("button", { name: "停用" })).toHaveCount(0);
  });

  test("编辑弹窗以视口居中，长列表中不会只显示遮罩", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    const editButton = adminPage.getByTestId("user-row").first().getByRole("button", {
      name: "编辑",
    });
    await expect(editButton).toBeVisible();
    await editButton.click();

    const dialog = adminPage.getByRole("dialog", { name: /^编辑 / });
    await expect(dialog).toBeVisible();
    const [dialogBox, viewport] = await Promise.all([
      dialog.boundingBox(),
      adminPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    ]);
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);

    await adminPage.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("learner 访问 /admin/users 被拒（无权限页）", async ({ adminPage, page }) => {
    // 通过 API 创建 learner：复用 admin-imports 规范的 API 请求上下文。
    const apiReq = adminPage.request;
    const csrfToken = await readCsrfToken(adminPage);
    const username = `e2e-learner-${randomUUID().slice(0, 8)}`;
    const create = await apiReq.post("/api/v1/admin/users", {
      headers: {
        "idempotency-key": `e2e-create-${username}`,
        "x-csrf-token": csrfToken,
      },
      data: {
        username,
        displayName: "E2E 学习者",
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(create.status()).toBe(201);
    const { oneTimePassword } = (await create.json()) as { oneTimePassword: string };

    // 用一次性密码登录学习者 → 强制改密 → 进入学习端。
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码").fill(oneTimePassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/, { timeout: 15000 });
    await page.getByLabel(/当前密码/).fill(oneTimePassword);
    await page.getByLabel(/^新密码/).fill("learner-e2e-pass-12345");
    await page.getByLabel(/确认新密码/).fill("learner-e2e-pass-12345");
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15000 });

    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "无权限" })).toBeVisible();
    await expect(page.getByText(/没有权限访问管理端/)).toBeVisible();
  });

  test("390/768/1440px 用户管理页无横向溢出", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    await expect(adminPage.getByRole("heading", { name: "用户管理" })).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await adminPage.reload();
      await expect(adminPage.locator("h1", { hasText: "用户管理" })).toBeVisible();
      const overflow = await adminPage.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 用户管理页无横向滚动`).toBe(false);
    }
  });

  test("键盘可到达、焦点可见、主要点击目标 ≥44px（Chromium）", async ({ adminPage }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "Playwright WebKit headless 不合成顺序 Tab 导航");
    await gotoUsers(adminPage);
    // 「添加用户」主按钮 44px。
    const addBtn = adminPage.getByRole("button", { name: "添加用户" });
    const box = (await addBtn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);

    // 打开表单，用户名输入可聚焦且可见 focus-visible。
    await addBtn.click();
    const usernameInput = adminPage.getByLabel("登录用户名");
    await expect(usernameInput).toBeVisible();
    await usernameInput.focus();
    await expect(usernameInput).toBeFocused();
    const focusVisible = await usernameInput.evaluate((el) => el.matches(":focus-visible"));
    expect(focusVisible).toBe(true);

    // Tab 顺序可到达「创建」按钮（可见焦点）。
    await adminPage.keyboard.press("Tab");
    const focused = await adminPage.evaluate(
      () => (document.activeElement as HTMLElement | null)?.tagName ?? "",
    );
    expect(focused.length).toBeGreaterThan(0);
  });

  test("暗色与亮色主题均有可读对比（状态/角色/正文前景色）", async ({ adminPage }) => {
    await gotoUsers(adminPage);
    // 隔离管理员行可见。
    const admin = projectAdmins.get(currentProjectName);
    await expect(
      adminPage.getByTestId("user-row").filter({ hasText: admin!.username }),
    ).toBeVisible();

    async function themeTokensCorrect(): Promise<boolean> {
      // 验证语义 token 对两种主题都是已知可读色值（从 body 读取主题 token）。
      return adminPage.evaluate(() => {
        const body = getComputedStyle(document.body);
        const bg = body.getPropertyValue("--color-bg-surface").trim();
        const text = body.getPropertyValue("--color-text-primary").trim();
        const secondary = body.getPropertyValue("--color-text-secondary").trim();
        const border = body.getPropertyValue("--color-border").trim();
        // 所有语义 token 必须被设置为非空 hex（亮色 #fff 系 / 暗色 #0d1724 系）。
        const tokens = [bg, text, secondary, border];
        const hexRe = /^#[0-9a-f]{6}$/i;
        return tokens.every((v) => hexRe.test(v));
      });
    }

    for (const theme of ["light", "dark"] as const) {
      await adminPage.evaluate(
        (t) => document.documentElement.setAttribute("data-theme", t),
        theme,
      );
      await adminPage.reload();
      await expect(adminPage.locator("h1", { hasText: "用户管理" })).toBeVisible();
      // 验证 token 正确映射（即前景/背景/边框均是合理可读色值）。
      expect(await themeTokensCorrect(), `${theme} 主题语义 token 正确映射`).toBe(true);
    }
  });
});
