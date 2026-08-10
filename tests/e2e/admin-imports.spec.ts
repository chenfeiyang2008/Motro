// 管理端导入 E2E（阶段 6 工单 01）：管理员上传原始文件 → 创建批次；非法文件保留就地错误；
// 390/768/1440 无横向溢出。需要运行中的 API + PostgreSQL（compose）。API 不可达时跳过。
import { expect, test, type Page } from "@playwright/test";

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

async function loginAsAdminAndGotoImports(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
  await page.getByLabel("用户名").fill(ADMIN_USER);
  await page.getByLabel("密码").fill(ADMIN_PASS);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/change-password|\/app/, { timeout: 15000 });
  if (page.url().includes("change-password")) {
    // 首登改密已在既有 E2E 覆盖；这里如果命中改密页则完成改密流程。
    await page.getByLabel(/当前密码/).fill(ADMIN_PASS);
    await page.getByLabel(/^新密码/).fill(`${ADMIN_PASS}${ADMIN_PASS}`);
    await page.getByLabel(/确认新密码/).fill(`${ADMIN_PASS}${ADMIN_PASS}`);
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page).toHaveURL(/\/app/);
  }
  await page.goto("/admin/imports");
  await expect(page.locator("h1", { hasText: "导入" })).toBeVisible();
}

test.describe("admin imports", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("管理员上传 txt → 创建批次并显示文件元数据", async ({ page }) => {
    await loginAsAdminAndGotoImports(page);

    // 唯一主操作“上传并创建批次”。
    const uploadBtn = page.getByRole("button", { name: "上传并创建批次" });
    await expect(uploadBtn).toBeVisible();

    // 选择一个 txt 文件并填来源声明。
    const fileName = `e2e-${Date.now()}.txt`;
    await page.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`apple\nbanana\n${Date.now()}\n`),
    });
    await page.getByLabel("来源声明").fill("E2E 测试来源");
    await uploadBtn.click();

    // 成功提示 + 批次出现（按唯一文件名定位行）。
    await expect(page.getByText("上传成功，已创建批次。")).toBeVisible();
    const row = page.getByText(fileName, { exact: true });
    await expect(row).toBeVisible({ timeout: 15000 });
    // 批次详情页可打开并显示来源声明与状态。
    await row.click();
    await expect(page.getByRole("heading", { name: "导入批次" })).toBeVisible();
    await expect(page.getByText("E2E 测试来源", { exact: true })).toBeVisible();
    await expect(page.getByText("uploaded", { exact: true })).toBeVisible();
  });

  test("上传非法扩展名 → 就地错误，不创建批次，不跳到详情", async ({ page }) => {
    await loginAsAdminAndGotoImports(page);
    const uploadBtn = page.getByRole("button", { name: "上传并创建批次" });
    await page.setInputFiles("#import-file", {
      name: `bad-${Date.now()}.exe`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    });
    await page.getByLabel("来源声明").fill("E2E 非法文件");
    await uploadBtn.click();

    // 就地错误提示（不跳详情页）。
    await expect(page.getByRole("alert")).toBeVisible();
    // 仍停留在导入页。
    await expect(page).toHaveURL(/\/admin\/imports$/);
    await expect(page.locator("h1", { hasText: "导入" })).toBeVisible();
  });

  test("390/768/1440px 导入页无横向溢出", async ({ page }) => {
    await loginAsAdminAndGotoImports(page);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 导入页无横向滚动`).toBe(false);
    }
  });

  test("P1-5 服务端已提交但客户端丢失响应后重试：复用同一 Idempotency-Key，只产生一个批次", async ({
    page,
  }) => {
    await loginAsAdminAndGotoImports(page);
    const uploadBtn = page.getByRole("button", { name: "上传并创建批次" });
    const fileName = `retry-${Date.now()}.txt`;
    await page.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`retry-word-${Date.now()}\n`),
    });
    await page.getByLabel("来源声明").fill("E2E 重试来源");

    // P1-5：第一次请求确实到达服务端并创建批次，但客户端“丢失”响应（route.fetch 已发送，
    // 却不 continue/fulfill，浏览器收不到成功响应）。第二次放行。
    let firstLost = true;
    const seenKeys: string[] = [];
    let requests = 0;
    await page.route("**/api/v1/admin/imports", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests++;
      const key = route.request().headers()["idempotency-key"];
      if (key) seenKeys.push(key);
      if (firstLost) {
        firstLost = false;
        // 先把请求真正发到服务端（会创建 batch），再把响应“丢弃”：abort 让浏览器端
        // 收到网络错误，从而页面会进入可重试状态——但服务端已提交。
        await route.fetch();
        await route.abort("connectionclosed");
        return;
      }
      await route.continue();
    });

    await uploadBtn.click();
    // 第一次失败（响应丢失）→ 出现“重新上传”与可重试提示。
    await expect(page.getByRole("button", { name: "重新上传" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/网络中断或响应丢失/)).toBeVisible();

    // 重试 → 成功。注意：第一次已在服务端创建批次，重试（同 key）应复用，返回 200。
    await page.getByRole("button", { name: "重新上传" }).click();
    // 页面成功展示批次；只应有一个批次（同 key 幂等，不重复创建）。
    await expect(page.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });

    // 两次请求 key 相同。
    expect(requests).toBe(2);
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);

    // P2-2：批次表只出现该文件一次（同 key 幂等，不重复创建）。
    await expect(page.getByText(fileName, { exact: true })).toHaveCount(1);
  });
});
