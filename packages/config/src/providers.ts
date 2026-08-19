// 阶段 7 工单 22：真实 Provider 配置边界（Wiktionary / DeepSeek）。
//
// 本文件只含 Zod schema 与类型推导，不 import Nest、pg、Graphile 或网络库。
// 默认值保证：MOTRO_PROVIDER_MODE=fake、DEEPSEEK_ENABLED=false、
// MOTRO_WIKTIONARY_ALLOW_NETWORK=false → 零真实网络。
// 生产 real 模式必须显式提供 deepseek.apiKey（否则 fail-fast）。
import { z } from "zod";

// ---- Provider mode ----

export const ProviderModeSchema = z.enum(["fake", "real"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

// ---- Wiktionary ----

/**
 * Wiktionary API 配置。allowNetwork 默认 false（内网 fake-only）。
 * 真实网络必须 MOTRO_WIKTIONARY_ALLOW_NETWORK=1 显式开启。
 * hostAllowlist 仅允许配置的域名（SSRF 防护）。
 */
export const WiktionaryProviderSchema = z.object({
  /** MediaWiki Action API 基础 URL（含 query 参数入口）。 */
  apiBaseUrl: z.string().url(),
  /** 请求 User-Agent；必须包含项目名与联系邮箱（Wiktionary 合规要求）。 */
  userAgent: z.string().min(1),
  /** 是否允许真实网络请求。false → handler 抛 WIKI_TRANSIENT（fail-closed）。 */
  allowNetwork: z.boolean(),
  /** 请求超时（毫秒）。 */
  timeoutMs: z.coerce.number().int().positive(),
  /** 响应体最大字节数（超出 → WIKI_RESPONSE_TOO_LARGE）。 */
  maxResponseBytes: z.coerce.number().int().positive(),
  /** 允许访问的主机名白名单（SSRF 防护）。每个条目为纯 hostname/IP，不含 scheme/path。 */
  hostAllowlist: z.array(z.string().min(1)),
});
export type WiktionaryProviderConfig = z.infer<typeof WiktionaryProviderSchema>;

// ---- DeepSeek ----

/**
 * DeepSeek API 配置。enabled 默认 false（内网 fake-only）。
 * 真实网络必须 DEEPSEEK_ENABLED=true 显式开启；apiKey 在 production 时为必填 secret。
 * apiKey 只从环境变量/部署 secret 注入；不得写入仓库、日志、错误响应或 OpenAPI。
 */
export const DeepSeekProviderSchema = z.object({
  /** 是否启用真实 DeepSeek 网络。false → handler 抛 DRAFT_NETWORK_ERROR。 */
  enabled: z.boolean(),
  /**
   * API Key（secret）。仅当 enabled=true 且生产 real 模式时必须提供（cross-field 校验）。
   * 可选性：fake-only 部署天然无 key；真实网络启用时由 config.ts 生产校验强制非空。
   * 不写入仓库/日志/OpenAPI。
   */
  apiKey: z.string().min(1).optional(),
  /** API 基础 URL（含 /chat/completions 路径）。 */
  apiBaseUrl: z.string().url(),
  /** 模型标识（如 deepseek-chat）。 */
  model: z.string().min(1),
  /** 请求超时（毫秒）。 */
  timeoutMs: z.coerce.number().int().positive(),
  /** 响应体最大字节数。 */
  maxResponseBytes: z.coerce.number().int().positive(),
});
export type DeepSeekProviderConfig = z.infer<typeof DeepSeekProviderSchema>;
