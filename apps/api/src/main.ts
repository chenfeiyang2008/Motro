// API 入口。
import "reflect-metadata";
import { loadConfig } from "@motro/config";
import { createApp } from "./bootstrap-app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.api.port, "0.0.0.0");
  console.log(`motro-api listening on http://0.0.0.0:${config.api.port} (${config.env})`);
}

main().catch((err: unknown) => {
  console.error(`motro-api 启动失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
