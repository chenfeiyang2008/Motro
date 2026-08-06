// 课程词项 E2E：搜索词条、添加中文释义/提示、键盘排序、刷新恢复与空释义错误提示。
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
  // 等待登录页 useEffect 的 warmCsrf 完成，避免提交时缺少 CSRF cookie 被 403。
  await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
  await page.getByLabel("用户名").fill(ADMIN_USER);
  await page.getByLabel("密码").fill(ADMIN_PASS);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15000 });
}

async function loginAdminApi(
  playwright: import("@playwright/test").Playwright,
): Promise<{ ctx: APIRequestContext; csrf: string }> {
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

async function createEntry(
  ctx: APIRequestContext,
  csrf: string,
  spelling: string,
): Promise<string> {
  const res = await ctx.post("/api/v1/admin/lexical-entries", {
    headers: { "x-csrf-token": csrf },
    data: { canonicalSpelling: spelling, confirmDuplicate: false },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

async function createCourseWithUnit(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ courseId: string; unitId: string; version: number; title: string }> {
  const slug = `e2e-item-course-${Date.now()}`;
  const title = `词项课程 ${Date.now()}`;
  const create = await ctx.post("/api/v1/admin/courses", {
    headers: { "x-csrf-token": csrf },
    data: { slug, title, level: "a1" },
  });
  expect(create.status()).toBe(201);
  const { courseId, draftVersion } = (await create.json()) as {
    courseId: string;
    draftVersion: number;
  };

  const unitId = crypto.randomUUID();
  const unit = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
    headers: { "x-csrf-token": csrf },
    data: { title: "基础词汇", draftVersion },
  });
  expect(unit.status()).toBe(201);
  const version = (await unit.json()).version as number;
  return { courseId, unitId, version, title };
}

test.describe("admin course items", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("搜索词条、添加中文释义、键盘排序、刷新后内容与顺序保持", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const spelling = `e2e-item-${Date.now()}`;
      const spelling2 = `e2e-item2-${Date.now()}`;
      await createEntry(ctx, csrf, spelling);
      await createEntry(ctx, csrf, spelling2);
      const { courseId, title } = await createCourseWithUnit(ctx, csrf);

      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/draft`);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();

      // 添加第一个词项。
      await page.getByRole("button", { name: "添加课程词项" }).click();
      await page.getByLabel(/搜索词条/).fill(spelling);
      await page.getByRole("button", { name: new RegExp(spelling) }).click();
      await page.getByLabel(/中文释义/).fill("放弃");
      await page.getByLabel(/提示（可选）/).fill("不要放弃");
      await page.getByRole("button", { name: "保存词项" }).click();
      await expect(page.getByText("放弃", { exact: true })).toBeVisible();
      await expect(page.getByText(/来源：manual/)).toBeVisible();
      await expect(page.getByText(/词项 ID：/)).toBeVisible();

      // 添加第二个词项。
      await page.getByRole("button", { name: "添加课程词项" }).click();
      await page.getByLabel(/搜索词条/).fill(spelling2);
      await page.getByRole("button", { name: new RegExp(spelling2) }).click();
      await page.getByLabel(/中文释义/).fill("坚持");
      await page.getByRole("button", { name: "保存词项" }).click();
      await expect(page.getByText("坚持", { exact: true })).toBeVisible();

      // 键盘上移第二个词项 → 顺序：spelling2、spelling。
      await page.getByRole("button", { name: `上移 ${spelling2}` }).click();
      await expect(page.locator(".item-entry").first()).toContainText(spelling2);
      await expect(page.locator(".item-entry").nth(1)).toContainText(spelling);

      // 保存草稿后刷新，内容与顺序保持、词项 ID 稳定。
      await page.getByRole("button", { name: "保存草稿" }).click();
      await page.reload();
      await expect(page.locator(".item-entry").first()).toContainText(spelling2);
      await expect(page.locator(".item-entry").first()).toContainText("坚持");
      await expect(page.locator(".item-entry").nth(1)).toContainText(spelling);
      await expect(page.locator(".item-entry").nth(1)).toContainText("放弃");
    } finally {
      await ctx.dispose();
    }
  });

  test("中文释义为空时在字段旁显示明确错误", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const spelling = `e2e-empty-${Date.now()}`;
      await createEntry(ctx, csrf, spelling);
      const { courseId, title } = await createCourseWithUnit(ctx, csrf);

      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/draft`);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();

      await page.getByRole("button", { name: "添加课程词项" }).click();
      await page.getByLabel(/搜索词条/).fill(spelling);
      await page.getByRole("button", { name: new RegExp(spelling) }).click();
      // 不填中文释义，直接保存。
      await page.getByRole("button", { name: "保存词项" }).click();
      await expect(page.getByText("中文释义不能为空")).toBeVisible();
      // 其他输入保留（已选择词条仍在）。
      await expect(page.getByText(new RegExp(`已选择词条：${spelling}`))).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });
});
