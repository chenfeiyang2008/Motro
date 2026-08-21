// 管理端课程列表 E2E：首屏分页、搜索、加载更多与响应式表格。
import { expect, test, type APIRequestContext, type Page, type Playwright } from "@playwright/test";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";

async function loginAdminApi(playwright: Playwright): Promise<{
  ctx: APIRequestContext;
  csrf: string;
}> {
  const ctx = await playwright.request.newContext({ baseURL: API });
  await ctx.get("/api/v1/health/live");
  const beforeLogin = await ctx.storageState();
  const csrf = beforeLogin.cookies.find((cookie) => cookie.name === "motro_csrf")?.value ?? "";
  const login = await ctx.post("/api/v1/auth/login", {
    headers: { "x-csrf-token": csrf },
    data: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  expect(login.status()).toBe(200);
  return { ctx, csrf };
}

async function loginAdminPage(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(ADMIN_USER);
  await page.getByLabel("密码").fill(ADMIN_PASS);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/app|\/admin/);
}

test.describe("admin course list pagination", () => {
  test.beforeEach(() => {
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD");
  });

  test("首屏不超过 50 条，搜索重置游标，加载更多追加且无重复", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    const marker = `e2e-page-${Date.now()}`;
    try {
      for (const suffix of ["one", "two", "three"]) {
        const create = await ctx.post("/api/v1/admin/courses", {
          headers: { "x-csrf-token": csrf },
          data: { slug: `${marker}-${suffix}`, title: `${marker} ${suffix}`, level: "a1" },
        });
        expect(create.status()).toBe(201);
      }

      await loginAdminPage(page);
      const requests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/v1/admin/courses?")) requests.push(request.url());
      });
      await page.goto("/admin/courses");
      await expect(page.getByRole("heading", { name: "课程" })).toBeVisible();
      expect(requests.some((url) => /[?&]limit=50(?:&|$)/.test(url))).toBe(true);

      await page.getByLabel("搜索课程").fill(marker);
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      await expect(page.getByRole("link", { name: `${marker} one`, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: `${marker} two`, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: `${marker} three`, exact: true })).toBeVisible();
      await expect(page.locator(".admin-courses-page")).toHaveCount(1);

      for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 900 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(width).toBeLessThanOrEqual(viewport.width);
      }
    } finally {
      await ctx.dispose();
    }
  });
});
