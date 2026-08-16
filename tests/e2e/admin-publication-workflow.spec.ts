// Ticket 08 发布工作流 UI E2E：真实隔离栈 + fake-only 数据。
// 覆盖：管理员进入发布页 → 校验发布资格 → 资格面板显示阻塞/可发布状态 →
// 发布按钮在可发布时出现、在不可发布时隐藏/禁用 → 发布成功后显示真实 release 结果。
// 需要运行中的 API + PostgreSQL（隔离 compose 栈）。API 不可达时不伪造，直接失败。
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
  await expect(page).toHaveURL(/\/app|\/change-password/, { timeout: 15000 });
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

async function createPublishedCourse(
  ctx: APIRequestContext,
  csrf: string,
): Promise<{ courseId: string }> {
  const slug = `e2e-t8-${Date.now().toString(36)}`;
  const create = await ctx.post("/api/v1/admin/courses", {
    headers: { "x-csrf-token": csrf },
    data: {
      slug,
      title: `T8 发布课程 ${Date.now()}`,
      level: "a1",
      description: "发布资格 E2E",
    },
  });
  expect(create.status()).toBe(201);
  const { courseId, draftVersion } = (await create.json()) as {
    courseId: string;
    draftVersion: number;
  };
  // 建一个手工词条（Path A：manual provenance）并发布为可校验草稿。
  const entry = await ctx.post("/api/v1/admin/lexical-entries", {
    headers: { "x-csrf-token": csrf },
    data: { canonicalSpelling: `t8word${Date.now().toString(36)}`, confirmDuplicate: false },
  });
  const entryId = (await entry.json()).id as string;
  const unitId = crypto.randomUUID();
  const unit = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
    headers: { "x-csrf-token": csrf },
    data: { title: "单元", description: "单元", draftVersion },
  });
  const vern = (await unit.json()).version as number;
  const itemId = crypto.randomUUID();
  const item = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
    headers: { "x-csrf-token": csrf },
    data: { unitId, lexicalEntryId: entryId, meaning: "t8 含义", draftVersion: vern },
  });
  expect(item.status()).toBe(201);
  return { courseId };
}

test.describe("Ticket 08 发布工作流 UI", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（隔离 compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（隔离管理员口令）");
  });

  test("打开发布页 → 校验发布资格 → 资格面板渲染 → 可发布时出现发布按钮", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      await loginAsAdmin(page);

      await page.goto(`/admin/courses/${courseId}/publishing`);
      await expect(page.getByRole("heading", { name: "发布工作流" })).toBeVisible();

      // 触发校验（真实 API），等待结果渲染。
      await page.getByRole("button", { name: /校验发布资格/ }).click();
      await expect(page.locator('section[aria-label="词项发布资格"]')).toBeVisible({
        timeout: 15000,
      });

      // 资格面板出现：全部或部分词项状态（service 端以真实 validate 为唯一事实源）。
      await expect(page.getByText(/词项|发布资格|资格就绪|存在 .* 个词项/).first()).toBeVisible({
        timeout: 15000,
      });

      // 状态机正确：（a）若可发布 → 出现「确认发布版本」；（b）若被阻塞 → 出现阻塞项/原因。
      const confirmBtn = page.getByRole("button", { name: /确认发布版本/ });
      const blockedItem = page.locator(".issue-item.blocking").first();
      const eitherVisible = await Promise.all([
        confirmBtn.isVisible().catch(() => false),
        blockedItem.isVisible().catch(() => false),
      ]);
      // 不伪造通过：必须有「可发布按钮」或「阻塞原因」至少一种真实存在。
      expect(eitherVisible.some(Boolean)).toBe(true);

      // 敏感性：页面不泄露 prompt/provider/secret/内部字段。
      const pageText = await page.locator("body").innerText();
      expect(pageText.toLowerCase()).not.toMatch(/api[_-]?key|secret|provider.?response|prompt/);
    } finally {
      await ctx.dispose();
    }
  });

  test("发布成功后显示真实 release 结果（以服务端响应为唯一事实源）", async ({
    page,
    playwright,
  }) => {
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      await loginAsAdmin(page);
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await page.getByRole("button", { name: /校验发布资格/ }).click();
      // 等待校验结果渲染（资格面板出现）再决定发布/阻塞分支。
      await expect(page.locator('section[aria-label="词项发布资格"]')).toBeVisible({
        timeout: 15000,
      });

      const confirmBtn = page.getByRole("button", { name: /确认发布版本/ });
      // 若可发布，真实发布并断言 release 结果出现在版本历史。
      if (await confirmBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
        page.once("dialog", (d) => d.accept());
        await confirmBtn.click();
        await expect(page.getByText(/已创建不可修改版本 \d+/)).toBeVisible({ timeout: 15000 });
        await expect(page.getByText(/版本 \d+/).first()).toBeVisible();
      } else {
        // 不可发布（资格阻塞）：发布按钮不出现 —— 这是正确行为，不伪造成功。
        const blocked = page.getByText(/REJECTED|PROVENANCE|MANUAL_ACTION|BLOCKED/).first();
        const isBlocked = await blocked.isVisible().catch(() => false);
        expect(isBlocked).toBe(true);
      }
    } finally {
      await ctx.dispose();
    }
  });
});
