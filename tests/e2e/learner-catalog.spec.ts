// 学习者课程目录 E2E：列表→详情→刷新，未开始状态，390/1440 无横向溢出。
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

async function createPublishedCourse(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ courseId: string }> {
  const slug = `e2e-cat-${Date.now()}`;
  const title = `目录课程 ${Date.now()}`;
  const create = await ctx.post("/api/v1/admin/courses", {
    headers: { "x-csrf-token": csrf },
    data: { slug, title, level: "a1", description: "课程描述" },
  });
  expect(create.status()).toBe(201);
  const { courseId, draftVersion } = (await create.json()) as {
    courseId: string;
    draftVersion: number;
  };

  const entry = await ctx.post("/api/v1/admin/lexical-entries", {
    headers: { "x-csrf-token": csrf },
    data: { canonicalSpelling: `e2e-cat-word-${Date.now()}`, confirmDuplicate: false },
  });
  const entryId = (await entry.json()).id as string;

  const unitId = crypto.randomUUID();
  const unit = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
    headers: { "x-csrf-token": csrf },
    data: { title: "基础词汇", description: "单元描述", draftVersion },
  });
  const version = (await unit.json()).version as number;

  const itemId = crypto.randomUUID();
  const item = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
    headers: { "x-csrf-token": csrf },
    data: { unitId, lexicalEntryId: entryId, meaning: "放弃", draftVersion: version },
  });
  const versionAfter = (await item.json()).version as number;

  const pub = await ctx.post(`/api/v1/admin/courses/${courseId}/releases`, {
    headers: { "x-csrf-token": csrf, "idempotency-key": `cat-pub-${Date.now()}` },
    data: { draftVersion: versionAfter, releaseNote: "发布" },
  });
  expect(pub.status()).toBe(201);
  return { courseId };
}

async function createLearner(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ username: string; otp: string }> {
  const username = `e2e-cat-learner-${Date.now()}`;
  const res = await ctx.post("/api/v1/admin/users", {
    headers: { "x-csrf-token": csrf, "idempotency-key": `cat-learner-${username}` },
    data: {
      username,
      displayName: "E2E 目录学习者",
      timezone: "Asia/Shanghai",
      dailyBudgetMinutes: 10,
    },
  });
  expect(res.status()).toBe(201);
  const { oneTimePassword } = (await res.json()) as { oneTimePassword: string };
  return { username, otp: oneTimePassword };
}

async function loginAsLearner(
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
  await page.getByLabel(/^新密码/).fill("cat-learner-pass-123");
  await page.getByLabel(/确认新密码/).fill("cat-learner-pass-123");
  await page.getByRole("button", { name: "保存新密码" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15000 });
}

test.describe("learner catalog", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("学习者浏览已发布课程：列表→详情→刷新，未开始状态，390/1440 无横向溢出", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner);

      await page.goto("/courses");
      await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
      await expect(page.getByText("未开始").first()).toBeVisible();
      await expect(page.getByRole("link", { name: /目录课程/ }).first()).toBeVisible();

      // 详情。
      await page
        .getByRole("link", { name: /目录课程/ })
        .first()
        .click();
      await expect(page).toHaveURL(/\/courses\/[0-9a-f-]+/, { timeout: 10000 });
      await expect(page.getByRole("heading", { name: /目录课程/ })).toBeVisible();
      await expect(page.getByText(/未开始/)).toBeVisible();
      await expect(page.getByText("基础词汇")).toBeVisible();

      // 刷新后仍可见。
      await page.reload();
      await expect(page.getByRole("heading", { name: /目录课程/ })).toBeVisible();

      // 390/1440 无横向溢出。
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/courses");
        await expect(page.getByRole("link", { name: /目录课程/ }).first()).toBeVisible();
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
