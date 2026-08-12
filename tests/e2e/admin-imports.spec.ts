// 管理端导入 E2E（阶段 6 工单 01 + 03）：管理员上传原始文件 → 创建批次 → 校验 → 提交有效行；
// 非法文件保留就地错误；390/768/1440 无横向溢出。
//
// 运行环境（P1-4）：本 spec 必须运行在【独立 E2E 数据库】上（compose/e2e-import.yml 的
// motro_e2e_import），因为提交批次会产生不可变 commit facts（import_batch_commits /
// import_batch_commit_rows，BEFORE DELETE trigger 拒绝删除）。在共享开发库上删除这些事实必须
// 绕过触发器/FK（被禁止）。独立库由 runbook（README「导入 E2E 运行说明」）启动，并在结束后
// 用 `docker compose -f compose/e2e-import.yml down -v` 整体销毁。
//
// 若未检测到独立 E2E 数据库，本 spec 直接失败（不静默降级到共享库）。
import { readFileSync, rmSync } from "node:fs";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { createIsolatedAdmin, adminUsernameFor, stateFileFor } from "./auth-setup.js";
import { cleanupIsolatedAdmin, type ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName } from "./import-e2e-db.js";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";
// 独立 E2E 数据库名（runbook 设置；未设置 → 本 spec 直接失败，绝不回退共享库）。
const E2E_DB = process.env.E2E_IMPORT_DB ?? "";

let apiUp = false;
// 每个 project 使用独立管理员与 state 文件（并发时互不抢占）。
const projectAdmins = new Map<string, ImportTestAdmin>();
const projectPromises = new Map<string, Promise<ImportTestAdmin>>();
const projectStateFiles = new Map<string, string>();
// 当前 worker 所属 project（beforeAll 按 worker 记录，供 afterAll 使用）。
let currentProjectName = "unknown";

/** 返回本项目专属 state 文件路径。 */
function stateFileForProject(project: string): string {
  let f = projectStateFiles.get(project);
  if (!f) {
    f = stateFileFor(project);
    projectStateFiles.set(project, f);
  }
  return f;
}

/** 只创建一次本项目隔离管理员（供 adminPage fixture 与 afterAll 复用）。 */
async function ensureIsolatedAdmin(browser: Browser, project: string): Promise<ImportTestAdmin> {
  const existing = projectAdmins.get(project);
  if (existing) return existing;
  let p = projectPromises.get(project);
  if (!p) {
    const username = adminUsernameFor(project);
    const stateFile = stateFileForProject(project);
    p = createIsolatedAdmin(browser, stateFile, username).then((a) => {
      projectAdmins.set(project, a);
      return a;
    });
    projectPromises.set(project, p);
  }
  return p;
}

/**
 * 自定义 fixture：为每个测试创建基于本项目隔离管理员 storageState 的已认证 page。
 * 不使用 test.use({ storageState })，避免 worker 启动时读取尚未生成的状态文件。
 */
const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser }, use, testInfo) => {
    test.skip(!apiUp && process.env.MOTRO_REQUIRE_DB !== "1", "需要运行中的 API 与数据库");
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD");
    const project = testInfo.project.name;
    await ensureIsolatedAdmin(browser, project);
    const context = await browser.newContext({ storageState: stateFileForProject(project) });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

async function loginAsAdminAndGotoImports(page: Page): Promise<void> {
  // storageState 已注入会话，直接跳转到导入页。
  await page.goto("/admin/imports");
  await expect(page.locator("h1", { hasText: "导入" })).toBeVisible();
}

test.describe("admin imports", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    // P1-4：必须运行在独立 E2E 数据库。未配置 → 直接失败（不静默降级共享库）。
    if (!E2E_DB) {
      throw new Error(
        "admin-imports E2E 必须运行在独立 E2E 数据库（E2E_IMPORT_DB）。请使用 runbook：" +
          "docker compose -f compose/e2e-import.yml up -d --build，并设置 E2E_IMPORT_DB。",
      );
    }
    assertSafeDbName(E2E_DB);
    currentProjectName = testInfo.project.name;
    try {
      const res = await fetch(`${API}/api/v1/health/live`);
      apiUp = res.ok;
    } catch {
      apiUp = false;
    }
    // 预创建本项目隔离管理员并写入本项目 storageState（供 adminPage fixture 使用）。
    if (apiUp && ADMIN_PASS !== "") {
      await ensureIsolatedAdmin(browser, currentProjectName);
    }
  });

  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test.afterAll(async () => {
    // 仅清理本项目创建的隔离管理员及其测试数据。
    // P1-3：清理失败必须令 E2E 失败（不吞异常、不报告通过）。
    // project 名在 beforeAll 中按 worker 记录（afterAll 无 testInfo 参数）。
    const project = currentProjectName;
    const admin = projectAdmins.get(project);
    if (admin) {
      await cleanupIsolatedAdmin(admin);
      projectAdmins.delete(project);
    }
    // 只移除本项目的会话状态文件（不删其他项目文件）。
    rmSync(stateFileForProject(project), { force: true });
  });

  test("管理员上传 txt → 创建批次并显示文件元数据", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);

    // 唯一主操作“上传并创建批次”。
    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    await expect(uploadBtn).toBeVisible();

    // 选择一个 txt 文件并填来源声明。
    const fileName = `e2e-${Date.now()}.txt`;
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`apple\nbanana\n${Date.now()}\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 测试来源");
    await uploadBtn.click();

    // 成功提示 + 批次出现（按唯一文件名定位行）。
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    const row = adminPage.getByText(fileName, { exact: true });
    await expect(row).toBeVisible({ timeout: 15000 });
    // 批次详情页可打开并显示来源声明与状态。
    await row.click();
    await expect(adminPage.getByRole("heading", { name: "导入批次" })).toBeVisible();
    await expect(adminPage.getByText("E2E 测试来源", { exact: true })).toBeVisible();
    // 详情页校验状态列显示中文标签（not_validated → 待校验）。
    await expect(adminPage.getByText("待校验", { exact: true })).toBeVisible();
  });

  test("上传非法扩展名 → 就地错误，不创建批次，不跳到详情", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);
    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    await adminPage.setInputFiles("#import-file", {
      name: `bad-${Date.now()}.exe`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 非法文件");
    await uploadBtn.click();

    // 就地错误提示（不跳详情页）。限定到实际的 .form-error 错误元素，避免 Next.js
    // route-announcer（也带 role="alert"）造成严格模式歧义。
    await expect(adminPage.locator(".form-error", { hasText: "不支持的文件格式" })).toBeVisible();
    // 仍停留在导入页。
    await expect(adminPage).toHaveURL(/\/admin\/imports$/);
    await expect(adminPage.locator("h1", { hasText: "导入" })).toBeVisible();
  });

  test("390/768/1440px 导入页无横向溢出", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);
    for (const width of [390, 768, 1440]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const overflow = await adminPage.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 导入页无横向滚动`).toBe(false);
    }
  });

  test("P1-5 服务端已提交但客户端丢失响应后重试：复用同一 Idempotency-Key，只产生一个批次", async ({
    adminPage,
  }) => {
    await loginAsAdminAndGotoImports(adminPage);
    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `retry-${Date.now()}.txt`;
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`retry-word-${Date.now()}\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 重试来源");

    // P1-5：第一次请求确实到达服务端并创建批次，但客户端“丢失”响应（route.fetch 已发送，
    // 却不 continue/fulfill，浏览器收不到成功响应）。第二次放行。
    let firstLost = true;
    const seenKeys: string[] = [];
    let requests = 0;
    await adminPage.route("**/api/v1/admin/imports", async (route) => {
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
    await expect(adminPage.getByRole("button", { name: "重新上传" })).toBeVisible({
      timeout: 15000,
    });
    await expect(adminPage.getByText(/网络中断或响应丢失/)).toBeVisible();

    // 重试 → 成功。注意：第一次已在服务端创建批次，重试（同 key）应复用，返回 200。
    await adminPage.getByRole("button", { name: "重新上传" }).click();
    // 页面成功展示批次；只应有一个批次（同 key 幂等，不重复创建）。
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });

    // 两次请求 key 相同。
    expect(requests).toBe(2);
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);

    // P2-2：批次表只出现该文件一次（同 key 幂等，不重复创建）。
    await expect(adminPage.getByText(fileName, { exact: true })).toHaveCount(1);
  });

  test("工单02 TXT 最短成功路径：上传 → 详情 → 开始校验 → 校验摘要与行表", async ({
    adminPage,
  }) => {
    await loginAsAdminAndGotoImports(adminPage);

    // 上传一个 TXT 文件。
    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-val-${Date.now()}.txt`;
    const suffix = Date.now();
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`apple-${suffix}\nbanana-${suffix}\n\ncherry-${suffix}\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 校验来源");
    await uploadBtn.click();
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    const row = adminPage.getByText(fileName, { exact: true });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();

    // 详情页：TXT 显示固定规则说明（无需映射），唯一主操作「开始校验」。
    await expect(adminPage.getByRole("heading", { name: "导入批次" })).toBeVisible();
    await expect(adminPage.getByText(/每行一个词/)).toBeVisible();
    const startValidate = adminPage.getByRole("button", { name: "开始校验" });
    await startValidate.click();

    // 校验成功 → 校验摘要 + 行表。
    await expect(adminPage.getByText("校验摘要")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText("有效候选", { exact: true })).toBeVisible();
    await expect(adminPage.getByText("行结果")).toBeVisible();
    // 提交有效行现在是可用的主操作（工单 03）。
    await expect(adminPage.getByRole("button", { name: /提交有效行/ })).toBeEnabled();
    // 行表出现 apple / banana / cherry（原始值与规范化列都展示同一词，用 .first() 避免严格模式歧义）。
    await expect(adminPage.getByText(`apple-${suffix}`, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(adminPage.getByText(`cherry-${suffix}`, { exact: true }).first()).toBeVisible();
  });

  test("工单02 CSV：确认映射后校验；映射错误就地修复", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);

    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-csv-${Date.now()}.csv`;
    const csvSuffix = Date.now();
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/csv",
      buffer: Buffer.from(`word,note\napple-${csvSuffix},fruit\nbanana-${csvSuffix},fruit\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E CSV 来源");
    await uploadBtn.click();
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await adminPage.getByText(fileName, { exact: true }).click();

    // CSV 需映射：选择字段后保存映射，再开始校验。
    await expect(adminPage.getByRole("heading", { name: "导入批次" })).toBeVisible();
    const fieldSelect = adminPage.getByLabel("英文拼写字段");
    await fieldSelect.selectOption({ label: "word" });
    await adminPage.getByRole("button", { name: "保存映射" }).click();
    await adminPage.getByRole("button", { name: "开始校验" }).click();
    await expect(adminPage.getByText("校验摘要")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByRole("button", { name: /提交有效行/ })).toBeEnabled();
  });

  test("工单02 390/768/1440px 批次详情无横向溢出", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);
    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-overflow-${Date.now()}.txt`;
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`overflow-word-${Date.now()}\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 溢出来源");
    await uploadBtn.click();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await adminPage.getByText(fileName, { exact: true }).click();
    await expect(adminPage.getByRole("heading", { name: "导入批次" })).toBeVisible();

    for (const width of [390, 768, 1440]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const overflow = await adminPage.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 批次详情无横向滚动`).toBe(false);
    }
  });

  test("P1-4 JSON 字符串数组最短路径：无需字段映射，直接开始校验", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);
    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-jsonarr-${Date.now()}.json`;
    const jSuffix = Date.now();
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "application/json",
      buffer: Buffer.from(`["apple-${jSuffix}","banana-${jSuffix}","cherry-${jSuffix}"]`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E JSON 数组来源");
    await uploadBtn.click();
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await adminPage.getByText(fileName, { exact: true }).click();

    // 详情页：显示 JSON 字符串数组说明，无字段选择器。
    await expect(adminPage.getByRole("heading", { name: "导入批次" })).toBeVisible();
    await expect(adminPage.getByText(/每个字符串会作为一个英文词条候选/)).toBeVisible();
    await expect(adminPage.getByLabel("英文拼写字段")).toHaveCount(0);

    // 唯一主操作「开始校验」无需先选字段即可用（P1-4）。
    const startValidate = adminPage.getByRole("button", { name: "开始校验" });
    await expect(startValidate).toBeEnabled();
    await startValidate.click();

    // 校验成功 → 校验摘要 + 行表含 apple/banana/cherry。
    await expect(adminPage.getByText("校验摘要")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText("行结果")).toBeVisible();
    await expect(adminPage.getByText(`apple-${jSuffix}`, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(adminPage.getByText(`banana-${jSuffix}`, { exact: true }).first()).toBeVisible();
    await expect(adminPage.getByText(`cherry-${jSuffix}`, { exact: true }).first()).toBeVisible();
  });

  test("工单03 提交有效行：校验 → 摘要 → 下载错误报告 → 仅提交有效行 → 提交结果保留", async ({
    adminPage,
  }) => {
    await loginAsAdminAndGotoImports(adminPage);

    // 上传一个混合文件：有效词 + 非法（数字）+ 文件内重复。
    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-commit-${Date.now()}.txt`;
    const suffix = Date.now();
    const word = `commit-word-${suffix}`;
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`${word}\n1234\n${word}\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 提交来源");
    await uploadBtn.click();
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await adminPage.getByText(fileName, { exact: true }).click();

    // 校验。
    await expect(adminPage.getByRole("heading", { name: "导入批次" })).toBeVisible();
    await adminPage.getByRole("button", { name: "开始校验" }).click();
    await expect(adminPage.getByText("校验摘要")).toBeVisible({ timeout: 15000 });

    // 校验摘要显示有效候选数（word 第 1 次出现；1234 与重复行不计）。
    await expect(adminPage.getByRole("heading", { name: "提交有效行" })).toBeVisible();
    // 错误报告下载按钮出现；数量 = invalid(1) + duplicate(1) = 2。
    const reportBtn = adminPage.getByRole("button", { name: /下载错误报告（\d+ 行）/ });
    await expect(reportBtn).toBeVisible();
    await expect(reportBtn).toHaveText(/下载错误报告（2 行）/);
    // 下载错误报告（拦截下载），验证内容含 invalid 与 duplicate、不含 candidate。
    const downloadPromise = adminPage.waitForEvent("download");
    await reportBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^motro-import-error-report-.*\.csv$/);
    const dlPath = await download.path();
    const dlCsv = readFileSync(dlPath!, "utf8");
    expect(dlCsv).toContain("invalid");
    expect(dlCsv).toContain("duplicate_in_file");
    expect(dlCsv).not.toContain("candidate");

    // 提交有效行：点主操作 → 确认面板 → 确认。
    await adminPage.getByRole("button", { name: "提交有效行", exact: true }).click();
    await expect(adminPage.getByRole("dialog", { name: /确认提交有效行/ })).toBeVisible();
    // 确认面板显示候选数与映射版本。
    await expect(adminPage.getByText(/候选行数：\s*1/)).toBeVisible();
    await adminPage.getByRole("button", { name: "确认提交" }).click();

    // 提交结果：显示新建词条数 1、提交行数 1，且不再有主提交按钮。
    await expect(adminPage.getByText("提交结果")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText("新建词条")).toBeVisible();
    await expect(adminPage.getByText("提交行数")).toBeVisible();
    await expect(adminPage.getByRole("button", { name: "提交有效行", exact: true })).toHaveCount(0);
    // 后续阶段占位非动作信息状态。
    await expect(adminPage.getByText("查看审核状态（后续阶段）")).toBeVisible();

    // 提交结果在刷新后保留。
    await adminPage.reload();
    await expect(adminPage.getByText("提交结果")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText("查看审核状态（后续阶段）")).toBeVisible();
  });

  test("工单03 重复点击不重复提交（幂等）：仅产生一个提交事实", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);

    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-commit-retry-${Date.now()}.txt`;
    const suffix = Date.now();
    const word = `commit-retry-word-${suffix}`;
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`${word}\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 提交重试来源");
    await uploadBtn.click();
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await adminPage.getByText(fileName, { exact: true }).click();

    await adminPage.getByRole("button", { name: "开始校验" }).click();
    await expect(adminPage.getByText("校验摘要")).toBeVisible({ timeout: 15000 });

    // 拦截 commit 请求，统计次数（同 key 幂等：确认面板只触发一次真实提交）。
    let commitRequests = 0;
    await adminPage.route("**/api/v1/admin/imports/*/commit", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      commitRequests++;
      await route.continue();
    });

    await adminPage.getByRole("button", { name: "提交有效行", exact: true }).click();
    await adminPage.getByRole("button", { name: "确认提交" }).click();
    await expect(adminPage.getByText("提交结果")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByRole("button", { name: "提交有效行", exact: true })).toHaveCount(0);
    // 确认面板触发恰一次提交请求。
    expect(commitRequests).toBe(1);
    // 结果在刷新后保留（证明只产生一个提交事实，无重复词条）。
    await adminPage.reload();
    await expect(adminPage.getByText("提交结果")).toBeVisible({ timeout: 15000 });
    // 刷新后再次打开批次，提交状态仍保留且无重复提交按钮。
    await expect(adminPage.getByRole("button", { name: "提交有效行", exact: true })).toHaveCount(0);
  });

  test("工单03 P1-3 已提交行不再显示为可提交候选：行表区分校验分类与提交状态", async ({
    adminPage,
  }) => {
    await loginAsAdminAndGotoImports(adminPage);

    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-commit-state-${Date.now()}.txt`;
    const suffix = Date.now();
    const word = `commit-state-word-${suffix}`;
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`${word}\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 提交状态来源");
    await uploadBtn.click();
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await adminPage.getByText(fileName, { exact: true }).click();

    // 校验后：行表显示校验分类「已校验候选」与提交状态「未提交」。
    await adminPage.getByRole("button", { name: "开始校验" }).click();
    await expect(adminPage.getByText("校验摘要")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText("行结果")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText(word, { exact: true }).first()).toBeVisible();
    await expect(adminPage.getByText("未提交", { exact: true })).toBeVisible();

    // 提交。
    await adminPage.getByRole("button", { name: "提交有效行", exact: true }).click();
    await adminPage.getByRole("button", { name: "确认提交" }).click();
    await expect(adminPage.getByText("提交结果")).toBeVisible({ timeout: 15000 });

    // 已提交行在行表中显示「已提交」提交状态；校验分类保持 candidate（不可变校验事实）。
    await expect(adminPage.getByText("已提交", { exact: true })).toBeVisible({ timeout: 15000 });
    // 已提交行不再出现「未提交」。
    await expect(adminPage.getByText("未提交", { exact: true })).toHaveCount(0);
    // 刷新后提交状态仍保留（projection 从提交事实推导）。
    await adminPage.reload();
    await expect(adminPage.getByText("提交结果")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText("已提交", { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test("工单03 P1-2 系统已有词条行提交时关联为导入来源（不新建）", async ({ adminPage }) => {
    await loginAsAdminAndGotoImports(adminPage);

    const uploadBtn = adminPage.getByRole("button", { name: "上传并创建批次" });
    const fileName = `e2e-commit-existing-${Date.now()}.txt`;
    const suffix = Date.now();
    // 预置一个系统词条（通过手动词条创建），再上传含该词的文件。
    // 先创建词条。
    await adminPage.goto("/admin/lexicon");
    await expect(adminPage.getByRole("heading", { name: "词条" })).toBeVisible({ timeout: 15000 });
    const existingWord = `existing-commit-${suffix}`;
    await adminPage.getByRole("button", { name: /新建词条/ }).click();
    await adminPage.getByLabel("拼写", { exact: true }).fill(existingWord);
    await adminPage.getByRole("button", { name: /创建|保存/ }).click();
    await expect(adminPage.getByText(existingWord, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });

    // 回到导入页上传含该词的文件（另含一个非法行，用于验证错误报告计数不含 existing_entry）。
    await adminPage.goto("/admin/imports");
    await expect(adminPage.getByRole("button", { name: "上传并创建批次" })).toBeVisible();
    await adminPage.setInputFiles("#import-file", {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`${existingWord}\n1234\n`),
    });
    await adminPage.getByLabel("来源声明").fill("E2E 已有词条来源");
    await uploadBtn.click();
    await expect(adminPage.getByText("上传成功，已创建批次。")).toBeVisible();
    await expect(adminPage.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
    await adminPage.getByText(fileName, { exact: true }).click();

    // 校验：该行分类为 existing_entry（校验摘要「系统已有词条」≥1）。
    await adminPage.getByRole("button", { name: "开始校验" }).click();
    await expect(adminPage.getByText("校验摘要")).toBeVisible({ timeout: 15000 });

    // 错误报告下载按钮出现，且数量 = 1（仅 invalid，不含 existing_entry）。
    const reportBtn = adminPage.getByRole("button", { name: /下载错误报告（\d+ 行）/ });
    await expect(reportBtn).toBeVisible({ timeout: 15000 });
    await expect(reportBtn).toHaveText(/下载错误报告（1 行）/);
    // 下载并验证 CSV 不含 existing_entry 的拼写。
    const downloadPromise = adminPage.waitForEvent("download");
    await reportBtn.click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const csvContent = readFileSync(downloadPath!, "utf8");
    expect(csvContent).not.toContain(existingWord);
    expect(csvContent).toContain("invalid");

    // 提交：确认面板显示「关联已有词条行数」≥1，提交结果「关联既有词条」=1 且「新建词条」=0。
    await adminPage.getByRole("button", { name: "提交有效行", exact: true }).click();
    await expect(adminPage.getByRole("dialog", { name: /确认提交有效行/ })).toBeVisible();
    await expect(adminPage.getByText(/关联已有词条行数：\s*1/)).toBeVisible();
    await adminPage.getByRole("button", { name: "确认提交" }).click();
    await expect(adminPage.getByText("提交结果")).toBeVisible({ timeout: 15000 });
    await expect(adminPage.getByText("新建词条")).toBeVisible();
    await expect(adminPage.getByText("关联既有词条")).toBeVisible();
  });
});
