import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3001",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // 用 npm run 以让 apps/web 的 node_modules/.bin 进入 PATH。
    command: "npm run build && npm run start",
    cwd: "apps/web",
    port: 3001,
    // compose 集成 job 复用已启动的 Web（PW_REUSE_SERVER=1）。
    reuseExistingServer: process.env.PW_REUSE_SERVER === "1" || !process.env.CI,
    timeout: 180_000,
  },
});
