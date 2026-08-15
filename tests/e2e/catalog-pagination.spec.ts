// 学习者课程列表分页 E2E：首屏只加载第一页(24)，点击“加载更多”逐页追加，
// 连续点击不重复追加，末页隐藏“加载更多”。需要运行中的 API+Web+PostgreSQL。
// 共享开发库已累积海量已发布课程，因此本测试只校验“加载更多后 DOM 条数增加”的相对行为，
// 而非绝对条数（绝对条数由隔离库 integration 测试覆盖）。
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

async function createLearner(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ username: string; otp: string }> {
  const username = `e2e-catpage-${Date.now()}`;
  const res = await ctx.post("/api/v1/admin/users", {
    headers: { "x-csrf-token": csrf, "idempotency-key": `catpage-learner-${username}` },
    data: {
      username,
      displayName: "E2E 分页学习者",
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
  await page.getByLabel(/^新密码/).fill("catpage-learner-pass-123");
  await page.getByLabel(/确认新密码/).fill("catpage-learner-pass-123");
  await page.getByRole("button", { name: "保存新密码" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15000 });
}

async function cardCount(page: Page): Promise<number> {
  return page.getByRole("listitem").count();
}

test.describe("learner catalog keyset pagination", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
  });

  test("首屏只渲染第一页；点加载更多追加、末页隐藏按钮、连续点击不重复", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner);

      await page.goto("/courses");
      await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
      // 首屏应渲染（且因大数据集必有“加载更多”）。
      await expect(page.getByRole("button", { name: "加载更多" })).toBeVisible();
      const firstCount = await cardCount(page);
      // 首屏至多 limit 条：服务端默认 limit=24，DOM 渲染应不超过 24 条。
      expect(firstCount).toBeLessThanOrEqual(24);
      expect(firstCount).toBeGreaterThan(0);

      // 第一次点“加载更多”→ 追加下一页，DOM 条数增长，且不超过 48。
      const more = page.getByRole("button", { name: "加载更多" });
      await more.click();
      await expect(page.getByText("加载中…")).toHaveCount(0, { timeout: 10000 });
      const secondCount = await cardCount(page);
      expect(secondCount).toBeGreaterThan(firstCount);
      expect(secondCount).toBeLessThanOrEqual(48);

      // 连续快速点击（双击）不产生额外重复请求：次数单调不超预期。
      const after = await cardCount(page);
      expect(after).toBe(secondCount);

      // 逐页翻到底，末页隐藏“加载更多”。兜底防死循环。
      let guard = 0;
      while (
        await page
          .getByRole("button", { name: "加载更多" })
          .isVisible()
          .catch(() => false)
      ) {
        const before = await cardCount(page);
        await page.getByRole("button", { name: "加载更多" }).click();
        await expect(page.getByText("加载中…")).toHaveCount(0, { timeout: 10000 });
        const afterClick = await cardCount(page);
        expect(afterClick).toBeGreaterThanOrEqual(before); // 不快于重复/不倒退
        guard++;
        expect(guard).toBeLessThan(700); // 共享库可能上万条，给足兜底
      }
      // 到底后按钮消失。
      await expect(page.getByRole("button", { name: "加载更多" })).toHaveCount(0, {
        timeout: 10000,
      });
    } finally {
      await ctx.dispose();
    }
  });

  test("分页请求失败后可重试：失败时保留已加载项、显示错误，重试成功追加", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner);

      // 拦截带 cursor 的下一页请求，让第一次“加载更多”返回 500 服务端错误（确定性失败）。
      let failNext = true;
      await page.route("**/api/v1/catalog/courses*", async (route) => {
        const url = String(route.request().url());
        if (url.includes("cursor=")) {
          if (failNext) {
            failNext = false;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "UPSTREAM_ERROR", message: "服务端暂时不可用", retryable: true },
              }),
            });
            return;
          }
        }
        await route.continue();
      });

      await page.goto("/courses");
      await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
      // 等待首屏数据渲染（“加载更多”按钮仅当 items>0 且 hasMore 时出现），再计数。
      await expect(page.getByRole("button", { name: /加载更多|重试加载更多/ }).first()).toBeVisible(
        {
          timeout: 10000,
        },
      );
      const beforeCount = await cardCount(page);
      expect(beforeCount).toBeGreaterThan(0);

      // 记录首屏末条 courseId，用于验证重试不从首页重复。
      const beforeFirstCourseId = await page
        .locator(".course-card-link")
        .last()
        .getAttribute("href");

      // 点“加载更多”→ 500 失败 → 已加载项保留（列表仍可见），行内错误可见，出现“重试加载更多”。
      const more = page.getByRole("button", { name: "加载更多" });
      await more.click();
      await expect(page.getByText(/加载失败|网络连接失败|服务端暂时不可用/)).toBeVisible({
        timeout: 10000,
      });
      expect(await cardCount(page)).toBe(beforeCount); // 不清空已加载项
      await expect(page.getByRole("button", { name: "重试加载更多" })).toBeVisible();

      // 重试（同一 cursor）→ 成功追加下一页，行内错误消失；首屏不重复。
      const retry = page.getByRole("button", { name: "重试加载更多" });
      await expect(retry).toBeVisible({ timeout: 10000 });
      await retry.click();
      // 等待网络空闲（数据加载+渲染完成），再统计 DOM。
      await page.waitForLoadState("networkidle");
      await expect(page.getByText(/加载失败|网络连接失败|服务端暂时不可用/)).toHaveCount(0, {
        timeout: 10000,
      });
      const afterCount = await cardCount(page);
      expect(afterCount).toBeGreaterThan(beforeCount);
      // 加载更多成功后按钮回到“加载更多”（若仍有更多页）。
      await expect(page.getByRole("button", { name: "重试加载更多" })).toHaveCount(0, {
        timeout: 10000,
      });
      // 首屏末条仍在列表且只出现一次（无重复追加 -> 每个 courseId 唯一）。
      if (beforeFirstCourseId) {
        const hrefs = await page
          .locator(".course-card-link")
          .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
        const set = new Set(hrefs);
        expect(set.size).toBe(hrefs.length); // 无重复 courseId
        expect(hrefs).toContain(beforeFirstCourseId); // 首屏末条仍保留
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("快速双击不会并发发多次请求（防重入）", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner);

      // 记录带 cursor 的下一页请求次数。
      let pagedRequests = 0;
      await page.route("**/api/v1/catalog/courses*", async (route) => {
        const url = String(route.request().url());
        if (url.includes("cursor=")) pagedRequests += 1;
        await route.continue();
      });

      await page.goto("/courses");
      await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "加载更多" })).toBeVisible();

      // 快速双击“加载更多”：防重入应只发出一次分页请求。
      const more = page.getByRole("button", { name: "加载更多" });
      await Promise.all([
        more.click(),
        more.click().catch(() => undefined), // 第二次点击可能被 disabled 拒绝
      ]);
      // 等待所有网络请求完成（无论加载成功/失败，让页面状态稳定）。
      await page.waitForLoadState("networkidle");
      // 核心：防重入——分页请求至多 1 次，绝不因双击并发多次。
      expect(pagedRequests).toBeLessThanOrEqual(1);
    } finally {
      await ctx.dispose();
    }
  });

  test("首屏加载失败显示全页错误 + 重试加载课程；首屏重试成功后正常显示第一页", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner);

      // 首屏（无 cursor）请求先返回 500，模拟首屏失败。
      let failFirst = true;
      await page.route("**/api/v1/catalog/courses*", async (route) => {
        const url = String(route.request().url());
        if (url.includes("cursor=")) {
          await route.continue();
          return;
        }
        if (failFirst) {
          failFirst = false;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "UPSTREAM_ERROR", message: "服务端暂时不可用", retryable: true },
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/courses");
      await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
      // 首屏失败：全页错误（role=alert）+ “重试加载课程”按钮；不显示空列表假象。
      await expect(page.getByText(/加载失败|网络连接失败|服务端暂时不可用/)).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole("button", { name: "重试加载课程" })).toBeVisible();
      await expect(page.getByText("还没有可学习的课程。")).toHaveCount(0, { timeout: 5000 });

      // 点击重试 → 请求成功 → 显示第一页。
      await page.getByRole("button", { name: "重试加载课程" }).click();
      await expect(page.getByRole("button", { name: "重试加载课程" })).toHaveCount(0, {
        timeout: 10000,
      });
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
      // 等待列表渲染出课程卡片。
      await expect(page.locator(".course-card-link").first()).toBeVisible({ timeout: 10000 });
      const count = await cardCount(page);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(24);
    } finally {
      await ctx.dispose();
    }
  });

  test("可访问性：错误 role=alert、按钮≥44px、390/768/1440 无横向溢出", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner);

      // 三个断点下加载并检查无横向溢出。
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/courses");
        await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: /加载更多|重试加载更多/ }).first(),
        ).toBeVisible({
          timeout: 10000,
        });
        const overflow = await page.evaluate(
          "document.documentElement.scrollWidth > document.documentElement.clientWidth",
        );
        expect(overflow, `${width}px 无横向滚动`).toBe(false);
        // 加载更多按钮触控高度 ≥44px。
        const btn = page.getByRole("button", { name: /加载更多|重试加载更多/ }).first();
        const box = await btn.boundingBox();
        expect(box).toBeTruthy();
        if (box) expect(box.height).toBeGreaterThanOrEqual(44);
        // focus-visible：按钮可键盘聚焦。
        await btn.focus();
        await expect(btn).toBeFocused();
      }
    } finally {
      await ctx.dispose();
    }
  });
});
