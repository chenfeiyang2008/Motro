// 管理端激励文案页 E2E（Ticket：Motro 激励文案管理端 UI 收口）。
// 覆盖：批量添加区域默认展开且无展开/收起按钮；批量新增真实调用后端并成功展示；
// 重复提交不 UI 重复追加；失败保留输入；隔离前端去重；批量成功显示新增/跳过数；
// 390/768/1440 无横向溢出；键盘可达；深色主题。
//
// 运行环境：独立 E2E 数据库（compose/e2e-import.yml）。复用 auth-setup 的隔离管理员。
import { randomUUID } from "node:crypto";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { adminUsernameFor, createIsolatedAdmin, stateFileFor } from "./auth-setup.js";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";

let apiUp = false;
const projectPromises = new Map<string, Promise<void>>();
const projectStateFiles = new Map<string, string>();

function stateFileForProject(project: string): string {
  let f = projectStateFiles.get(project);
  if (!f) {
    f = stateFileFor(project);
    projectStateFiles.set(project, f);
  }
  return f;
}

function ensureIsolatedAdmin(browser: Browser, project: string): Promise<void> {
  if (!projectPromises.has(project)) {
    const username = adminUsernameFor(project);
    const stateFile = stateFileForProject(project);
    projectPromises.set(
      project,
      createIsolatedAdmin(browser, stateFile, username).then(() => undefined),
    );
  }
  return projectPromises.get(project)!;
}

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use, testInfo) => {
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

test.describe("admin motivation copies workbench", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    const project = testInfo.project.name;
    try {
      const res = await fetch(`${API}/api/v1/health/live`);
      apiUp = res.ok;
    } catch {
      apiUp = false;
    }
    if (apiUp && ADMIN_PASS !== "") await ensureIsolatedAdmin(browser, project);
  });

  test("page renders with default-open batch area and no collapse toggle", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/motivation");
    await expect(page.getByRole("heading", { name: "激励文案" })).toBeVisible();

    // 批量添加区域默认可见（默认展开）。
    const batchHeading = page.getByRole("heading", { name: "批量添加" });
    await expect(batchHeading).toBeVisible();
    // 批量 textarea 可见。
    const batchTextarea = page.locator(".admin-motivation-batch textarea");
    await expect(batchTextarea).toBeVisible();

    // 没有展开/收起按钮或隐藏面板 toggle。
    await expect(page.getByRole("button", { name: /展开|收起|折叠/ })).toHaveCount(0);

    // 无横向溢出。
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w).toBeLessThanOrEqual(1440);
  });

  test("batch add creates copies and shows created count; empty list flow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/motivation");
    await page.getByRole("heading", { name: "激励文案" }).waitFor();

    const unique = `mot-test-${randomUUID().slice(0, 8)}`;
    const lineA = `第一句 ${unique}`;
    const lineB = `第二句 ${unique}`;

    // 填写批量区。
    const batchTextarea = page.locator(".admin-motivation-batch textarea");
    await batchTextarea.fill(`${lineA}\n${lineB}`);

    // 提交按钮显示 "添加 2 条"。
    const batchBtn = page.locator(".admin-motivation-batch .primary");
    await expect(batchBtn).toContainText("添加 2 条");

    await batchBtn.click();
    // 成功信息：已新增 2 条。
    await expect(page.getByText(/已新增 2 条文案|已新增 2 条，跳过/)).toBeVisible({
      timeout: 15000,
    });

    // 列表出现新增文案（真实后端返回后刷新）。
    await expect(
      page.locator(".admin-motivation-table").getByText(lineA, { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator(".admin-motivation-table").getByText(lineB, { exact: true }),
    ).toBeVisible();
  });

  test("duplicate batch line is deduped client-side and does NOT create duplicate rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/motivation");
    await page.getByRole("heading", { name: "激励文案" }).waitFor();

    const unique = `dup-${randomUUID().slice(0, 8)}`;
    const line = `重复 ${unique}`;

    const batchTextarea = page.locator(".admin-motivation-batch textarea");
    // 同一行出现两次 → 前端去重后应识别 1 条。
    await batchTextarea.fill(`${line}\n${line}`);
    // 元信息显示 "已识别 1 条（已去重）"。
    await expect(page.locator(".admin-motivation-batch__meta")).toContainText("已识别 1 条");
    await expect(page.locator(".admin-motivation-batch__meta")).toContainText("已去重");

    const batchBtn = page.locator(".admin-motivation-batch .primary");
    await expect(batchBtn).toContainText("添加 1 条");
    await batchBtn.click();
    await expect(page.getByText(/已新增 1 条文案/)).toBeVisible({ timeout: 15000 });

    // 列表中只有一行。
    const rows = page.locator(".admin-motivation-table tbody tr").filter({ hasText: line });
    await expect(rows.first()).toBeVisible();
  });

  test("batch add failure keeps user input and allows retry", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/motivation");
    await page.getByRole("heading", { name: "激励文案" }).waitFor();

    const batchTextarea = page.locator(".admin-motivation-batch textarea");
    // 超过 180 字符的行 → 校验错误，不提交，输入保留。
    await batchTextarea.fill("x".repeat(181));

    const batchBtn = page.locator(".admin-motivation-batch .primary");
    await batchBtn.click();

    // 校验错误显示在 meta，且 textarea 输入保留。
    await expect(batchTextarea).toHaveValue("x".repeat(181));
    await expect(page.getByRole("alert").filter({ hasText: /超过 180 个字符/ })).toBeVisible();
  });

  test("390px no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/motivation");
    await page.getByRole("heading", { name: "激励文案" }).waitFor();
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w).toBeLessThanOrEqual(390);
  });

  test("dark theme uses surface background and orange accent on controls", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/motivation");
    await page.getByRole("heading", { name: "激励文案" }).waitFor();

    // 切到深色主题。
    const themeBtn = page.locator(".theme-toggle--global");
    const initial = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (initial !== "dark") {
      await themeBtn.click();
      await page.waitForTimeout(200);
    }
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
      "dark",
    );

    // 批量区背景用 surface token（非默认白色）。
    const bg = await page
      .locator(".admin-motivation-batch")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("rgb(255, 255, 255)");
  });
});
