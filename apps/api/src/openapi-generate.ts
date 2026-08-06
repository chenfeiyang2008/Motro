// 从 API 源码生成可审阅的 OpenAPI 3 文档（docs/generated/openapi.json）。
import "reflect-metadata";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createApp } from "./bootstrap-app.js";

export const OPENAPI_OUT = resolve(process.cwd(), "docs/generated/openapi.json");

async function main(): Promise<void> {
  const app = await createApp();
  const config = new DocumentBuilder()
    .setTitle("Motro API")
    .setDescription("Motro v1 版本化 REST API（认证与词条管理）")
    .setVersion("v1")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  mkdirSync(dirname(OPENAPI_OUT), { recursive: true });
  writeFileSync(OPENAPI_OUT, JSON.stringify(document, null, 2));
  await app.close();
}

main().catch((err: unknown) => {
  console.error(`openapi:generate 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
