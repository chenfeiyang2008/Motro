// 课程草稿校验 E2E：阻断错误与修复链接、可发布状态与发布占位、差异摘要、响应式无横向溢出。
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

async function createEntry(ctx: APIRequestContext, csrf: string): Promise<string> {
  const res = await ctx.post("/api/v1/admin/lexical-entries", {
    headers: { "x-csrf-token": csrf },
    data: { canonicalSpelling: `e2e-val-${Date.now()}`, confirmDuplicate: false },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

async function createCourse(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ courseId: string; title: string }> {
  const slug = `e2e-val-course-${Date.now()}`;
  const title = `校验课程 ${Date.now()}`;
  const create = await ctx.post("/api/v1/admin/courses", {
    headers: { "x-csrf-token": csrf },
    data: { slug, title, level: "a1", description: "课程描述" },
  });
  expect(create.status()).toBe(201);
  const { courseId } = (await create.json()) as { courseId: string };
  return { courseId, title };
}

async function addUnit(
  ctx: APIRequestContext,
  csrf: string,
  courseId: string,
  version: number,
): Promise<{ unitId: string; version: number }> {
  const unitId = crypto.randomUUID();
  const unit = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
    headers: { "x-csrf-token": csrf },
    data: { title: "基础词汇", description: "单元描述", draftVersion: version },
  });
  expect(unit.status()).toBe(201);
  return { unitId, version: (await unit.json()).version as number };
}

test.describe("admin course validation", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("阻断错误显示、无发布按钮、修复链接回到编排页", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createCourse(ctx, csrf);
      const { unitId } = await addUnit(ctx, csrf, courseId, 1);

      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await expect(page.getByRole("heading", { name: "发布准备" })).toBeVisible();
      await page.getByRole("button", { name: "校验课程" }).click();

      // 阻断错误显示具体对象/字段。
      await expect(page.getByText("每个单元至少需要一个课程词项")).toBeVisible();
      await expect(page.getByText(`unit.${unitId}`)).toBeVisible();
      await expect(page.getByText("草稿存在阻断错误，暂不可发布")).toBeVisible();

      // 有阻断错误时不显示可执行的“发布版本”按钮。
      await expect(page.getByRole("button", { name: "发布版本" })).toHaveCount(0);

      // 修复链接导航回编排页对应单元。
      await page.getByRole("link", { name: "去修复" }).first().click();
      await expect(page).toHaveURL(new RegExp(`/admin/courses/${courseId}/draft#unit-${unitId}`));
    } finally {
      await ctx.dispose();
    }
  });

  test("可发布时显示 initial 差异摘要与发布占位，响应式无横向溢出", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const entryId = await createEntry(ctx, csrf);
      const { courseId } = await createCourse(ctx, csrf);
      const { unitId, version } = await addUnit(ctx, csrf, courseId, 1);
      const itemId = crypto.randomUUID();
      const item = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
        headers: { "x-csrf-token": csrf },
        data: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
      });
      expect(item.status()).toBe(201);

      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await page.getByRole("button", { name: "校验课程" }).click();

      await expect(page.getByText("草稿可发布")).toBeVisible();
      await expect(page.getByText(/首次发布（initial）/)).toBeVisible();
      await expect(page.getByText(/共 1 个单元、1 个课程词项/)).toBeVisible();
      await expect(page.getByText(/受影响的当前学习者：0/)).toBeVisible();

      // 无阻断错误时显示发布占位（不可执行）。
      const publishBtn = page.getByRole("button", { name: "发布版本" });
      await expect(publishBtn).toBeVisible();
      await expect(publishBtn).toBeDisabled();

      // 390/768/1440 无横向溢出。
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(`/admin/courses/${courseId}/publishing`);
        await page.getByRole("button", { name: "校验课程" }).click();
        await expect(page.getByText("草稿可发布")).toBeVisible();
        const overflow = await page.evaluate(
          "document.documentElement.scrollWidth > document.documentElement.clientWidth",
        );
        expect(overflow, `${width}px 无横向滚动`).toBe(false);
      }
    } finally {
      await ctx.dispose();
    }
  });
});
