// 阶段 6 工单 05：Wiktionary source fact 纯领域规则（内网、零网络、Fake-only foundation）。
//
// 本文件只含无副作用、可确定性单测的纯规则：
//   - page / revision / source fact 的稳定身份推导（结构化长度前缀编码，防分隔符碰撞）；
//   - content SHA-256 推导（只对受控字段哈希，绝不包含 raw wikitext / provider payload）；
//   - 安全投影规则（白名单式字段裁剪，明确排除 raw wikitext / 例句 / 引用 / 图片 / 音频）；
//   - source fact 状态枚举与错误状态映射（复用 D 已建立的 WIKI 错误分类，不重新定义）。
//
// 本模块不 import Nest、pg、Graphile 或网络库；不触网、不读密钥、不读盘。
// 真实数据库 append-only 事实与 Worker handler 放 DB/Worker 层。
import { createHash } from "node:crypto";

// ---- 状态枚举 ----

/**
 * source fact 状态：与 operation 状态【分开保存】（本模块只定义纯枚举，
 * 物理列见 packages/db/src/schema/wiktionary.ts 与 0031 migration）。
 * 一次抓取只有一个事实记录；「未抓取」「失败重试中」不是本表的状态（失败在 operation）。
 */
export const SOURCE_FACT_STATUSES = [
  "pending",
  "fetched",
  "ambiguous",
  "error",
  "superseded",
] as const;
export type SourceFactStatus = (typeof SOURCE_FACT_STATUSES)[number];

// ---- 稳定身份 ----

/**
 * 结构化长度前缀编码（与 operationInputHash 同一模式）：把 N 个组件拼接为一个
 * 确定性字符串，长度前缀防止构造性碰撞（`[ab, c]` 与 `[a, bc]` 不产生同一串）。
 * 绝不使用时间、filename、随机值或裸 `|`/`:` 分隔符拼接作为身份。
 */
export function lengthPrefixedJoin(parts: Array<string | number>): string {
  return parts.map((p) => `${String(p).length}:${String(p)}`).join("");
}

/**
 * 一个 Wiktionary page 的稳定身份。page id 是 Wikipedia/Wiktionary 权威页 id；
 * canonical title 是展示/审计字段，不参与身份（title 可能变化，page id 稳定）。
 */
export function pageIdentity(options: { pageId: string; language: string }): string {
  return createHash("sha256")
    .update(lengthPrefixedJoin(["wiktionary:page", options.language, options.pageId]))
    .digest("hex");
}

/**
 * 一个 Wiktionary revision 的稳定身份。revision id + page id 唯一确定一次修订。
 * 不含 canonical title（title 只是别名），保证「同 revision 幂等」不受标题漂移影响。
 */
export function revisionIdentity(options: { pageId: string; revisionId: string }): string {
  return createHash("sha256")
    .update(lengthPrefixedJoin(["wiktionary:revision", options.pageId, options.revisionId]))
    .digest("hex");
}

/**
 * source fact 的【业务幂等身份】：同 page + 同 revision + 同 parser version
 * 只产生一条 source fact（重放 no-op，新 revision 产生新事实）。
 *
 * 设计要点：
 *   - 绑定 parserVersion：同一 page/revision 由不同 parser 解析产生的事实彼此独立
 *     （不同 parser 的「事实内容」不同），因此 identity 必须区分 parser；
 *   - 不含 fetched_at / 随机 / filename / 时间：这些都是「抓取动作」的属性，
 *     不是「事实」的身份；同一事实的重放必须映射到同一条记录；
 *   - 结构化长度前缀编码（见 lengthPrefixedJoin）防分隔符碰撞。
 */
export function sourceFactIdentity(options: {
  pageId: string;
  revisionId: string;
  parserVersion: string;
}): string {
  return createHash("sha256")
    .update(
      lengthPrefixedJoin([
        "wiktionary:fact",
        options.pageId,
        options.revisionId,
        options.parserVersion,
      ]),
    )
    .digest("hex");
}

/**
 * content SHA-256：只对受控的「事实内容」字段哈希（canonical title / normalized spelling /
 * language / part of speech / definition excerpt / source URL）。
 * 明确不含 raw wikitext、provider payload、例句、引用、图片、音频、fetch 时间。
 * 用途：content hash 不可静默覆盖（相同 content hash 才允许视为同一事实内容）。
 */
export function contentHash(options: {
  canonicalTitle: string;
  normalizedSpelling: string;
  language: string;
  partOfSpeech: string | null;
  definitionExcerpt: string;
  sourceUrl: string;
}): string {
  return createHash("sha256")
    .update(
      lengthPrefixedJoin([
        "wiktionary:content",
        options.canonicalTitle,
        options.normalizedSpelling,
        options.language,
        options.partOfSpeech ?? "",
        options.definitionExcerpt,
        options.sourceUrl,
      ]),
    )
    .digest("hex");
}

// ---- 安全投影 ----

/** 显式拒绝出现在 source fact 事实记录中的字段名（provider 正文 / 富媒体 / 原文）。 */
const EXCLUDED_PROJECTION_FIELDS = [
  "raw",
  "wikitext",
  "payload",
  "response",
  "html",
  "body",
  "example",
  "examples",
  "quote",
  "quotes",
  "image",
  "images",
  "audio",
  "video",
  "pronunciation",
  "ipa",
  "audioUrl",
  "etymology",
  "inflection",
] as const;
export type ExcludedProjectionField = (typeof EXCLUDED_PROJECTION_FIELDS)[number];

const EXCLUDED_RE = new RegExp(
  `\\b(?:${EXCLUDED_PROJECTION_FIELDS.map((f) => f.replace(/[A-Z]/g, (c) => `[a-z]${c.toLowerCase()}`)).join("|")})\\b`,
  "i",
);

/**
 * 从 provider 返回的对象投影出【安全事实字段】。
 *
 * 安全策略：
 *   - 白名单式：只允许已知的安全字段键；任何不在白名单的键都会被丢弃（绝不透传 provider
 *     附加字段，例如原始响应、例句、引用、图片、音频、HTML、wikitext）；
 *   - 键名匹配拒绝：即便键不在白名单，若键名匹配 EXCLUDED_RE（raw/wikitext/payload/
 *     example/quote/image/audio 等），直接视为不安全的 provider 字段并拒绝；
 *   - 值必须是 string / number / null（数字会转字符串）；对象/数组一律拒绝（不落库对象正文）。
 *
 * 返回 { ok, projected?, reason }：reason 为稳定的拒绝原因（不含 provider 原文）。
 */
export interface SafeProjectionResult {
  ok: boolean;
  projected?:
    | {
        canonicalTitle: string;
        normalizedSpelling: string;
        language: string;
        partOfSpeech: string | null;
        definitionExcerpt: string;
        sourceUrl: string;
      }
    | undefined;
  /** 稳定的拒绝原因（不含 provider 原文、不含字段值）。 */
  reason?: string;
}

const ALLOWED_KEYS = new Set([
  "canonicalTitle",
  "normalizedSpelling",
  "language",
  "partOfSpeech",
  "definitionExcerpt",
  "sourceUrl",
]);

/** 稳定、脱敏的拒绝原因：绝不回显 provider 原文/字段值。 */
export function projectionRejection(field: string): string {
  // 用固定安全文案 + 脱敏字段名（只保留 ASCII 字母，禁止用户可控片段进入日志）。
  const safe = field.replace(/[^A-Za-z]/g, "");
  if (safe.length === 0) return "source fact projection rejected (unsafe provider field)";
  return `source fact projection rejected (unsafe field: ${safe})`;
}

export function projectSourceFact(value: unknown): SafeProjectionResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "source fact projection rejected (not an object)" };
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string | null> = {};

  // 先检测任何不安全字段名（即使不在白名单，匹配即拒绝整条，防 provider 附加字段透传）。
  for (const key of Object.keys(record)) {
    if (EXCLUDED_RE.test(key)) {
      return { ok: false, reason: projectionRejection(key) };
    }
  }

  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) continue; // 白名单之外的键静默丢弃（不含原文透传）。
    const v = record[key];
    if (v === null || v === undefined) {
      out[key] = null;
    } else if (typeof v === "string") {
      out[key] = v;
    } else if (typeof v === "number") {
      out[key] = String(v);
    } else {
      return { ok: false, reason: `source fact projection rejected (non-scalar field: ${key})` };
    }
  }

  // 必填安全字段缺失 → 拒绝（稳定 reason，不依赖具体缺哪个值）。
  const required = [
    "canonicalTitle",
    "normalizedSpelling",
    "language",
    "definitionExcerpt",
    "sourceUrl",
  ] as const;
  for (const k of required) {
    const val = out[k];
    if (val === undefined || val === null || val.trim().length === 0) {
      return { ok: false, reason: projectionRejection(`missing_${k}`) };
    }
  }

  return {
    ok: true,
    projected: {
      canonicalTitle: out.canonicalTitle!,
      normalizedSpelling: out.normalizedSpelling!,
      language: out.language!,
      partOfSpeech: out.partOfSpeech ?? null,
      definitionExcerpt: out.definitionExcerpt!,
      sourceUrl: out.sourceUrl!,
    },
  };
}

// ---- 错误状态映射 ----

/**
 * source fact 的错误状态映射：把 D 已建立的 WIKI 错误码映射为事实状态与
 * 「是否允许自动重试」标志。复用 D 的分类（WIKI permanent / manual_action / retryable），
 * 绝不重新定义分类；source fact 状态与 operation 状态分开保存。
 */
export function sourceFactErrorState(errorCode: string | undefined | null): {
  status: SourceFactStatus;
  retryable: boolean;
} {
  if (errorCode === "WIKI_AMBIGUOUS") return { status: "ambiguous", retryable: false };
  // 一切其它 WIKI 错误（permanent / manual_action / retryable）都落 error 状态；
  // 重试与否由 operation 状态机（D 的 completeAttempt）决定，事实本身只是 error。
  return { status: "error", retryable: true };
}
