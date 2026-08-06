// 管理端路由鉴权 E2E：未登录跳转 /login、管理员可访问、learner 显示无权限。
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

/** 通过管理 API 创建学习者，返回其一次性密码。 */
async function createLearner(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ username: string; otp: string }> {
  const username = `e2e-access-learner-${Date.now()}`;
  const res = await ctx.post("/api/v1/admin/users", {
    headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-access-${username}` },
    data: {
      username,
      displayName: "E2E 学习者",
      timezone: "Asia/Shanghai",
      dailyBudgetMinutes: 10,
    },
  });
  expect(res.status()).toBe(201);
  const { oneTimePassword } = (await res.json()) as { oneTimePassword: string };
  return { username, otp: oneTimePassword };
}

test.describe("admin route access", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("未登录访问 /admin/courses 跳转到 /login", async ({ page }) => {
    await page.goto("/admin/courses");
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });

  test("登录管理员后可访问 /admin/courses", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/courses");
    await expect(page.getByRole("heading", { name: "课程" })).toBeVisible();
  });

  test("learner 登录后访问管理端显示无权限", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    let learner;
    try {
      learner = await createLearner(ctx, csrf);
    } finally {
      await ctx.dispose();
    }

    // 学习者用一次性密码登录 → 强制改密 → 进入学习端。
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
    await page.getByLabel("用户名").fill(learner.username);
    await page.getByLabel("密码").fill(learner.otp);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/, { timeout: 15000 });
    await page.getByLabel(/当前密码/).fill(learner.otp);
    await page.getByLabel(/^新密码/).fill("learner-access-pass-123");
    await page.getByLabel(/确认新密码/).fill("learner-access-pass-123");
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15000 });

    // 学习者访问管理端 → 无权限页，不展示管理端外壳。
    await page.goto("/admin/courses");
    await expect(page.getByRole("heading", { name: "无权限" })).toBeVisible();
    await expect(page.getByText(/没有权限访问管理端/)).toBeVisible();
  });
});
