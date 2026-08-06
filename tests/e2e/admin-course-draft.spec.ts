// 课程草稿 E2E：管理员创建课程、保存元数据、添加单元、键盘重排、刷新恢复与版本冲突提示。
// 需要运行中的 API + PostgreSQL（compose 环境）。API 不可达时自动跳过。
import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";

let apiUp = false;
test.beforeAll(async () => {
  try {
    const res = await fetch(`${API}/api/v1/health/live`);
    apiUp = res.ok;
  } catch {
    apiUp = false;
  }
});

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
  await page.getByLabel("用户名").fill(ADMIN_USER);
  await page.getByLabel("密码").fill(ADMIN_PASS);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
}

async function loginAdminApi(playwright: import("@playwright/test").Playwright): Promise<{
  ctx: APIRequestContext;
  csrf: string;
}> {
  const ctx = await playwright.request.newContext({ baseURL: API });
  await ctx.get("/api/v1/health/live");
  const state = await ctx.storageState();
  const csrf = state.cookies.find((c) => c.name === "motro_csrf")?.value ?? "";
  const login = await ctx.post("/api/v1/auth/login", {
    headers: { "x-csrf-token": csrf },
    data: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  expect(login.status()).toBe(200);
  return { ctx, csrf };
}

test.describe("admin course draft", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("创建课程、保存元数据、添加两个单元、键盘重排、刷新后顺序保持", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/courses");
    await expect(page.getByRole("heading", { name: "课程" })).toBeVisible();

    const title = `e2e-course-${Date.now()}`;
    const slug = `e2e-course-${Date.now()}`;
    await page.getByRole("button", { name: "新建课程" }).click();
    await page.getByLabel("slug").fill(slug);
    await page.getByLabel("标题").fill(title);
    await page.getByRole("button", { name: "创建课程" }).click();

    // 进入草稿编排页。
    await page.getByRole("link", { name: title, exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText(/当前草稿版本：1/)).toBeVisible();

    // 添加两个单元。
    await page.getByRole("button", { name: "新增单元" }).click();
    await page.getByLabel("单元标题").fill("基础词汇");
    await page.getByRole("button", { name: "添加单元" }).click();
    await expect(page.getByText("基础词汇")).toBeVisible();

    await page.getByRole("button", { name: "新增单元" }).click();
    await page.getByLabel("单元标题").fill("日常表达");
    await page.getByRole("button", { name: "添加单元" }).click();
    await expect(page.getByText("日常表达")).toBeVisible();

    // 键盘上移“日常表达”→ 顺序变为 日常表达、基础词汇。
    await page.getByRole("button", { name: "上移 日常表达" }).click();
    await expect(page.locator(".unit-item").nth(0)).toContainText("日常表达");
    await expect(page.locator(".unit-item").nth(1)).toContainText("基础词汇");

    // 保存元数据。
    await page.getByLabel("标题").fill(`${title} 修订`);
    await page.getByRole("button", { name: "保存草稿" }).click();
    await expect(page.getByText("草稿已保存")).toBeVisible();

    // 刷新后顺序保持、标题更新、无未保存状态。
    await page.reload();
    await expect(page.getByRole("heading", { name: `${title} 修订` })).toBeVisible();
    await expect(page.locator(".unit-item").nth(0)).toContainText("日常表达");
    await expect(page.locator(".unit-item").nth(1)).toContainText("基础词汇");
    await expect(page.getByText("有未保存的修改")).toHaveCount(0);
  });

  test("旧版本保存显示冲突提示，修改未覆盖服务端", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      // 通过 API 创建课程。
      const slug = `e2e-conflict-${Date.now()}`;
      const create = await ctx.post("/api/v1/admin/courses", {
        headers: { "x-csrf-token": csrf },
        data: { slug, title: "冲突课程", level: "a1" },
      });
      expect(create.status()).toBe(201);
      const { courseId } = (await create.json()) as { courseId: string };

      // UI 打开草稿页（此时版本 1）。
      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/draft`);
      await expect(page.getByRole("heading", { name: "冲突课程" })).toBeVisible();

      // 用 API 推进版本到 2。
      const patch = await ctx.patch(`/api/v1/admin/courses/${courseId}/draft`, {
        headers: { "x-csrf-token": csrf },
        data: { title: "服务端已修改", draftVersion: 1 },
      });
      expect(patch.status()).toBe(200);

      // UI 用旧版本保存 → 冲突提示，服务端不被覆盖。
      await page.getByLabel("标题").fill("客户端旧版本");
      await page.getByRole("button", { name: "保存草稿" }).click();
      await expect(page.getByText(/草稿已被其他修改更新/)).toBeVisible();
      await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();

      const draftRes = await ctx.get(`/api/v1/admin/courses/${courseId}/draft`);
      const draft = (await draftRes.json()) as { title: string };
      expect(draft.title).toBe("服务端已修改");
    } finally {
      await ctx.dispose();
    }
  });
});
