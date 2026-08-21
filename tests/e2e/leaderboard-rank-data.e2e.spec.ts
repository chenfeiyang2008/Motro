// Leaderboard "我的位置与公开行一致" data E2E — isolated stack (Chromium + WebKit).
//
// 独立于 learner-xp-leaderboard.spec.ts（该 spec 断言空榜/隐私，依赖空库；
// 本 spec 会种入真实 challenge_point_entries，故独立成文件避免污染空榜断言）。
//
// 验证修复后的排名一致性：
//   - leader (当前 viewer) = 5 分，other = 10 分；
//   - 10 分排第 1，5 分排第 2；
//   - viewer 的「我的位置」与公开表中其行 rank/points 完全一致；
//   - 前端不重排（只渲染服务端 rank）。
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { adminUsernameFor, createIsolatedAdmin, stateFileFor } from "./auth-setup.js";
import { cleanupIsolatedAdmin, type ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName } from "./import-e2e-db.js";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3100";
const WEB = process.env.PW_BASE_URL ?? "http://127.0.0.1:3101";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";
const E2E_DB = process.env.E2E_IMPORT_DB ?? "";

let apiUp = false;
const projectAdmins = new Map<string, ImportTestAdmin>();
const projectPromises = new Map<string, Promise<ImportTestAdmin>>();
const projectStateFiles = new Map<string, string>();
let currentProjectName = "unknown";

function stateFileForProject(project: string): string {
  let f = projectStateFiles.get(project);
  if (!f) {
    f = stateFileFor(project);
    projectStateFiles.set(project, f);
  }
  return f;
}

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

test.describe("leaderboard rank-data consistency (isolated stack)", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    if (!E2E_DB) {
      throw new Error(
        "leaderboard-rank-data E2E 必须运行在独立 E2E 数据库（E2E_IMPORT_DB）。请先启动：docker compose -f compose/e2e-import.yml up -d --build",
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
    if (apiUp && ADMIN_PASS !== "") {
      await ensureIsolatedAdmin(browser, currentProjectName);
    }
  });

  test.beforeEach(() => {
    test.skip(!apiUp && process.env.MOTRO_REQUIRE_DB !== "1", "需要运行中的 API 与数据库");
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD");
  });

  test.afterAll(async () => {
    const project = currentProjectName;
    const admin = projectAdmins.get(project);
    if (admin) {
      await cleanupIsolatedAdmin(admin);
      projectAdmins.delete(project);
    }
    try {
      rmSync(stateFileForProject(project), { force: true });
    } catch {
      // clean best-effort
    }
  });

  async function loginAdminApi(
    playwright: import("@playwright/test").Playwright,
  ): Promise<{ ctx: import("@playwright/test").APIRequestContext; csrf: string }> {
    const ctx = await playwright.request.newContext({ baseURL: API });
    await ctx.get("/api/v1/health/live");
    const state = await ctx.storageState();
    const csrf = state.cookies.find((c) => c.name === "motro_csrf")?.value ?? "";
    const login = await ctx.post("/api/v1/auth/login", {
      headers: { "x-csrf-token": csrf },
      data: {
        username: adminUsernameFor(currentProjectName),
        password: ADMIN_PASS,
      },
    });
    expect(login.status(), "隔离栈管理员登录").toBe(200);
    return { ctx, csrf };
  }

  async function createLearnerViaAdmin(
    ctx: import("@playwright/test").APIRequestContext,
    csrf: string,
  ): Promise<{ userId: string; username: string; otp: string }> {
    const username = `lbr-${randomUUID().slice(0, 8)}`;
    const res = await ctx.post("/api/v1/admin/users", {
      headers: { "x-csrf-token": csrf, "idempotency-key": `lbr-${username}` },
      data: {
        username,
        displayName: `LBR ${username}`,
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { user: { id: string }; oneTimePassword: string };
    return { userId: body.user.id, username, otp: body.oneTimePassword };
  }

  async function loginLearner(
    page: Page,
    learner: { username: string; otp: string },
  ): Promise<void> {
    await page.goto(`${WEB}/login`);
    await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
    await page.getByLabel("用户名").fill(learner.username);
    await page.getByLabel("密码").fill(learner.otp);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/, { timeout: 15_000 });
    await page.getByLabel(/当前密码/).fill(learner.otp);
    const newPass = "lbr-e2e-pass-12345";
    await page.getByLabel(/^新密码/).fill(newPass);
    await page.getByLabel(/确认新密码/).fill(newPass);
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  }

  async function currentChallengeWeekKey(
    ctx: import("@playwright/test").APIRequestContext,
  ): Promise<string> {
    const res = await ctx.get("/api/v1/leaderboard/weekly");
    expect(res.ok(), "排行榜 API 应可达").toBe(true);
    const body = (await res.json()) as { challengeWeek: string };
    return body.challengeWeek;
  }

  /** 向隔离库种入一条真实 challenge_point_entries（后端权威事实）。 */
  async function seedChallengePoints(userId: string, week: string, amount: number): Promise<void> {
    const { createPool } = await import("@motro/db");
    const { resolveIsolatedE2eTarget, toDbConfig } = await import("./import-e2e-db.js");
    const target = resolveIsolatedE2eTarget();
    const pool = createPool(toDbConfig(target.db));
    try {
      const attempt = await pool.query<{ id: string }>(
        `INSERT INTO challenge_attempts (user_id, challenge_week, total_items, status, expires_at)
         VALUES ($1, $2, 10, 'completed', now() + interval '1 hour') RETURNING id`,
        [userId, week],
      );
      const lex = await pool.query<{ id: string }>(
        `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling)
         VALUES ($1, $1) RETURNING id`,
        [`rankword-${randomUUID().slice(0, 8)}`],
      );
      await pool.query(
        `INSERT INTO challenge_point_entries
           (user_id, challenge_week, source_attempt_id, rule_version, amount, reason,
            lexical_entry_id, direction, awarded_at)
         VALUES ($1, $2, $3, 1, $4, 'first_correct_answer', $5, 'en_to_zh', now())`,
        [userId, week, attempt.rows[0]!.id, amount, lex.rows[0]!.id],
      );
    } finally {
      await pool.end();
    }
  }

  test("有数据榜单：我的位置与公开行一致（rank/points），且无前端重排", async ({
    adminPage,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      // leader (当前 viewer) = 5 分；other = 10 分。
      const leader = await createLearnerViaAdmin(ctx, csrf);
      const other = await createLearnerViaAdmin(ctx, csrf);
      const week = await currentChallengeWeekKey(ctx);
      await seedChallengePoints(leader.userId, week, 5);
      await seedChallengePoints(other.userId, week, 10);

      // 登录 leader 访问排行榜。
      const context = await adminPage.context().browser()!.newContext();
      const learnerPage = await context.newPage();
      await loginLearner(learnerPage, leader);
      await learnerPage.goto(`${WEB}/leaderboard`);
      await expect(learnerPage.getByRole("heading", { name: "周挑战榜" })).toBeVisible();

      // viewer 行：我的位置 + 积分来自服务端。
      const viewerRankText = learnerPage.locator(".lb-viewer-rank");
      await expect(viewerRankText).toHaveText(/第 \d+ 名/, { timeout: 10_000 });
      const viewerPointsText = learnerPage.locator(".lb-viewer-points");
      await expect(viewerPointsText.first()).toHaveText("5");
      const viewerRankNum = Number(
        (await viewerRankText.textContent())?.replace(/[^0-9]/g, "") ?? "",
      );
      expect(viewerRankNum).toBeGreaterThanOrEqual(1);

      // 公开表中 leader 行存在，其 rank/points 与 viewer 一致。
      const leaderName = `LBR ${leader.username}`;
      const leaderRow = learnerPage.locator(".lb-table tbody tr", { hasText: leaderName });
      await expect(leaderRow).toBeVisible();
      await expect(leaderRow).toContainText(String(viewerRankNum));
      await expect(leaderRow).toContainText("5");

      // 无前端重排：viewer 显示 5 分（leader 真实积分），公开行亦为 5 分。
      const viewerBody = await learnerPage.locator("body").innerText();
      expect(viewerBody).toContain("第 2 名"); // leader 5 分在 10 分之后 → 第 2 名
      await context.close();
    } finally {
      await ctx.dispose();
    }
  });
});
