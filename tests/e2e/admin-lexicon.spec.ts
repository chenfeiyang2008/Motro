// 词条管理 E2E：管理员新建词条、列表/详情、搜索刷新可见、重复候选提示与继续/取消。
// 需要运行中的 API + PostgreSQL（compose 环境，见 compose/README.md）。API 不可达时自动跳过。
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

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
  await page.getByLabel("用户名").fill(ADMIN_USER);
  await page.getByLabel("密码").fill(ADMIN_PASS);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
  await page.goto("/admin/lexicon");
  await expect(page.getByRole("heading", { name: "词条" })).toBeVisible();
}

/** 在搜索框输入并触发搜索。 */
async function searchLexicon(page: Page, query: string): Promise<void> {
  await page.getByLabel("搜索拼写").fill(query);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
}

test.describe("admin lexicon", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

  test("新建词条、列表显示 manual 来源与引用 0、详情刷新后仍可见、搜索命中", async ({ page }) => {
    await loginAsAdmin(page);

    // 页面只有一个最强主操作“新建词条”。
    await expect(page.getByRole("button", { name: "新建词条" })).toBeVisible();

    const spelling = `e2e-${Date.now()}`;
    await page.getByRole("button", { name: "新建词条" }).click();
    await page.getByLabel("拼写", { exact: true }).fill(spelling);
    await page.getByLabel("词性（可选）").selectOption("verb");
    await page.getByLabel("来源说明（可选）").fill("E2E 手工来源");
    await page.getByRole("button", { name: "保存词条" }).click();

    // 创建成功后表单关闭并自动搜索该词条；列表显示 manual 来源与引用次数 0。
    const row = page.getByRole("row", { name: new RegExp(spelling) });
    await expect(row).toContainText("manual");
    await expect(row).toContainText("0");

    // 打开详情并刷新，记录仍可见。
    await page.getByRole("link", { name: spelling, exact: true }).click();
    await expect(page.getByRole("heading", { name: spelling })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: spelling })).toBeVisible();

    // 返回列表并按拼写搜索，记录仍可见。
    await page.getByRole("link", { name: "返回词条列表" }).click();
    await searchLexicon(page, spelling);
    await expect(page.getByRole("link", { name: spelling, exact: true })).toBeVisible();
  });

  test("重复候选在表单附近提示：完全相同冲突、同形异义可继续/取消", async ({ page }) => {
    await loginAsAdmin(page);

    const base = `e2e-dup-${Date.now()}`;
    // 创建第一个词条 → 自动搜索该词条。
    await page.getByRole("button", { name: "新建词条" }).click();
    await page.getByLabel("拼写", { exact: true }).fill(base);
    await page.getByRole("button", { name: "保存词条" }).click();
    await expect(page.getByRole("link", { name: base, exact: true })).toBeVisible();

    // 再次输入完全相同拼写 → 内联冲突，无“继续创建”，关闭后不新增。
    await page.getByRole("button", { name: "新建词条" }).click();
    await page.getByLabel("拼写", { exact: true }).fill(base);
    await page.getByRole("button", { name: "保存词条" }).click();
    await expect(page.locator(".duplicate-warning")).toContainText("完全相同词条已存在");
    await expect(page.getByRole("button", { name: "继续创建" })).toHaveCount(0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("link", { name: base, exact: true })).toHaveCount(1);

    // 同规范化拼写、不同展示拼写 → 重复警告 + 继续/取消；取消不落库。
    const variant = base.charAt(0).toUpperCase() + base.slice(1);
    await page.getByRole("button", { name: "新建词条" }).click();
    await page.getByLabel("拼写", { exact: true }).fill(variant);
    await page.getByRole("button", { name: "保存词条" }).click();
    await expect(page.getByRole("button", { name: "继续创建" })).toBeVisible();
    await page.getByRole("button", { name: "取消创建", exact: true }).click();
    await expect(page.getByRole("button", { name: "继续创建" })).toHaveCount(0);
    await page.getByRole("button", { name: "取消", exact: true }).click();

    // 搜索变体：取消后不应新增。
    await searchLexicon(page, variant);
    await expect(page.getByRole("link", { name: variant, exact: true })).toHaveCount(0);

    // 再次提交并显式确认 → 创建第二个稳定词条（自动搜索到该变体）。
    await page.getByRole("button", { name: "新建词条" }).click();
    await page.getByLabel("拼写", { exact: true }).fill(variant);
    await page.getByRole("button", { name: "保存词条" }).click();
    await page.getByRole("button", { name: "继续创建" }).click();
    await expect(page.getByRole("link", { name: variant, exact: true })).toBeVisible();
  });
});
