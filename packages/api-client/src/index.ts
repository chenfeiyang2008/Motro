// @motro/api-client — 由 OpenAPI 生成的版本化 API 契约类型边界。
// 只允许通过此处的类型访问服务端契约；生成命令：pnpm openapi:types。
import type { paths } from "./generated.js";
export type { components, operations, paths, webhooks } from "./generated.js";
export type ApiPaths = keyof paths;
