// 课程发布 E2E：校验后确认发布不可变版本、版本历史与当前标记、刷新后仍存在、
// 重新发布版本 2 并切换当前版本指针。需要运行中的 API + PostgreSQL（compose 环境）。
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

async function createValidCourse(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ courseId: string; unitId: string; itemId: string }> {
  const slug = `e2e-pub-${Date.now()}`;
  const create = await ctx.post("/api/v1/admin/courses", {
    headers: { "x-csrf-token": csrf },
    data: { slug, title: `发布课程 ${Date.now()}`, level: "a1", description: "课程描述" },
  });
  expect(create.status()).toBe(201);
  const { courseId, draftVersion } = (await create.json()) as {
    courseId: string;
    draftVersion: number;
  };

  const entry = await ctx.post("/api/v1/admin/lexical-entries", {
    headers: { "x-csrf-token": csrf },
    data: { canonicalSpelling: `e2e-pub-word-${Date.now()}`, confirmDuplicate: false },
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
  expect(item.status()).toBe(201);

  return { courseId, unitId, itemId };
}

test.describe("admin course publishing", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("校验后确认发布版本 1，历史与当前标记刷新后仍存在", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createValidCourse(ctx, csrf);
      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await page.getByRole("button", { name: "校验课程" }).click();
      await expect(page.getByText("草稿可发布")).toBeVisible();

      await page.getByLabel(/发布说明/).fill("首个版本");
      // 接受确认对话框（不可修改 + 版本号）。
      const dialogPromise = page.waitForEvent("dialog");
      const clickPromise = page.getByRole("button", { name: "发布版本" }).click();
      const dialog = await dialogPromise;
      await expect(dialog.message()).toContain("不可修改");
      await dialog.accept();
      await clickPromise;

      await expect(page.getByText(/已创建不可修改的版本 1/)).toBeVisible();
      await expect(page.getByText("版本 1", { exact: true })).toBeVisible();
      await expect(page.getByText(/当前版本/)).toBeVisible();
      await expect(page.getByText(/首个版本/)).toBeVisible();

      // 刷新后历史仍存在。
      await page.reload();
      await page.getByRole("button", { name: "校验课程" }).click();
      await expect(page.getByText("版本 1", { exact: true })).toBeVisible();
      await expect(page.getByText(/当前版本/)).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });

  test("修改草稿后重新发布版本 2，并切换当前版本回版本 1", async ({ page, playwright }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId, itemId } = await createValidCourse(ctx, csrf);

      // 发布版本 1。
      const draft1 = (await (await ctx.get(`/api/v1/admin/courses/${courseId}/draft`)).json()) as {
        version: number;
      };
      await ctx.post(`/api/v1/admin/courses/${courseId}/releases`, {
        headers: { "x-csrf-token": csrf, "idempotency-key": `pub-v1-${Date.now()}` },
        data: { draftVersion: draft1.version, releaseNote: "版本一" },
      });

      // 修改释义 → 草稿版本递增。
      const draft2 = (await (await ctx.get(`/api/v1/admin/courses/${courseId}/draft`)).json()) as {
        version: number;
      };
      const patch = await ctx.patch(`/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
        headers: { "x-csrf-token": csrf },
        data: { meaning: "坚持", draftVersion: draft2.version },
      });
      expect(patch.status()).toBe(200);

      // UI 校验并发布版本 2。
      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await page.getByRole("button", { name: "校验课程" }).click();
      await expect(page.getByText("草稿可发布")).toBeVisible();
      const dialogPromise = page.waitForEvent("dialog");
      const clickPromise = page.getByRole("button", { name: "发布版本" }).click();
      await (await dialogPromise).accept();
      await clickPromise;
      await expect(page.getByText(/已创建不可修改的版本 2/)).toBeVisible();

      // 切回版本 1（版本 2 是当前版本，故「设为当前版本」出现在版本 1 上）。
      const switchDialog = page.waitForEvent("dialog");
      const switchPromise = page.getByRole("button", { name: "设为当前版本" }).first().click();
      await (await switchDialog).accept();
      await switchPromise;

      // 版本 1 成为当前版本，且仍有 2 个版本。
      await expect(page.getByText("版本 1", { exact: true })).toBeVisible();
      await expect(page.getByText("版本 2", { exact: true })).toBeVisible();
      const history = (await (
        await ctx.get(`/api/v1/admin/courses/${courseId}/releases`)
      ).json()) as {
        items: { releaseNumber: number; isCurrent: boolean }[];
      };
      expect(history.items.find((r) => r.releaseNumber === 1)?.isCurrent).toBe(true);
      expect(history.items.find((r) => r.releaseNumber === 2)?.isCurrent).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});
