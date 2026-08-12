import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    // admin-imports 独立栈使用 PW_BASE_URL=http://127.0.0.1:3101；其余默认 3001。
    baseURL: process.env.PW_BASE_URL ?? "http://127.0.0.1:3001",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // 用 npm run 以让 apps/web 的 node_modules/.bin 进入 PATH。
    command: "npm run build && npm run start",
    cwd: "apps/web",
    // admin-imports 独立栈使用 PW_WEB_PORT=3101（见 README「导入 E2E 运行说明」）；
    // 其余 spec 默认 3001。
    port: Number(process.env.PW_WEB_PORT ?? 3001),
    // compose 集成 job 复用已启动的 Web（PW_REUSE_SERVER=1）。
    reuseExistingServer: process.env.PW_REUSE_SERVER === "1" || !process.env.CI,
    timeout: 180_000,
  },
});
