// Web 外壳 E2E：路由、错误页、响应式与键盘可达性。不依赖 API 或数据库。
import { expect, test } from "@playwright/test";

test.describe("web shell", () => {
  test("学习者首页渲染占位内容", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Motro" })).toBeVisible();
    await expect(page.getByText("学习端占位页")).toBeVisible();
  });

  test("管理端路由渲染占位内容", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "管理端" })).toBeVisible();
  });

  test("未知路由显示可读的 404 页", async ({ page }) => {
    await page.goto("/no-such-route");
    await expect(page.getByRole("heading", { name: /404/ })).toBeVisible();
  });

  test("健康页在 API 不可用时显示可恢复状态而非原始异常", async ({ page }) => {
    await page.goto("/health");
    await expect(page.getByText(/API 暂不可用|API 正常/)).toBeVisible();
  });

  for (const width of [390, 768, 1440]) {
    test(`${width}px 视口无横向滚动`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto("/");
      const overflow = await page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth",
      );
      expect(overflow).toBe(false);
    });
  }

  test.describe("auth 表单键盘/焦点（无需 API）", () => {
    test("登录页用户名自动聚焦，表单控件键盘可达", async ({ page }, testInfo) => {
      await page.goto("/login");
      await expect(page.getByLabel("用户名")).toBeFocused();
      test.skip(
        testInfo.project.name === "webkit",
        "Playwright WebKit headless 不合成顺序 Tab 导航",
      );
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("密码")).toBeFocused();
    });

    test("改密页当前密码自动聚焦", async ({ page }) => {
      await page.goto("/change-password");
      await expect(page.getByLabel("当前密码")).toBeFocused();
    });

    test("登录按钮满足 44px 触控高度", async ({ page }) => {
      await page.goto("/login");
      const button = page.getByRole("button", { name: "登录", exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box && box.height).toBeGreaterThanOrEqual(44);
    });
  });

  test("跳过链接可聚焦且聚焦时从隐藏变为可见", async ({ page }) => {
    await page.goto("/");
    const skipLink = page.getByRole("link", { name: "跳到主要内容" });
    await expect(skipLink).toHaveCSS("opacity", "0");
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toHaveCSS("opacity", "1");
  });

  test("Tab 键可到达跳过链接（Chromium）", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "webkit",
      "Playwright WebKit headless 不合成顺序 Tab 导航；跳过链接可聚焦性已由跨浏览器用例覆盖",
    );
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
  });
});
