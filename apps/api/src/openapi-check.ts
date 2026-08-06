// 校验已提交的 OpenAPI 产物与源码生成结果一致（CI 用）。
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createApp } from "./bootstrap-app.js";
import { OPENAPI_OUT } from "./openapi-generate.js";

async function main(): Promise<void> {
  const app = await createApp();
  const config = new DocumentBuilder()
    .setTitle("Motro API")
    .setDescription("Motro v1 版本化 REST API（认证与词条管理）")
    .setVersion("v1")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const generated = JSON.stringify(document, null, 2);
  await app.close();

  const committed = readFileSync(OPENAPI_OUT, "utf8");
  if (generated === committed) {
    console.log("openapi:check — OK");
    return;
  }
  console.error("openapi:check — OpenAPI 与已提交产物不一致，请运行 pnpm openapi:generate");
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`openapi:check 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
