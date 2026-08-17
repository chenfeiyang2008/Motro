// Ticket 08 Path-B 浏览器级发布资格 E2E（真实隔离栈，无 mock）。
//
// 登录隔离：整组在 beforeAll 里做【一次】登录，生成共享的 API request context 与
// 已认证的 browser context（storageState）；每个测试只从共享上下文开新 page，绝不在
// 每个测试里重复登录 → 不触发 API 的进程内 per-IP/account 登录 rate-limit。
//
// 合法性：Path-B 事实通过合法 FK 链构造（stored_files→import_batches→import_rows→
// import_batch_commits→import_batch_commit_rows→lexical_entries→enrichment_drafts→
// review_decisions→review_decision_snapshots），再把 draft_course_items 绑定
// provenance_kind='review', review_decision_id=…。发布资格由真实服务端 validate 给出。
import { expect, test, type Browser, type APIRequestContext, type Page } from "@playwright/test";
import { createPool, type Pool } from "@motro/db";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";
const DB = process.env.E2E_T08PB_DB ?? "motro_e2e_t08pb";

let apiUp = false;
test.beforeAll(async () => {
  try {
    const res = await fetch(`${API}/api/v1/health/live`);
    apiUp = res.ok;
  } catch {
    apiUp = false;
  }
});

/** 只连本 E2E 的隔离库；绝不连共享库。 */
function isolatedPool(): Pool {
  return createPool({
    host: "127.0.0.1",
    port: 5432,
    database: DB,
    user: "motro",
    password: "dev_only_change_me",
    max: 3,
  });
}

/** 一次登录，返回共享的 API request context（带管理员会话/CSRF）。 */
async function loginOnce(
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

/** 一次页面登录，返回已认证的 browser context（共享，测试只开新 page）。 */
async function authedBrowserContext(
  browser: Browser,
): Promise<import("@playwright/test").BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
  await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
  await page.getByLabel("用户名").fill(ADMIN_USER);
  await page.getByLabel("密码").fill(ADMIN_PASS);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/app|\/change-password/, { timeout: 15000 });
  await context.storageState({ path: process.env.PW_TEST_STATE ?? undefined });
  return context;
}

// ---- 合法 FK 链构造 ----

/** 合法构造 import_batch_commit_rows（完整 FK 链）。 */
async function createLegalCommitRow(pool: Pool, userId: string, spelling: string): Promise<string> {
  const fileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO stored_files (storage_key, original_filename, declared_mime, sniffed_mime, byte_size, sha256_hex, uploaded_by, purpose, format)
       VALUES ($1,$2,'text/plain','text/plain',4,$3,$4,'original_import','txt') RETURNING id`,
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
      `INSERT INTO import_batches (file_id, uploaded_by, format, source_declaration) VALUES ($1,$2,'txt',$3) RETURNING id`,
      [fileId, userId, `source: ${spelling}`],
    )
  ).rows[0]!.id;
  const importRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_rows (batch_id, ordinal, mapping_version, raw_summary, normalized_spelling, status)
       VALUES ($1,1,1,$2,$2,'candidate') RETURNING id`,
      [batchId, spelling],
    )
  ).rows[0]!.id;
  const commitId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commits (batch_id, committed_by, mapping_version, semantic_hash, status)
       VALUES ($1,$2,1,$3,'completed') RETURNING id`,
      [batchId, userId, createHash("sha256").update(spelling).digest("hex")],
    )
  ).rows[0]!.id;
  const entryId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses) VALUES ($1,$1,'[]'::jsonb) RETURNING id`,
      [spelling],
    )
  ).rows[0]!.id;
  const sourceId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_sources (lexical_entry_id, source_type, content_hash, created_by) VALUES ($1,'import',$2,$3) RETURNING id`,
      [entryId, createHash("sha256").update(spelling).digest("hex"), userId],
    )
  ).rows[0]!.id;
  const commitRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commit_rows (commit_id, import_row_id, ordinal, normalized_spelling, created_entry_id, lexical_entry_id, lexical_source_id)
       VALUES ($1,$2,1,$3,$4,$4,$5) RETURNING id`,
      [commitId, importRowId, spelling, entryId, sourceId],
    )
  ).rows[0]!.id;
  return commitRowId;
}

/** 合法构造一门 Path B 课程，词项绑定一个 real review decision。 */
async function seedPathBCourse(
  pool: Pool,
  ctx: APIRequestContext,
  csrf: string,
  decisionType: "accept" | "reject",
  snapshotSpelling?: string,
): Promise<string> {
  const admin = await pool.query<{ id: string }>("SELECT id FROM users WHERE username='admin'");
  const adminId = admin.rows[0]!.id;
  const spelling = `t8pb${randomBytes(4).toString("hex")}`;
  const commitRowId = await createLegalCommitRow(pool, adminId, spelling);
  const entryId = (
    await pool.query<{ created_entry_id: string }>(
      "SELECT created_entry_id FROM import_batch_commit_rows WHERE id=$1",
      [commitRowId],
    )
  ).rows[0]!.created_entry_id;
  const spellNorm = (
    await pool.query<{ canonical_spelling: string }>(
      "SELECT canonical_spelling FROM lexical_entries WHERE id=$1",
      [entryId],
    )
  ).rows[0]!.canonical_spelling;
  const sourceFactId = createHash("sha256")
    .update("sf" + commitRowId)
    .digest("hex");
  await pool.query(
    `INSERT INTO wiktionary_source_facts
       (source_fact_identity, page_identity_hash, revision_identity_hash, page_id, revision_id,
        revision_timestamp, canonical_title, normalized_spelling, language, part_of_speech,
        definition_excerpt, content_hash, source_url, license_name, license_version, license_url,
        attribution, parser_version, status, commit_row_id)
     VALUES ($1,$2,$3,'apple','rev-1',now(),'apple',$4,'en','noun','a fruit',$5,
             'https://en.wiktionary.org/wiki/apple','CC BY-SA 4.0','3.0',
             'https://creativecommons.org/licenses/by-sa/4.0/','Wik contributors','v1','fetched',$6)`,
    [
      sourceFactId,
      createHash("sha256").update("page").digest("hex"),
      createHash("sha256").update("rev").digest("hex"),
      spellNorm,
      createHash("sha256").update(sourceFactId).digest("hex"),
      commitRowId,
    ],
  );
  const draftId = (
    await pool.query<{ id: string }>(
      `INSERT INTO enrichment_drafts
         (import_batch_commit_row_id, lexical_entry_id, wiktionary_source_fact_id, provider,
          configured_model_alias, resolved_provider_model, prompt_template_version,
          input_hash, request_hash, draft_schema_version, status,
          simplified_chinese_meaning, learning_hint, completed_at)
       VALUES ($1,$2,$3,'deepseek','deepseek-v4-flash','deepseek-v4-flash-0731',
               'zh-v1',$4,$5,1,'draft_ready','苹果','hint',now()) RETURNING id`,
      [
        commitRowId,
        entryId,
        sourceFactId,
        createHash("sha256")
          .update("in" + commitRowId)
          .digest("hex"),
        createHash("sha256")
          .update("req" + commitRowId)
          .digest("hex"),
      ],
    )
  ).rows[0]!.id;
  const hash = createHash("sha256")
    .update("d" + draftId)
    .digest("hex");
  const decisionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO review_decisions
         (draft_id, reviewer_id, decision_type, reason, decision_hash, request_hash, idempotency_key)
       VALUES ($1,$2,$3,'审核',$4,$4,$5) RETURNING id`,
      [
        draftId,
        adminId,
        decisionType,
        hash,
        `k-pb-${decisionType}-${randomBytes(4).toString("hex")}`,
      ],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO review_decision_snapshots
       (decision_id, draft_id, decision_type, english_spelling, part_of_speech,
        simplified_chinese_meaning, learning_hint, source_fact_identity, source_name,
        source_page_id, source_revision_id, source_revision_timestamp, source_url,
        license_name, license_version, license_url, attribution, configured_model_alias,
        prompt_template_version, draft_schema_version, content_hash)
     VALUES ($1,$2,$3,$4,'noun','苹果','hint',$5,'Wiktionary',
             'apple','rev-1',now(),'https://x','CC','3.0','https://lic','attr',
             'deepseek-v4-flash','zh-v1',1,$5)`,
    [decisionId, draftId, decisionType, snapshotSpelling ?? spellNorm, sourceFactId],
  );
  const create = await ctx.post("/api/v1/admin/courses", {
    headers: { "x-csrf-token": csrf },
    data: {
      slug: `e2e-t8pb-${randomBytes(4).toString("hex")}`,
      title: `T8PB ${decisionType}`,
      level: "a1",
      description: "Path B",
    },
  });
  expect(create.status()).toBe(201);
  const { courseId, draftVersion } = (await create.json()) as {
    courseId: string;
    draftVersion: number;
  };
  const unitId = randomUUID();
  const unit = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
    headers: { "x-csrf-token": csrf },
    data: { title: "单元", description: "", draftVersion },
  });
  const vern = (await unit.json()).version as number;
  const itemId = randomUUID();
  const item = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
    headers: { "x-csrf-token": csrf },
    data: { unitId, lexicalEntryId: entryId, meaning: "苹果", draftVersion: vern },
  });
  expect(item.status()).toBe(201);
  await pool.query(
    `UPDATE draft_course_items SET provenance_kind='review', review_decision_id=$1 WHERE id=$2`,
    [decisionId, itemId],
  );
  return courseId;
}

async function seedPathBCourseMismatch(
  pool: Pool,
  ctx: APIRequestContext,
  csrf: string,
): Promise<string> {
  return seedPathBCourse(pool, ctx, csrf, "accept", `mismatch-${randomBytes(4).toString("hex")}`);
}

test.describe("Ticket 08 Path-B 发布资格 E2E", () => {
  test.describe.configure({ mode: "serial" });
  let sharedCtx: APIRequestContext;
  let sharedCsrf: string;
  let sharedPageCtx: import("@playwright/test").BrowserContext;

  test.beforeAll(async ({ browser, playwright }) => {
    test.skip(!apiUp && process.env.MOTRO_REQUIRE_DB !== "1", "需要运行中的 API 与隔离数据库");
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD");
    // 整组只登录一次：共享 API ctx + 共享已认证 page ctx。
    const { ctx, csrf } = await loginOnce(playwright);
    sharedCtx = ctx;
    sharedCsrf = csrf;
    sharedPageCtx = await authedBrowserContext(browser);
  });

  test.afterAll(async () => {
    if (sharedPageCtx) await sharedPageCtx.close();
    if (sharedCtx) await sharedCtx.dispose();
  });

  async function pageFromShared(): Promise<Page> {
    const page = await sharedPageCtx.newPage();
    return page;
  }

  test("[Path B] accepted + 完整 provenance → 可发布按钮显示", async () => {
    const pool = isolatedPool();
    let page: Page | undefined;
    try {
      const courseId = await seedPathBCourse(pool, sharedCtx, sharedCsrf, "accept");
      page = await pageFromShared();
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await page.getByRole("button", { name: /校验发布资格/ }).click();
      await expect(page.locator('section[aria-label="词项发布资格"]')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByRole("button", { name: /确认发布版本/ })).toBeVisible({
        timeout: 15000,
      });
    } finally {
      await pool.end();
      await page?.close();
    }
  });

  test("[Path B] rejected → 阻断，发布按钮不出现", async () => {
    const pool = isolatedPool();
    let page: Page | undefined;
    try {
      const courseId = await seedPathBCourse(pool, sharedCtx, sharedCsrf, "reject");
      page = await pageFromShared();
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await page.getByRole("button", { name: /校验发布资格/ }).click();
      await expect(page.locator('section[aria-label="词项发布资格"]')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator(".issue-item.blocking").first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("button", { name: /确认发布版本/ })).toHaveCount(0);
    } finally {
      await pool.end();
      await page?.close();
    }
  });

  test("[Path B] identity mismatch（snapshot spelling 与词条不符）→ 阻断", async () => {
    const pool = isolatedPool();
    let page: Page | undefined;
    try {
      const courseId = await seedPathBCourseMismatch(pool, sharedCtx, sharedCsrf);
      page = await pageFromShared();
      await page.goto(`/admin/courses/${courseId}/publishing`);
      await page.getByRole("button", { name: /校验发布资格/ }).click();
      await expect(page.locator('section[aria-label="词项发布资格"]')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator(".issue-item.blocking").first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("button", { name: /确认发布版本/ })).toHaveCount(0);
    } finally {
      await pool.end();
      await page?.close();
    }
  });
});
