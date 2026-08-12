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
    // 详情页校验状态列显示中文标签（not_validated → 待校验）。
    await expect(page.getByText("待校验", { exact: true })).toBeVisible();
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

    // 就地错误提示（不跳详情页）。限定到实际的 .form-error 错误元素，避免 Next.js
    // route-announcer（也带 role="alert"）造成严格模式歧义。
    await expect(page.locator(".form-error", { hasText: "不支持的文件格式" })).toBeVisible();
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

  test("工单02 TXT 最短成功路径：上传 → 详情 → 开始校验 → 校验摘要与行表", async ({ page }) => {
    await loginAsAdminAndGotoImports(page);

    // 上传一个 TXT 文件。
    const uploadBtn = page.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-val-${Date.now()}.txt`;
    const suffix = Date.now();
    await page.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`apple-${suffix}\nbanana-${suffix}\n\ncherry-${suffix}\n`),
    });
    await page.getByLabel("来源声明").fill("E2E 校验来源");
    await uploadBtn.click();
    await expect(page.getByText("上传成功，已创建批次。")).toBeVisible();
    const row = page.getByText(fileName, { exact: true });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();

    // 详情页：TXT 显示固定规则说明（无需映射），唯一主操作「开始校验」。
    await expect(page.getByRole("heading", { name: "导入批次" })).toBeVisible();
    await expect(page.getByText(/每行一个词/)).toBeVisible();
    const startValidate = page.getByRole("button", { name: "开始校验" });
    await startValidate.click();

    // 校验成功 → 校验摘要 + 行表。
    await expect(page.getByText("校验摘要")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("有效候选")).toBeVisible();
    await expect(page.getByText("行结果")).toBeVisible();
    // 提交有效行是后续工单位置（disabled）。
    await expect(page.getByRole("button", { name: /提交有效行/ })).toBeDisabled();
    // 行表出现 apple / banana / cherry（原始值与规范化列都展示同一词，用 .first() 避免严格模式歧义）。
    await expect(page.getByText(`apple-${suffix}`, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(`cherry-${suffix}`, { exact: true }).first()).toBeVisible();
  });

  test("工单02 CSV：确认映射后校验；映射错误就地修复", async ({ page }) => {
    await loginAsAdminAndGotoImports(page);

    const uploadBtn = page.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-csv-${Date.now()}.csv`;
    const csvSuffix = Date.now();
    await page.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/csv",
      buffer: Buffer.from(`word,note\napple-${csvSuffix},fruit\nbanana-${csvSuffix},fruit\n`),
    });
    await page.getByLabel("来源声明").fill("E2E CSV 来源");
    await uploadBtn.click();
    await expect(page.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByText(fileName, { exact: true }).click();

    // CSV 需映射：选择字段后保存映射，再开始校验。
    await expect(page.getByRole("heading", { name: "导入批次" })).toBeVisible();
    const fieldSelect = page.getByLabel("英文拼写字段");
    await fieldSelect.selectOption({ label: "word" });
    await page.getByRole("button", { name: "保存映射" }).click();
    await page.getByRole("button", { name: "开始校验" }).click();
    await expect(page.getByText("校验摘要")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: /提交有效行/ })).toBeDisabled();
  });

  test("工单02 390/768/1440px 批次详情无横向溢出", async ({ page }) => {
    await loginAsAdminAndGotoImports(page);
    const uploadBtn = page.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-overflow-${Date.now()}.txt`;
    await page.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`overflow-word-${Date.now()}\n`),
    });
    await page.getByLabel("来源声明").fill("E2E 溢出来源");
    await uploadBtn.click();
    await expect(page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByText(fileName, { exact: true }).click();
    await expect(page.getByRole("heading", { name: "导入批次" })).toBeVisible();

    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 批次详情无横向滚动`).toBe(false);
    }
  });

  test("P1-4 JSON 字符串数组最短路径：无需字段映射，直接开始校验", async ({ page }) => {
    await loginAsAdminAndGotoImports(page);
    const uploadBtn = page.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-jsonarr-${Date.now()}.json`;
    const jSuffix = Date.now();
    await page.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "application/json",
      buffer: Buffer.from(`["apple-${jSuffix}","banana-${jSuffix}","cherry-${jSuffix}"]`),
    });
    await page.getByLabel("来源声明").fill("E2E JSON 数组来源");
    await uploadBtn.click();
    await expect(page.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByText(fileName, { exact: true }).click();

    // 详情页：显示 JSON 字符串数组说明，无字段选择器。
    await expect(page.getByRole("heading", { name: "导入批次" })).toBeVisible();
    await expect(page.getByText(/每个字符串会作为一个英文词条候选/)).toBeVisible();
    await expect(page.getByLabel("英文拼写字段")).toHaveCount(0);

    // 唯一主操作「开始校验」无需先选字段即可用（P1-4）。
    const startValidate = page.getByRole("button", { name: "开始校验" });
    await expect(startValidate).toBeEnabled();
    await startValidate.click();

    // 校验成功 → 校验摘要 + 行表含 apple/banana/cherry。
    await expect(page.getByText("校验摘要")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("行结果")).toBeVisible();
    await expect(page.getByText(`apple-${jSuffix}`, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(`banana-${jSuffix}`, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(`cherry-${jSuffix}`, { exact: true }).first()).toBeVisible();
  });
});
