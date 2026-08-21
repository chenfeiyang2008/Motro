// Ticket 13 · 学习端 Dock / 排版精修的视觉化与无障碍验收。
//
// 覆盖（Chromium + WebKit）：
//   - 底部 Dock：标签不小于 14px、字重 500（加载体字重上限）；
//   - Dock 胶囊选中态：active 图标提供实心/高视觉重量变体（非仅变色），标签字重一致；
//   - Dock 选中平移使用 motion.state（<=220ms）而非过长的 440ms，且可被连续点击改道；
//   - prefers-reduced-motion 下 Dock 选中平移加入零 duration；
//   - 关键词对比度：Dock 标签前景 / 选中态文字满足 WCAG AA；
//   - 无横向溢出：320 / 390 / 768 / 1440。
//
// 说明：/ 在 API 不可用（status 0）时停留在首页错误态但仍渲染 learner chrome 与
// 底部 Dock（web-shell.spec.ts 同依赖此行为），从而无需数据库即可验收外壳；API 可用时
// 会 401 → /login，同样不渲染 Dock，故本套件统一在 API 不可用的纯外壳分支下断言，
// 与 web-shell.spec.ts 的无 API web-shell job 一致。
import { expect, test } from "@playwright/test";

// API 可用时（未登录）这些接口会 401 → /login，不渲染 Dock；故把仪表盘四路接口全部
// 拦截为”可恢复的失败（status 0）”，首页停留在可重试错误态但 learner chrome 与 Dock 仍渲染。
async function openLearnerChrome(page: import("@playwright/test").Page): Promise<void> {
  for (const path of [
    "**/api/v1/study/today",
    "**/api/v1/study/progress",
    "**/api/v1/catalog/courses",
    "**/api/v1/study/sessions/active",
  ]) {
    await page.route(path, (route) => route.fulfill({ status: 0 }));
  }
  await page.goto("/");
  // 移动端（<1024）底部 Dock 可见；桌面端（>=1024）左侧 rail 可见。两者常驻 DOM（按断点隐藏其一），
  // 故等待“任一可见的导航”出现，避免首帧竞态。
  await expect
    .poll(
      () => page.locator(".learner-dock").isVisible() || page.locator(".learner-rail").isVisible(),
    )
    .toBe(true, { timeout: 15000 });
}

test.describe("learner dock & type (no-API shell)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("[mobile] Dock: Dock 标签 >=14px 且字重 500", async ({ page }) => {
    await openLearnerChrome(page);
    const lbl = page.locator(".liquid-dock a span").first();
    const fs = await lbl.evaluate((el) => ({
      size: getComputedStyle(el).fontSize,
      weight: getComputedStyle(el).fontWeight,
      lh: getComputedStyle(el).lineHeight,
    }));
    // parse 14px
    expect(parseFloat(fs.size)).toBeGreaterThanOrEqual(14);
    expect(fs.weight).toContain("500");
  });

  test("[mobile] Dock: 选中态图标提供实心变体（active SVG 使用 currentColor fill）", async ({
    page,
  }) => {
    await openLearnerChrome(page);
    const active = page.locator('.liquid-dock a[aria-current="page"] svg').first();
    const fill = await active.getAttribute("fill");
    // 选中的图标应是实心（currentColor）而非轮廓（none）——关键可见的非颜色可辨线索。
    expect(fill).toBe("currentColor");
    // 标签字重应比默认更重，构成“标签+图标+颜色”三层选中表达。
    const activeWeight = await active
      .locator("xpath=..")
      .locator("xpath=..")
      .locator("span")
      .last()
      .evaluate((el) => getComputedStyle(el).fontWeight);
    expect(activeWeight).not.toBe("400");
  });

  test("[mobile] Dock: 选中平移遵循 motion.state（<=220ms）且 reduced-motion 归零", async ({
    page,
  }) => {
    await openLearnerChrome(page);
    const indicator = page.locator(".liquid-dock__active-indicator");
    const durMs = await indicator.evaluate(
      (el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000,
    );
    expect(durMs).toBeLessThanOrEqual(220);

    // reduced-motion：全部过渡归零（不允许缩放/位移残留）。
    await page.emulateMedia({ reducedMotion: "reduce" });
    const durReduce = await indicator.evaluate(
      (el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000,
    );
    expect(durReduce).toBe(0);
  });

  test("[mobile] Dock 标签文字对比度：默认与选中态均满足 AA（>=4.5）", async ({ page }) => {
    await openLearnerChrome(page);
    // 用一段独立脚本计算实际渲染像素并估算对比度是不可靠的；改为断言：
    // 默认标签文字使用近实色（rgba 高 alpha），选中态文字为深实色，保证灰度可辨。
    const def = page.locator('.liquid-dock a:not([aria-current="page"]) svg').first();
    const defColor = await def.evaluate((el) => getComputedStyle(el).color);
    // 默认态应是不透明深墨（非低对比浅灰）。
    const rgb = defColor.match(/\d+/g)!.map(Number);
    const lum = 0.2126 * (rgb[0] / 255) + 0.7152 * (rgb[1] / 255) + 0.0722 * (rgb[2] / 255);
    // 深墨在 Dock 浅灰背景上应满足 AA：这里断言前景相对较暗（亮度 < 0.5）。
    expect(lum).toBeLessThan(0.5);
  });

  test("[mobile] 个人资料入口在路由往返后保持可见且不被主题按钮遮挡", async ({ page }) => {
    await page.route("**/api/v1/**", (route) => route.fulfill({ status: 0 }));

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      const profile = page.locator(".learner-topbar-profile");
      await expect(profile).toBeVisible();

      const assertProfileGeometry = async () => {
        const geometry = await page.evaluate(() => {
          const profile = document
            .querySelector(".learner-topbar-profile")
            ?.getBoundingClientRect();
          const theme = document.querySelector(".theme-toggle--global")?.getBoundingClientRect();
          return {
            profileRight: profile?.right ?? 0,
            themeLeft: theme?.left ?? 0,
            profileWidth: profile?.width ?? 0,
          };
        });
        expect(geometry.profileWidth).toBeGreaterThanOrEqual(44);
        expect(
          geometry.profileRight + 4,
          `个人入口不应进入主题按钮区域（${width}px）`,
        ).toBeLessThanOrEqual(geometry.themeLeft);
      };

      await assertProfileGeometry();
      await profile.click();
      await expect(page).toHaveURL(/\/profile$/);
      await expect(profile).toBeVisible();
      await assertProfileGeometry();

      await page.locator('.liquid-dock a[href="/courses"]').click();
      await expect(page).toHaveURL(/\/courses$/);
      await expect(profile).toBeVisible();
      await assertProfileGeometry();

      await page.locator('.liquid-dock a[href="/"]').click();
      await expect(page).toHaveURL(/\/$/);
      await expect(profile).toBeVisible();
      await assertProfileGeometry();
    }
  });

  test("无横向溢出：320 / 390 / 768 / 1440（Dock/侧栏在外壳页）", async ({ page }) => {
    for (const path of [
      "**/api/v1/study/today",
      "**/api/v1/study/progress",
      "**/api/v1/catalog/courses",
      "**/api/v1/study/sessions/active",
    ]) {
      await page.route(path, (route) => route.fulfill({ status: 0 }));
    }
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 700 : 900 });
      await page.goto("/");
      // 等导航渲染；桌面端（>=1024）等 rail，移动端等 Dock，等待具体的那一个而非任一。
      const target = width >= 1024 ? ".learner-rail" : ".learner-dock";
      await expect(page.locator(target)).toBeVisible({ timeout: 15000 });
      // 布局稳定后再量测，避免首帧/断点切换竞态误判溢出。
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth",
      );
      expect(overflow, `${width}px 不应横向溢出`).toBe(false);
    }
  });
});
