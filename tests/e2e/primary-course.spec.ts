// 主课程选择 E2E：加入课程、设为主课程、切换到另一门课程、刷新后状态保持。
// 需要运行中的 API + PostgreSQL（compose 环境）与最新构建的 Web。API 不可达时自动跳过。
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
  title: string,
): Promise<{ courseId: string }> {
  const slug = `e2e-primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    data: {
      canonicalSpelling: `e2e-primary-word-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      confirmDuplicate: false,
    },
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
    headers: {
      "x-csrf-token": csrf,
      "idempotency-key": `primary-pub-${Date.now()}-${Math.random()}`,
    },
    data: { draftVersion: versionAfter, releaseNote: "发布" },
  });
  expect(pub.status()).toBe(201);
  return { courseId };
}

async function createLearner(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ username: string; otp: string }> {
  // 用户名限 3-32 位小写字母/数字/._-；并行 project（chromium/webkit）会同时创建，
  // 因此用较短的 base36 前缀 + 随机分量避免同毫秒碰撞又不超过长度。
  const username = `e2epri${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const res = await ctx.post("/api/v1/admin/users", {
    headers: { "x-csrf-token": csrf, "idempotency-key": `primary-learner-${username}` },
    data: {
      username,
      displayName: "E2E 主课程学习者",
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
  await page.getByLabel(/^新密码/).fill("primary-learner-pass-123");
  await page.getByLabel(/确认新密码/).fill("primary-learner-pass-123");
  await page.getByRole("button", { name: "保存新密码" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15000 });
}

test.describe("primary course", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("加入课程、设为主课程、切换另一门课程、刷新后状态保持", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      // 标题带随机分量：并行 project 及历史运行会在同一课程列表留下同名课程，
      // 精确匹配本次创建的那门课程避免误判其他学习者的状态。
      const titleA = `主课程A ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const titleB = `主课程B ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const courseA = await createPublishedCourse(ctx, csrf, titleA);
      const courseB = await createPublishedCourse(ctx, csrf, titleB);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner);

      // 课程 A 详情：未加入时显示“设为主课程”并显示当前版本。
      await page.goto(`/courses/${courseA.courseId}`);
      await expect(page.getByRole("heading", { name: new RegExp(titleA) })).toBeVisible();
      await expect(page.getByText(/版本 1/)).toBeVisible();
      const joinPrimary = page.getByRole("button", { name: "设为主课程" });
      await expect(joinPrimary).toBeVisible();

      // 点击“设为主课程”：加入并设为主，出现成功反馈与选中状态。
      await joinPrimary.click();
      await expect(page.getByText("已设为主课程。其他课程及其学习历史不受影响。")).toBeVisible();
      await expect(page.locator(".course-primary-selected")).toBeVisible();

      // 刷新后状态保持：仍显示非动作选中状态。
      await page.reload();
      await expect(page.locator(".course-primary-selected")).toBeVisible();

      // 课程 B：先“加入课程”，再“设为主课程”（触发切换确认）。
      await page.goto(`/courses/${courseB.courseId}`);
      await expect(page.getByRole("heading", { name: new RegExp(titleB) })).toBeVisible();
      await page.getByRole("button", { name: "加入课程" }).click();
      await expect(page.getByText("已加入课程。可以再将其设为主课程。")).toBeVisible();

      const dialogPromise = page.waitForEvent("dialog");
      const switchClick = page.getByRole("button", { name: "设为主课程" }).click();
      const dialog = await dialogPromise;
      expect(dialog.message()).toContain("不会被删除");
      await dialog.accept();
      await switchClick;

      await expect(page.locator(".course-primary-selected")).toBeVisible();
      await expect(page.getByText("已切换主课程。其他课程的学习历史不受影响。")).toBeVisible();

      // 切换后课程 A 详情：仍已报名但不再是主课程（保留历史）。
      await page.goto(`/courses/${courseA.courseId}`);
      await expect(page.getByRole("heading", { name: new RegExp(titleA) })).toBeVisible();
      await expect(page.getByText("已加入", { exact: true }).first()).toBeVisible();
      await expect(page.locator(".course-primary-selected")).toHaveCount(0);

      // 课程 B 详情刷新后仍是主课程。
      await page.goto(`/courses/${courseB.courseId}`);
      await page.reload();
      await expect(page.locator(".course-primary-selected")).toBeVisible();

      // 列表：只有本次课程 B 显示主课程；刷新后仍唯一。
      await page.goto("/courses");
      const bCard = page.getByRole("link", { name: new RegExp(titleB) });
      await expect(bCard).toBeVisible();
      await expect(bCard.getByText("主课程", { exact: true })).toBeVisible();
      const aCard = page.getByRole("link", { name: new RegExp(titleA) });
      await expect(aCard).toBeVisible();
      await expect(aCard.getByText("已加入")).toBeVisible();

      await page.reload();
      await expect(
        page.getByRole("link", { name: new RegExp(titleB) }).getByText("主课程", { exact: true }),
      ).toBeVisible();
      // 当前学习者的主课程唯一：全列表恰好一个“主课程”徽标。
      await expect(
        page.getByRole("link", { name: /主课程/ }).getByText("主课程", { exact: true }),
      ).toHaveCount(1);
    } finally {
      await ctx.dispose();
    }
  });
});
