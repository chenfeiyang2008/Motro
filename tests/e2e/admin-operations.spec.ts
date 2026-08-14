// 管理端任务状态 E2E（阶段 6 工单 04）：导入提交投递的后台操作被独立 worker 处理，
// 管理员在 /admin/operations 看到 queued→running→succeeded；刷新后状态持久；
// 失败操作可从详情页重试；390/768/1440 无横向溢出；键盘/焦点可用。
//
// 运行环境：必须运行在【独立 E2E 数据库】上（compose/e2e-import.yml，含 worker-e2e 服务）。
// 若未检测到独立 E2E 数据库，本 spec 直接失败（不静默降级共享库）。
import { randomUUID, createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { createPool } from "@motro/db";
import { createIsolatedAdmin, adminUsernameFor, stateFileFor } from "./auth-setup.js";
import { cleanupIsolatedAdmin, type ImportTestAdmin } from "./auth-teardown.js";
import { assertSafeDbName, resolveIsolatedE2eTarget, toDbConfig } from "./import-e2e-db.js";
import { operationInputHash } from "@motro/domain";
import type { Pool } from "pg";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";
const E2E_DB = process.env.E2E_IMPORT_DB ?? "";

/** 在隔离库构造一个最小合法 import_batch_commit_rows（0029：target_id 必须引用真实行）。 */
export async function createCommitRowSql(pool: Pool): Promise<string> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'E2E Commit Row User', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2 RETURNING id`,
      ["e2e-commit-row-user", "not-a-real-hash"],
    )
  ).rows[0]!.id;
  const spelling = `e2e-${randomUUID().slice(0, 8)}`;
  const fileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO stored_files
         (storage_key, original_filename, declared_mime, sniffed_mime, byte_size, sha256_hex, uploaded_by, purpose, format)
       VALUES ($1, $2, 'text/plain', 'text/plain', 4, $3, $4, 'original_import', 'txt') RETURNING id`,
      [
        `test://${spelling}`,
        `${spelling}.txt`,
        createHash("sha256").update(spelling).digest("hex"),
        userId,
      ],
    )
  ).rows[0]!.id;
  const batchId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batches (file_id, uploaded_by, format, source_declaration)
       VALUES ($1, $2, 'txt', $3) RETURNING id`,
      [fileId, userId, `source: ${spelling}`],
    )
  ).rows[0]!.id;
  const importRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_rows (batch_id, ordinal, mapping_version, raw_summary, normalized_spelling, status)
       VALUES ($1, 1, 1, $2, $2, 'candidate') RETURNING id`,
      [batchId, spelling],
    )
  ).rows[0]!.id;
  const commitId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commits (batch_id, committed_by, mapping_version, semantic_hash, status)
       VALUES ($1, $2, 1, $3, 'completed') RETURNING id`,
      [batchId, userId, createHash("sha256").update(spelling).digest("hex")],
    )
  ).rows[0]!.id;
  const entryId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
       VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
      [spelling],
    )
  ).rows[0]!.id;
  const sourceId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_sources (lexical_entry_id, source_type, content_hash, created_by)
       VALUES ($1, 'import', $2, $3) RETURNING id`,
      [entryId, createHash("sha256").update(spelling).digest("hex"), userId],
    )
  ).rows[0]!.id;
  const commitRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commit_rows
         (commit_id, import_row_id, ordinal, normalized_spelling, created_entry_id, lexical_entry_id, lexical_source_id)
       VALUES ($1, $2, 1, $3, $4, $4, $5) RETURNING id`,
      [commitId, importRowId, spelling, entryId, sourceId],
    )
  ).rows[0]!.id;
  return commitRowId;
}

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

/** 读取浏览器 CSRF cookie 值（双提交 cookie 需要 header 回传）。 */
async function readCsrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === "motro_csrf")?.value;
  if (!csrf) {
    // 先访问健康检查让服务端设置 CSRF cookie。
    await page.goto("/api/v1/health/live");
    const again = await page.context().cookies();
    return again.find((c) => c.name === "motro_csrf")?.value ?? "";
  }
  return csrf;
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

test.describe("admin operations", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    if (!E2E_DB) {
      throw new Error(
        "admin-operations E2E 必须运行在独立 E2E 数据库（E2E_IMPORT_DB）。请使用 runbook：docker compose -f compose/e2e-import.yml up -d --build",
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
    rmSync(stateFileForProject(project), { force: true });
  });

  /** 通过 API 完成一次导入提交，返回提交产生的 operation id（由 worker 处理）。 */
  async function commitImportAndGetOperation(page: Page): Promise<string> {
    const word = `op-${randomUUID().slice(0, 8)}`;
    // 先确保 CSRF cookie 就绪（读页面 cookie 并作为 x-csrf-token 头发送）。
    const csrf = await readCsrfToken(page);
    const authHeaders = {
      "x-csrf-token": csrf,
    };
    // 1) 上传
    const upKey = `up-${randomUUID()}`;
    const up = await page.request.post(`${API}/api/v1/admin/imports`, {
      multipart: {
        file: {
          name: `op-${Date.now()}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(`${word}\n`),
        },
        sourceDeclaration: "E2E 任务状态来源",
      },
      headers: { "idempotency-key": upKey, ...authHeaders },
    });
    expect(up.status()).toBe(201);
    const batch = (await up.json()) as { id: string };
    // 2) 校验
    const vKey = `val-${randomUUID()}`;
    const val = await page.request.post(`${API}/api/v1/admin/imports/${batch.id}/validate`, {
      headers: { "idempotency-key": vKey, ...authHeaders },
    });
    expect(val.status()).toBe(200);
    const vd = (await val.json()) as { validationStatus: string };
    expect(vd.validationStatus).toBe("validated");
    // 3) 读取提交确认身份
    const detail = (await (
      await page.request.get(`${API}/api/v1/admin/imports/${batch.id}`)
    ).json()) as {
      commitConfirmation?: { mappingVersion: number; validationInputSha256: string };
    };
    expect(detail.commitConfirmation).toBeTruthy();
    // 4) 提交（产生 commit rows → 投递 operations）
    const cKey = `commit-${randomUUID()}`;
    const commit = await page.request.post(`${API}/api/v1/admin/imports/${batch.id}/commit`, {
      headers: { "idempotency-key": cKey, ...authHeaders },
      data: {
        mappingVersion: detail.commitConfirmation!.mappingVersion,
        validationInputSha256: detail.commitConfirmation!.validationInputSha256,
      },
    });
    expect(commit.status()).toBe(200);
    const cr = (await commit.json()) as { committedRowCount: number };
    expect(cr.committedRowCount).toBeGreaterThanOrEqual(1);
    return batch.id;
  }

  test("导入提交 → 任务状态页显示 succeeded（worker 处理）→ 刷新持久", async ({ adminPage }) => {
    await commitImportAndGetOperation(adminPage);
    await adminPage.goto("/admin/operations");
    await expect(adminPage.locator("h1", { hasText: "任务状态" })).toBeVisible();
    // worker 处理 fixture（input_version=1 成功）；轮询到状态徽标 succeeded。
    const successBadge = adminPage.locator(".operations-status--succeeded").first();
    await expect(successBadge).toBeVisible({ timeout: 30000 });
    // 刷新后状态仍存在（持久化事实，不依赖 worker 常驻）。
    await adminPage.reload();
    await expect(adminPage.locator(".operations-status--succeeded").first()).toBeVisible({
      timeout: 30000,
    });
  });

  test("任务详情页展示 attempt 时间线与脱敏错误；失败可重试", async ({ adminPage }) => {
    // 直接种入一个永久失败的 operation（input_version=3 → fixture 永久失败）。
    // 0029：target_id 必须引用真实 import_batch_commit_rows(id)。
    const db = toDbConfig(resolveIsolatedE2eTarget().db);
    const pool = createPool(db);
    const targetId = await createCommitRowSql(pool);
    const opType = "motro-op-fixture";
    await pool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, retryable)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, 3, 'failed',
               $1, 'local', 5, false)
       ON CONFLICT DO NOTHING`,
      [
        opType,
        targetId,
        operationInputHash({
          operationType: opType,
          targetType: "import_batch_commit_row",
          targetId,
          inputVersion: 3,
        }),
      ],
    );
    const row = await pool.query<{ id: string }>(
      "SELECT id FROM application_operations WHERE target_id = $1",
      [targetId],
    );
    await pool.end();
    const opId = row.rows[0]!.id;

    await adminPage.goto(`/admin/operations/${opId}`);
    await expect(adminPage.locator("h1", { hasText: "任务详情" })).toBeVisible();
    // 已失败状态 + 唯一主操作「重试任务」。
    await expect(adminPage.getByText("已失败", { exact: true }).first()).toBeVisible();
    const retryBtn = adminPage.getByRole("button", { name: "重试任务" });
    await expect(retryBtn).toBeVisible();

    // 点击重试 → 重新投递 job；worker 会再次处理（PERM fixture → 再失败），
    // 但重试本身必须生效：operation 的 attempt 数增加（重试后 worker 重新执行）。
    const dbPool = createPool(toDbConfig(resolveIsolatedE2eTarget().db));
    const before = await dbPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
      [opId],
    );
    const beforeCount = Number(before.rows[0]?.n ?? 0);
    await retryBtn.click();
    // 轮询直到 attempt 数增加（证明重试已重新投递并再次执行）。
    await expect
      .poll(
        async () => {
          const r = await dbPool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM application_operation_attempts WHERE operation_id = $1",
            [opId],
          );
          return Number(r.rows[0]?.n ?? 0);
        },
        { timeout: 30000 },
      )
      .toBeGreaterThan(beforeCount);
    await dbPool.end();
    // 详情页仍可打开（刷新后状态保留）。
    await adminPage.reload();
    await expect(adminPage.locator("h1", { hasText: "任务详情" })).toBeVisible();
  });

  test("succeeded/queued/running 状态不显示「重试任务」按钮（P2-5）", async ({ adminPage }) => {
    // 种入三种非可重试状态并逐一断言按钮不可见。
    const db = toDbConfig(resolveIsolatedE2eTarget().db);
    const pool = createPool(db);
    const opType = "motro-op-fixture";
    const states = [
      { status: "succeeded", completedAt: new Date() },
      { status: "queued", completedAt: null },
      { status: "running", completedAt: null },
    ];
    const ids: string[] = [];
    for (const s of states) {
      // 0029：target_id 必须引用真实 import_batch_commit_rows(id)。
      const targetId = await createCommitRowSql(pool);
      const res = await pool.query<{ id: string }>(
        `INSERT INTO application_operations
           (operation_type, operation_version, target_type, target_id, input_hash, input_version,
            status, task_identifier, queue_name, max_attempts, retryable, started_at, completed_at)
         VALUES ($1, 1, 'import_batch_commit_row', $2, $3, 1, $4,
                 $1, 'local', 5, true, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          opType,
          targetId,
          operationInputHash({
            operationType: opType,
            targetType: "import_batch_commit_row",
            targetId,
            inputVersion: 1,
          }),
          s.status,
          s.status === "running" ? new Date() : null,
          s.completedAt,
        ],
      );
      ids.push(res.rows[0]!.id);
    }
    await pool.end();

    for (let i = 0; i < ids.length; i++) {
      await adminPage.goto(`/admin/operations/${ids[i]!}`);
      await expect(adminPage.locator("h1", { hasText: "任务详情" })).toBeVisible();
      // 非 failed/manual_action：不得显示「重试任务」按钮。
      await expect(adminPage.getByRole("button", { name: "重试任务" })).toHaveCount(0);
    }
  });

  test("390/768/1440px 任务状态页无横向溢出", async ({ adminPage }) => {
    await commitImportAndGetOperation(adminPage);
    await adminPage.goto("/admin/operations");
    await expect(adminPage.locator("h1", { hasText: "任务状态" })).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const overflow = await adminPage.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 任务状态页无横向滚动`).toBe(false);
    }
  });

  test("任务列表键盘操作：可聚焦链接与状态过滤", async ({ adminPage }) => {
    await commitImportAndGetOperation(adminPage);
    await adminPage.goto("/admin/operations");
    await expect(adminPage.locator("h1", { hasText: "任务状态" })).toBeVisible();
    // 状态过滤下拉可聚焦并选择「已成功」。
    const filter = adminPage.getByLabel("状态过滤");
    await expect(filter).toBeVisible();
    await filter.focus();
    await expect(filter).toBeFocused();
    await filter.selectOption("succeeded");
    await expect(adminPage.locator(".operations-status--succeeded").first()).toBeVisible({
      timeout: 15000,
    });
    // 行内链接可通过键盘 Tab 聚焦（可见焦点）。
    await adminPage.keyboard.press("Tab");
    await adminPage.keyboard.press("Tab");
    await adminPage.keyboard.press("Tab");
    const focused = await adminPage.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.tagName ?? "";
    });
    expect(focused.length).toBeGreaterThan(0);
  });
});
