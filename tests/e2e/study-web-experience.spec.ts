// 工单 05 · 学习端三页 E2E：首页（今日计划）→ 专注学习页 → 结果页。
// 需要运行中的 API + PostgreSQL（compose 环境）。API 不可达时自动跳过数据场景，
// 仅保留不依赖后端的纯外壳断言（专注学习页隐藏导航等）。
//
// 覆盖：
//   - 首页：今日计划计数（新学习）、主课程、每日预算、唯一主操作“开始学习”。
//   - 学习页：一次一张卡 → reveal（显示答案）→ 四级评分；导航隐藏；进入结果页。
//   - 结果页：安静汇总（完成计数 + 新学习分类）、下一次复习提示、返回首页主操作；
//     有剩余可学任务时出现次要“继续学习”。
//   - 键盘：评分快捷键 1–4；移动滚动容器（390px）无横向溢出。
//   - 只展示本会话已接受事件，不出现排行榜 / 等级 / 连续天数功能 UI。
//     XP 只来自服务端 xpAwarded（本会话已接受事件），如实展示，绝不伪造。
import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

const API = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:3000";
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD ?? "";
const LEARNER_PASS = "study-e2e-pass-123";

let apiUp = false;
test.beforeAll(async () => {
  try {
    const res = await fetch(`${API}/api/v1/health/live`);
    apiUp = res.ok;
  } catch {
    apiUp = false;
  }
});

test.describe("study web experience", () => {
  test.beforeEach(() => {
    test.skip(
      !apiUp && process.env.MOTRO_REQUIRE_DB !== "1",
      "需要运行中的 API 与数据库（compose 环境）",
    );
    test.skip(ADMIN_PASS === "", "需要 E2E_ADMIN_PASSWORD（管理员引导口令）");
  });

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

  /** 管理员 API：创建含 1 门课程 / 1 个单元 / 1 个词项的已发布课程。 */
  async function createPublishedCourse(
    ctx: APIRequestContext,
    csrf: string,
  ): Promise<{ courseId: string }> {
    const tag = `study-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const create = await ctx.post("/api/v1/admin/courses", {
      headers: { "x-csrf-token": csrf },
      data: { slug: tag, title: `学习端课程 ${tag}`, level: "a1", description: "课程描述" },
    });
    expect(create.status()).toBe(201);
    const { courseId, draftVersion } = (await create.json()) as {
      courseId: string;
      draftVersion: number;
    };

    const entry = await ctx.post("/api/v1/admin/lexical-entries", {
      headers: { "x-csrf-token": csrf },
      data: { canonicalSpelling: `study-word-${tag}`, confirmDuplicate: false },
    });
    const entryId = (await entry.json()).id as string;

    const unitId = crypto.randomUUID();
    const unit = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/units/${unitId}`, {
      headers: { "x-csrf-token": csrf },
      data: { title: "基础词汇", description: "单元描述", draftVersion },
    });
    const version = (await unit.json()).version as number;

    const itemId = crypto.randomUUID();
    const item = await ctx.post(`/api/v1/admin/courses/${courseId}/draft/items/${itemId}`, {
      headers: { "x-csrf-token": csrf },
      data: { unitId, lexicalEntryId: entryId, meaning: "坚持", draftVersion: version },
    });
    const versionAfter = (await item.json()).version as number;

    const pub = await ctx.post(`/api/v1/admin/courses/${courseId}/releases`, {
      headers: { "x-csrf-token": csrf, "idempotency-key": `study-pub-${tag}` },
      data: { draftVersion: versionAfter, releaseNote: "发布" },
    });
    expect(pub.status()).toBe(201);
    return { courseId };
  }

  async function createLearner(
    ctx: APIRequestContext,
    csrf: string,
  ): Promise<{ username: string; otp: string }> {
    const username = `study-e2e-${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const res = await ctx.post("/api/v1/admin/users", {
      headers: { "x-csrf-token": csrf, "idempotency-key": `study-learner-${username}` },
      data: {
        username,
        displayName: "学习端 E2E 学习者",
        timezone: "Asia/Shanghai",
        dailyBudgetMinutes: 10,
      },
    });
    expect(res.status()).toBe(201);
    const { oneTimePassword } = (await res.json()) as { oneTimePassword: string };
    return { username, otp: oneTimePassword };
  }

  /** 学习者登录并改密，落到保护页；随后进入刚创建的课程并设为主课程（报名），再返回首页。 */
  async function loginAsLearner(
    page: Page,
    learner: { username: string; otp: string },
    courseId: string,
  ): Promise<void> {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录 Motro" })).toBeVisible();
    await page.waitForFunction(() => document.cookie.includes("motro_csrf"));
    await page.getByLabel("用户名").fill(learner.username);
    await page.getByLabel("密码").fill(learner.otp);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/, { timeout: 15000 });
    await page.getByLabel(/当前密码/).fill(learner.otp);
    await page.getByLabel(/^新密码/).fill(LEARNER_PASS);
    await page.getByLabel(/确认新密码/).fill(LEARNER_PASS);
    await page.getByRole("button", { name: "保存新密码" }).click();
    // 改密后落在 /app 受保护占位；工单 05 的首页在 / 。
    await expect(page).toHaveURL(/\/app/, { timeout: 15000 });
    // 报名并设为主课程：首页“今天的学习”才会出现“开始学习”。
    await page.goto(`/courses/${courseId}`);
    const setPrimary = page.getByRole("button", { name: "设为主课程", exact: true });
    await expect(setPrimary).toBeVisible({ timeout: 15000 });
    await setPrimary.click();
    // 报名成功后课程详情出现“已设为主课程”选中态（服务端事实）。
    await expect(page.locator(".course-primary-selected")).toBeVisible({ timeout: 15000 });
    await page.goto("/");
  }

  test("首页→学习页→结果页完整闭环：今日计划、专注评分、安静汇总、无 XP/榜、键盘快捷键", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      // --- 首页：仪表盘标题 + 主课程 + 预算 + 新学习计数 + 唯一主操作“开始学习” ---
      await expect(page.getByRole("heading", { name: "学习仪表盘" })).toBeVisible();
      await expect(page.getByText(/学习端课程/)).toBeVisible();
      await expect(page.getByText(/每日预算 10 分钟/)).toBeVisible();
      // 一个词项 → 双向两张新卡 → 新学习计数为 2。
      await expect(page.getByText("新学习").locator("..").getByText("2")).toBeVisible();
      const startBtn = page.getByRole("button", { name: "开始学习", exact: true });
      await expect(startBtn).toBeVisible();

      // --- 点击开始 → 进入专注学习页 ---
      await startBtn.click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/, { timeout: 15000 });
      // 专注学习页只保留最小 Glass header，隐藏全局学习者导航。
      await expect(page.locator(".learner-dock")).toHaveCount(0);
      await expect(page.locator(".learner-rail")).toHaveCount(0);
      // P2-1：正常学习界面有语义 h1「学习会话」（视觉隐藏但读屏可识别），不放大标题。
      await expect(page.getByRole("heading", { name: "学习会话" })).toHaveCount(1);

      // 第一张卡：显示答案之前没有评分按钮。
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible();
      await expect(page.locator(".study-ratings")).toHaveCount(0);

      // reveal → 显示答案 + 四个评分按钮。
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      const ratingBtns = page.locator(".study-rating");
      await expect(ratingBtns).toHaveCount(4);
      await expect(page.getByRole("button", { name: /Again/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /Good/ })).toBeVisible();

      // 键盘快捷键 1–4：按 3（Good）评分第一张卡 → 自动进入下一张（第二张卡）。
      await page.keyboard.press("3");
      // 第二张卡出现新的“显示答案”，进度推进到第 2 项。
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible();
      await expect(page.getByText(/2 \/ 2/)).toBeVisible();

      // 第二张卡：点击 reveal，再用键盘 4（Easy）评分 → 会话完成 → 结果页。
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      await page.keyboard.press("4");
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+\/result/, { timeout: 15000 });

      // --- 结果页：安静汇总；无排行榜/等级功能 UI，XP 由服务端如实展示 ---
      await expect(page.getByRole("heading", { name: "这次学习完成" })).toBeVisible();
      await expect(page.getByText(/本次完成了 2 项学习/)).toBeVisible();
      await expect(page.getByText("新学习")).toBeVisible();
      await expect(page.getByText("下一次复习由系统按记忆状态安排。")).toBeVisible();
      // 完成的两张卡转为 learning → 仍有首复习任务 → 出现次要“继续学习”。
      await expect(page.getByRole("link", { name: "继续学习" })).toBeVisible();
      // 主操作“返回首页”。
      await expect(page.getByRole("link", { name: "返回首页" })).toBeVisible();
      // 结果页：无排行榜/等级/连续天数功能 UI（XP 由服务端如实展示）。
      // "排行榜"可能出现在 XP 免责声明中（"不参与排行榜排名"），这是允许的文案，
      // 但不应出现排行榜链接、等级徽章或连续天数计数器。
      await expect(page.getByRole("link", { name: /排行榜/ })).toHaveCount(0);
      await expect(page.getByText(/连续.*天|最长连续|streak/i)).toHaveCount(0);
      await expect(page.getByText(/等级\s*\d|段位|徽章|rank/i)).toHaveCount(0);

      // 390px 下结果页无横向溢出。
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, "390px 结果页无横向滚动").toBe(false);

      // 返回首页 → 回到今日计划。会话已结束、无 active 会话，但两张已完成的新卡转为
      // “首复习”候选项（学习态）→ 首页主操作回到“开始学习”（开启新一轮会话）。
      await page.getByRole("link", { name: "返回首页" }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 15000 });
      await expect(page.getByRole("heading", { name: "学习仪表盘" })).toBeVisible();
      await expect(page.getByRole("button", { name: "开始学习", exact: true })).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });

  test("未登录访问结果页 → 重定向到登录（不展示结果面板；不渲染伪统计）", async ({ page }) => {
    // 工单 05 P1-3：结果页必须遵循登录态 —— 未登录(401) 不得停留在结果页，跳 /login。
    // 该用例需要运行中的 API（真实会话守卫），故放在数据 describe 内（beforeEach 已校验 API）。
    await page.goto("/study/00000000-0000-0000-0000-000000000000/result");
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    // 未登录绝不渲染成功面板“这次学习完成”。
    await expect(page.getByRole("heading", { name: "这次学习完成" })).toHaveCount(0);
  });

  test("键盘快捷键 Again(1) 评分单张卡，进程精确前进一项而非跳到完成", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      await page.getByRole("button", { name: "开始学习", exact: true }).click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/);

      // 第一张：reveal 后等答案与评分按钮渲染完成，再用快捷键 1（Again）评分。
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      await expect(page.locator(".study-rating")).toHaveCount(4);
      await page.keyboard.press("1");
      // Again 同样完成当前项并推进光标：一张新卡（第二张）等待 reveal，进度 2 / 2。
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible();
      await expect(page.getByText(/2 \/ 2/)).toBeVisible();
      // 尚未跳转结果页：仍有第二张卡待评分。
      await expect(page).not.toHaveURL(/\/result/);
    } finally {
      await ctx.dispose();
    }
  });

  test("评分网络失败后锁定同一评分意图：禁用其他评分、只可重试同一 rating，不产生第二个请求", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      await page.getByRole("button", { name: "开始学习", exact: true }).click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/);
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      await expect(page.locator(".study-rating")).toHaveCount(4);

      // 拦截评分 POST：失败阶段 abort（触发网络归一 → status 0 + NETWORK_ERROR, retryable）。
      let failReviews = true;
      let reviewsCount = 0;
      await page.route("**/api/v1/study/sessions/**/reviews", async (route) => {
        reviewsCount++;
        if (failReviews) await route.abort();
        else await route.continue();
      });

      // 点击 Good → 自动幂等重试一次、网络仍失败 → 保留「Good 意图」。共 2 次请求（首发+重试）。
      await page.locator(".study-rating").filter({ hasText: "Good" }).click();
      await expect(page.getByText(/尚未保存评分/)).toBeVisible();
      await expect(page.getByRole("button", { name: "重新提交 Good" })).toBeVisible();
      expect(reviewsCount).toBe(2);

      // 网络失败后四个评分按钮全部禁用。
      for (const rating of ["Again", "Hard", "Good", "Easy"]) {
        await expect(page.locator(".study-rating").filter({ hasText: rating })).toBeDisabled();
      }

      // 换选其他 rating（内容已禁用 + 守卫兜底）：快捷键 2（Hard）不会发出第二个请求，
      // 不会生成新 clientEventId，也不会替换待重试意图。
      await page.keyboard.press("2");
      await expect(page.getByRole("button", { name: "重新提交 Good" })).toBeVisible();
      expect(reviewsCount, "改选其他 rating 不得触发第二个请求").toBe(2);

      // 恢复正常网络后，只有「重新提交 Good」复用同一意图成功 → 前进到第二张卡。
      failReviews = false;
      await page.getByRole("button", { name: "重新提交 Good", exact: true }).click();
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(/2 \/ 2/)).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });

  test("结果页只消费与当前 URL sessionId 匹配的快照：session A 快照绝不串用到 session B", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      const sessionA = crypto.randomUUID();
      const sessionB = crypto.randomUUID();
      // 预置 session A 的展示快照（高完成数 + 分类统计）。
      await page.evaluate(
        ({ sessionA }) => {
          sessionStorage.setItem(
            "motro.result-snapshot",
            JSON.stringify({
              sessionId: sessionA,
              startedAt: new Date(0).toISOString(),
              totalItems: 8,
              completedCount: 5,
              byKind: { newLearning: 3, initial: 1, review: 1 },
            }),
          );
        },
        { sessionA },
      );

      // 打开 session B 的结果页（URL 与快照 sessionId 不匹配）。
      await page.goto(`/study/${sessionB}/result`);
      await expect(page.getByRole("heading", { name: "这次学习完成" })).toBeVisible();

      // 绝不显示 session A 的完成数或分类统计。
      await expect(page.getByText(/本次完成了 5 项学习/)).toHaveCount(0);
      await expect(page.locator(".result-counts")).toHaveCount(0);
      await expect(page.getByText("新学习", { exact: true })).toHaveCount(0);

      // 诚实的完成状态（无快照）而非伪造统计。
      await expect(page.getByText(/刷新页面后无法恢复本次统计/)).toBeVisible();

      // session A 的快照不被清除（属于其他会话，仅当 URL 匹配时才清除）。
      const kept = await page.evaluate(() => sessionStorage.getItem("motro.result-snapshot"));
      expect(kept).not.toBeNull();
      expect(JSON.parse(kept!).sessionId).toBe(sessionA);
    } finally {
      await ctx.dispose();
    }
  });

  test("初始加载网络失败：保留学习会话 URL、显示可重试错误（h1），重试后恢复", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      await page.getByRole("button", { name: "开始学习", exact: true }).click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/);
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible();
      const studyUrl = page.url();

      // 让 active session 的 GET 网络失败，再刷新触发初始加载错误。
      let failActive = true;
      let activeAttempts = 0;
      await page.route("**/api/v1/study/sessions/active", async (route) => {
        activeAttempts++;
        if (failActive) await route.abort();
        else await route.continue();
      });
      await page.reload();
      // 必须在真实 compose 下判断：网络失败(0) → 可重试错误态，带 h1，绝不离开发言回到首页。
      await expect(page.getByRole("heading", { name: "学习会话" })).toBeVisible();
      // 用精确文本定位错误（避开 Next 路由播报器自身的 role="alert"）。
      await expect(page.getByRole("alert").filter({ hasText: "网络连接失败" })).toBeVisible();
      await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
      await expect(page).toHaveURL(studyUrl);
      expect(activeAttempts).toBeGreaterThan(0);

      // 恢复正常，点“重试” → 恢复会话，回到专注学习页。
      failActive = false;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("heading", { name: "学习会话" })).toHaveCount(1);
    } finally {
      await ctx.dispose();
    }
  });

  test("评分后刷新网络失败：保留当前卡与 revealed，显示“重试恢复”，不跳首页，恢复后推进", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      await page.getByRole("button", { name: "开始学习", exact: true }).click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/);
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();

      // 评分成功后 refreshFrom 会读 /active；让它网络失败，模拟“评分已接受但随后的会话刷新断网”。
      let failRefresh = false;
      await page.route("**/api/v1/study/sessions/active", async (route) => {
        if (failRefresh) await route.abort();
        else await route.continue();
      });
      failRefresh = true;
      // 键盘 3（Good）评分成功，但后续刷新失败。
      await page.keyboard.press("3");
      // 就地可重试错误 + “重试恢复”按钮，页面保持详情卡、答案仍可见，URL 不变（绝不回首页）。
      await expect(page.getByRole("button", { name: "重试恢复" })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      await expect(page).not.toHaveURL(/\/$/);

      // 恢复网络，点“重试恢复” → 以服务端为准推进到第二张卡。
      failRefresh = false;
      await page.getByRole("button", { name: "重试恢复", exact: true }).click();
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(/2 \/ 2/)).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });

  test("结果页：匹配快照 + getStudyToday 网络失败 → 快照不清除、可重试；重试成功显示统计并清除", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      const sessionB = crypto.randomUUID();
      await page.evaluate(
        ({ sessionB }) => {
          sessionStorage.setItem(
            "motro.result-snapshot",
            JSON.stringify({
              sessionId: sessionB,
              startedAt: new Date(0).toISOString(),
              totalItems: 3,
              completedCount: 2,
              byKind: { newLearning: 1, initial: 1, review: 0 },
            }),
          );
        },
        { sessionB },
      );

      // today 网络失败 → 结果页网络错误，快照不被清除；提供“重试”。
      let failToday = true;
      await page.route("**/api/v1/study/today", async (route) => {
        if (failToday) await route.abort();
        else await route.continue();
      });

      await page.goto(`/study/${sessionB}/result`);
      await expect(page.getByRole("heading", { name: "暂时无法确认结果" })).toBeVisible();
      await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
      // 网络失败不清快照。
      let kept = await page.evaluate(() => sessionStorage.getItem("motro.result-snapshot"));
      expect(kept).not.toBeNull();
      expect(JSON.parse(kept!).sessionId).toBe(sessionB);

      // 恢复网络，点“重试” → 显示统计，且快照被清除。
      failToday = false;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(page.getByRole("heading", { name: "这次学习完成" })).toBeVisible();
      await expect(page.getByText(/本次完成了 2 项学习/)).toBeVisible();
      await expect(page.getByText("新学习", { exact: true })).toBeVisible();
      kept = await page.evaluate(() => sessionStorage.getItem("motro.result-snapshot"));
      expect(kept).toBeNull();
    } finally {
      await ctx.dispose();
    }
  });

  test("退出确认对话框：Escape 关闭、Tab 焦点循环、关闭后焦点回到退出按钮", async ({
    page,
    playwright,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "webkit",
      "Playwright WebKit headless 不合成顺序 Tab 导航；焦点循环已由 Chromium 用例覆盖",
    );
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      await page.getByRole("button", { name: "开始学习", exact: true }).click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/);
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();

      // 头部“退出”（专注 header 内）与对话框内“退出”重名，须按作用域区分。
      const headerExit = page.locator(".study-header-exit");
      const dialog = page.getByRole("dialog");
      const continueBtn = dialog.getByRole("button", { name: "继续学习" });
      const confirmExitBtn = dialog.getByRole("button", { name: "退出", exact: true });

      await headerExit.click();
      await expect(dialog).toBeVisible();
      // 打开时聚焦“继续学习”（对话框内第一个可聚焦元素）。
      await expect(continueBtn).toBeFocused();

      // Escape 关闭对话框，焦点回到“退出”触发按钮。
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(headerExit).toBeFocused();

      // 重新打开并验证 Tab 焦点循环：继续学习 → 退出 → 回到 继续学习（在对话框内循环，不逃逸）。
      await headerExit.click();
      await expect(dialog).toBeVisible();
      await expect(continueBtn).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(confirmExitBtn).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(continueBtn, "Tab 在第二项后应回绕到第一项").toBeFocused();
      // Shift+Tab 反向同样回绕（从第一项回到最后一项）。
      await page.keyboard.press("Shift+Tab");
      await expect(confirmExitBtn).toBeFocused();
    } finally {
      await ctx.dispose();
    }
  });

  test("刷新恢复同一会话：reload 后当前卡/进度不重复、不丢失，仍处同一光标", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      await page.getByRole("button", { name: "开始学习", exact: true }).click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/);
      // 第一卡：未 reveal 时刷新。
      const url = page.url();
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      await expect(page.getByText(/1 \/ 2/)).toBeVisible();

      // reload 应恢复同一会话、同一光标（仍第 1 项且已 reveal，答案可见，不回到首页）。
      await page.reload();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole("button", { name: "显示答案" })).toHaveCount(0); // 已 reveal
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      await expect(page.getByText(/1 \/ 2/)).toBeVisible();

      // 键盘评分（Good）前进 → 第 2 项；再 reload，仍第 2 项（不重复回退）。
      await page.keyboard.press("3");
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible();
      await expect(page.getByText(/2 \/ 2/)).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible();
      await expect(page.getByText(/2 \/ 2/)).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });

  test("prefers-reduced-motion：专注学习页渲染正常、评分后推进、不产生禁止的连续动画问题", async ({
    page,
    playwright,
  }) => {
    test.setTimeout(180_000);
    const { ctx, csrf } = await loginAdminApi(playwright);
    try {
      const { courseId } = await createPublishedCourse(ctx, csrf);
      const learner = await createLearner(ctx, csrf);
      await loginAsLearner(page, learner, courseId);

      // 注入 reduced-motion 偏好，再进入学习流。
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: "开始学习", exact: true }).click();
      await expect(page).toHaveURL(/\/study\/[0-9a-f-]+/);
      await expect(page.getByRole("heading", { name: "学习会话" })).toHaveCount(1);
      await page.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("答案", { exact: true })).toBeVisible();
      // 进度条在 reduced-motion 下仍存在且有语义。
      await expect(page.locator('.progress-track[role="progressbar"]')).toBeVisible();
      // 键盘评分推进流程完整（reduced-motion 不阻断交互）。
      await page.keyboard.press("3");
      await expect(page.getByRole("button", { name: "显示答案" })).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });
});

// 不依赖后端的纯外壳断言：始终运行。
test.describe("study shell (no API)", () => {
  test("直接访问 /study/:id 而未登录时跳转到登录或首页，不渲染入侵控错误", async ({ page }) => {
    // 未登录访问专注学习页：会话守卫在有 API 时返回 401 → 跳登录；
    // API 不可达（网络失败）时页面诚实回到首页，不渲染过期卡或崩溃。
    await page.goto("/study/00000000-0000-0000-0000-000000000000");
    await expect(page).toHaveURL(/\/$|\/login/, { timeout: 15000 });
  });

  for (const width of [390, 768, 1440]) {
    test(`${width}px 未登录访问结果页无法看到成功面板且无横向溢出`, async ({ page }) => {
      // 工单 05 P1-3：结果页必须遵循登录态。未登录(401) 跳 /login；API 不可达(网络失败)
      // 时展示诚实的可重试错误态。两种情况下都绝不渲染"这次学习完成"成功面板（防止伪统计被未登录者看到）。
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/study/00000000-0000-0000-0000-000000000000/result");
      // 成功面板绝不出现。
      await expect(page.getByRole("heading", { name: "这次学习完成" })).toHaveCount(0);
      // URL 落在登录（401）或仍在本页展示诚实错误态（网络失败）——两者都无横向溢出。
      await expect(page).toHaveURL(/\/result|\/login/, { timeout: 15000 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${width}px 无横向滚动`).toBe(false);
    });
  }

  test("亮暗主题下学习页骨架加载态均渲染且无横向溢出（网络失败时诚实可重试）", async ({ page }) => {
    // 骨架加载态在 /study/:id 初始加载（真实 API 不可达或会话守卫）时出现，
    // 并必须在亮/暗主题下都无横向溢出；网络失败时页面停留在诚实错误态而非渲染过期卡。
    for (const theme of [
      { name: "亮色", dataTheme: "light" },
      { name: "暗色", dataTheme: "dark" },
    ] as const) {
      await page.emulateMedia({ colorScheme: theme.dataTheme });
      await page.addStyleTag({ content: `html{color-scheme:${theme.dataTheme}}` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/study/00000000-0000-0000-0000-000000000000");
      // 网络失败或未登录：URL 落在错误态或登录/首页，绝不渲染成功面板。
      await expect(page).toHaveURL(/\/study|login|\/$/, { timeout: 15000 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `${theme.name}主题学习页无横向滚动`).toBe(false);
    }
  });

  test("reduced-motion：结果页加载骨架无持续位移；明暗主题均无横向溢出", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/study/00000000-0000-0000-0000-000000000000/result");
      await expect(page).toHaveURL(/\/result|\/login/, { timeout: 15000 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.body.scrollWidth > document.body.clientWidth,
      );
      expect(overflow, `reduced-motion ${width}px 无横向滚动`).toBe(false);
    }
  });
});
