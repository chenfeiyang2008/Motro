// 认证 Web 闭环 E2E：管理员创建学习者 → 一次性密码登录 → 强制改密 → 刷新保持 → 登出后受保护页拒绝。
// 需要运行中的 API + PostgreSQL（compose 环境，见 compose/README.md）。API 不可达时自动跳过。
import { expect, test } from "@playwright/test";

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

test.describe("auth web loop", () => {
  test("管理员创建学习者并走完登录→改密→刷新→登出闭环", async ({ page, playwright }) => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");

    // 1. 管理员经 API 登录，创建学习者（独立 API 上下文，cookie 与浏览器隔离）。
    const adminCtx = await playwright.request.newContext({ baseURL: API });
    await adminCtx.get("/api/v1/health/live");
    const state = await adminCtx.storageState();
    const csrf = state.cookies.find((c) => c.name === "motro_csrf")?.value ?? "";
    const login = await adminCtx.post("/api/v1/auth/login", {
      headers: { "x-csrf-token": csrf },
      data: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    expect(login.status()).toBe(200);

    const username = `e2e-${Date.now()}`;
    const create = await adminCtx.post("/api/v1/admin/users", {
      headers: { "x-csrf-token": csrf, "idempotency-key": `e2e-create-${username}` },
      data: {
        username,
        displayName: "E2E 学习者",
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(create.status()).toBe(201);
    const { oneTimePassword } = (await create.json()) as { oneTimePassword: string };

    // 2. 一次性密码登录 → 强制进入改密页。
    //    每个页面先等标题（React 水合完成）再填写，避免水合重置受控输入。
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码").fill(oneTimePassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/);
    await expect(page.getByRole("heading", { name: "修改密码" })).toBeVisible();

    // 3. 改密成功后进入受保护页。
    await page.getByLabel(/当前密码/).fill(oneTimePassword);
    await page.getByLabel(/^新密码/).fill("e2e-strong-password-123");
    await page.getByLabel(/确认新密码/).fill("e2e-strong-password-123");
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page).toHaveURL(/\/app/);
    await expect(page.getByRole("heading", { name: "学习仪表盘" })).toBeVisible();

    // 4. 刷新后会话保持。
    await page.reload();
    await expect(page.getByRole("heading", { name: "学习仪表盘" })).toBeVisible();

    // 5. 登出后受保护页拒绝并回登录页。
    await page.getByRole("button", { name: "登出", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);
  });

  test("无效凭证显示不泄露敏感信息的错误", async ({ page }) => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    await page.goto("/login");
    await page.getByLabel("用户名").fill("nobody");
    await page.getByLabel("密码").fill("wrong-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".auth-error")).toContainText(/用户名或密码错误/);
  });
});
