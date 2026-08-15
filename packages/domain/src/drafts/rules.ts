// 阶段 6 工单 06：DeepSeek draft 纯领域规则（内网、零网络、Fake-only foundation）。
//
// 本文件只含无副作用、可确定性单测的纯规则：
//   - draft identity / input hash / request hash / response hash（结构化长度前缀编码，防碰撞）；
//   - prompt 输入规范化（只允许受控短文本字段，绝不信任任意文本）；
//   - 响应 schema 验证（白名单字段、类型/长度/字符、多余字段拒绝、CJK 基础检测）；
//   - draft 状态机与错误分类（复用 D 已建立的 WIKI 错误分类，扩展 DRAFT_*）；
//   - model identity 治理（configured alias ≠ resolved provider model ≠ fingerprint，MD-15）。
//
// 本模块不 import Nest、pg、Graphile 或网络库；不触网、不读密钥、不读盘。
import { createHash } from "node:crypto";

// ---- 控制字符（用可读 \u 转义，避免字面控制字节破坏格式/可移植性）----
// C0 控制字符 0x00..0x1f + 0x7f(DEL) + U+2028/U+2029 行分隔符。
// eslint-disable-next-line no-control-regex -- 有意匹配 C0/DEL/行分隔符控制字符以剥离不可信文本
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

// ---- draft 状态枚举 ----

export const DRAFT_STATUSES = [
  "drafting",
  "draft_ready",
  "retry_wait",
  "manual_action",
  "failed",
  "superseded",
  "restricted_model_identity",
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_TERMINAL_STATUSES: ReadonlySet<DraftStatus> = new Set([
  "draft_ready",
  "failed",
  "manual_action",
  "superseded",
  "restricted_model_identity",
]);

/** draft 状态是否可作为等待人工审核的最终候选（供 Ticket 07 消费）。 */
export function isReviewableDraft(status: DraftStatus): boolean {
  return status === "draft_ready";
}

// ---- stable identity / hash ----

/**
 * 结构化长度前缀编码（复刻 operationInputHash 的 vlen 模式）：把 N 个组件拼接为
 * 确定性字符串，长度前缀防止构造性碰撞（`[ab, c]` 与 `[a, bc]` 不产生同一串）。
 */
export function draftLenPrefixedJoin(parts: Array<string | number>): string {
  return parts.map((p) => `${String(p).length}:${String(p)}`).join("");
}

export interface DraftInput {
  /** 稳定 commit row（operation target 亦指向它）。 */
  importBatchCommitRowId: string;
  lexicalEntryId: string;
  /** Ticket 05 accepted source fact identity（64 位 hex）。 */
  wiktionarySourceFactId: string;
  /** 受控、可入 prompt 的英文拼写。 */
  englishSpelling: string;
  partOfSpeech: string | null;
  /** 截断/清洗后的受控英文定义摘要。 */
  englishDefinitionExcerpt: string;
  /** 服务端配置批准的模型别名（如 deepseek-v4-flash）。 */
  configuredModelAlias: string;
  /** 服务端固定 prompt 模板版本（如 zh-draft-v1）。 */
  promptTemplateVersion: string;
  operationInputVersion: number;
}

/**
 * input_hash：对【结构化、规范化后】的受控字段做 SHA-256。promptTemplateVersion 已并入，
 * 模板变化 → input_hash 变化 → 新 operation/draft 意图（绝不覆盖旧草稿）。
 * 例句不入 hash（例句不在本票范围）。
 */
export function draftInputHash(input: DraftInput): string {
  return createHash("sha256")
    .update(
      draftLenPrefixedJoin([
        "wiktionary-draft:v1",
        input.importBatchCommitRowId,
        input.lexicalEntryId,
        input.wiktionarySourceFactId,
        input.englishSpelling.trim().toLowerCase(),
        (input.partOfSpeech ?? "").trim().toLowerCase(),
        input.englishDefinitionExcerpt.trim(),
        input.configuredModelAlias,
        input.promptTemplateVersion,
        String(input.operationInputVersion),
      ]),
    )
    .digest("hex");
}

/**
 * request_hash：同输入为「重放意图去重」服务；request 参数变化（模型别名/模板/maxTokens/
 * temperature）应产生不同 request，故 request_hash 绑定这些「配置→请求」参数。
 * temperature 恒为 0（MD-05），仍纳入以反映请求身份。
 */
export function draftRequestHash(options: {
  configuredModelAlias: string;
  promptTemplateVersion: string;
  inputHash: string;
  maxTokens: number;
  temperature: number;
}): string {
  return createHash("sha256")
    .update(
      draftLenPrefixedJoin([
        "wiktionary-draft:request:v1",
        options.configuredModelAlias,
        options.promptTemplateVersion,
        options.inputHash,
        String(options.maxTokens),
        String(options.temperature),
      ]),
    )
    .digest("hex");
}

/** response_hash：规范化后的响应对象 JSON 的 SHA-256；用于变更检测，不用于声称逐字相同。 */
export function draftResponseHash(normalizedJson: string): string {
  return createHash("sha256").update(normalizedJson).digest("hex");
}

// ---- prompt 输入规范化 ----

/** 允许进入 prompt 的受控字段枚举（严格白名单；例句明确排除）。 */
export type PromptDataField = "englishSpelling" | "partOfSpeech" | "englishDefinitionExcerpt";

const PROMPT_FIELD_MAX: Record<PromptDataField, number> = {
  englishSpelling: 1000,
  partOfSpeech: 64,
  englishDefinitionExcerpt: 2000,
};

/**
 * 从 DraftInput 抽出可进入 prompt 的受控字段（规范化：去控制符、去 HTML/脚本/URL 形态、
 * 截断到上限）。返回值是【结构化的字段值 map】，由调用方用 `<字段>…</字段>` 分隔放在
 * user message 的数据区，绝不作为指令。例句/其它字段一律不进入。
 */
export function normalizePromptData(input: {
  englishSpelling: string;
  partOfSpeech: string | null;
  englishDefinitionExcerpt: string;
}): Record<PromptDataField, string | null> {
  const clean = (s: string): string =>
    s
      .replace(CONTROL_CHARS_RE, " ")
      // 先整体剥离 script 块（含内容），再剥离普通标签，再清洗 URL。
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
      .replace(/https?:\/\/[^\s]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  return {
    englishSpelling:
      clean(input.englishSpelling).slice(0, PROMPT_FIELD_MAX.englishSpelling) || null,
    partOfSpeech: input.partOfSpeech
      ? clean(input.partOfSpeech).slice(0, PROMPT_FIELD_MAX.partOfSpeech) || null
      : null,
    englishDefinitionExcerpt:
      clean(input.englishDefinitionExcerpt).slice(0, PROMPT_FIELD_MAX.englishDefinitionExcerpt) ||
      null,
  };
}

// ---- 响应 schema 验证 ----

/** 模型输出允许的最小字段（业务字段；resolvedProviderModel/fingerprint 由 adapter 解析）。 */
export const DRAFT_OUTPUT_ALLOWED_FIELDS = ["simplifiedChineseMeaning", "learningHint"] as const;

export type DraftOutputValidationResult =
  | { ok: true; meaning: string; learningHint: string | null }
  | { ok: false; code: string; reason: string };

const CJK_RE = /[一-鿿]/;

/**
 * 服务端 schema 验证模型输出对象：
 *   - JSON 必须是对象（非空）；
 *   - 白名单字段：多余字段 → DRAFT_EXTRA_FIELD；
 *   - simplifiedChineseMeaning 必填、1..120 字、必须含简体中文、无 <>/script/URL/控制字符；
 *   - learningHint 可空、0..80 字；
 *   - 语法/类型/空值错误 → 对应稳定 code。
 * 绝不返回原始 provider 文本；reason 为稳定安全文案。
 */
export function validateDraftOutput(value: unknown): DraftOutputValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "DRAFT_INVALID_JSON", reason: "草稿输出不是对象" };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(DRAFT_OUTPUT_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, code: "DRAFT_EXTRA_FIELD", reason: "草稿输出含多余字段" };
    }
  }
  const meaning = record.simplifiedChineseMeaning;
  if (typeof meaning !== "string") {
    return { ok: false, code: "DRAFT_SCHEMA_INVALID", reason: "草稿含义缺失或类型错误" };
  }
  if (meaning.length < 1 || meaning.length > 120) {
    return { ok: false, code: "DRAFT_OVER_LENGTH", reason: "草稿含义长度超限" };
  }
  if (!CJK_RE.test(meaning)) {
    return { ok: false, code: "DRAFT_UNSAFE_CONTENT", reason: "草稿含义缺少简体中文" };
  }
  if (CONTROL_CHARS_RE.test(meaning) || /[<>]/.test(meaning)) {
    return { ok: false, code: "DRAFT_UNSAFE_CONTENT", reason: "草稿含义含不安全字符" };
  }
  if (/<script[\s\S]*?<\/script>/i.test(meaning) || /https?:\/\//i.test(meaning)) {
    return { ok: false, code: "DRAFT_UNSAFE_CONTENT", reason: "草稿含义含脚本或链接" };
  }
  if (/ignore previous|system:|tool:|UPDATE|DELETE|INSERT|DROP/i.test(meaning)) {
    return { ok: false, code: "DRAFT_UNSAFE_CONTENT", reason: "草稿含义含注入残留" };
  }

  let learningHint: string | null = null;
  if (record.learningHint !== undefined && record.learningHint !== null) {
    if (typeof record.learningHint !== "string") {
      return { ok: false, code: "DRAFT_SCHEMA_INVALID", reason: "学习提示类型错误" };
    }
    if (record.learningHint.length > 80) {
      return { ok: false, code: "DRAFT_OVER_LENGTH", reason: "学习提示长度超限" };
    }
    if (CONTROL_CHARS_RE.test(record.learningHint) || /[<>]/.test(record.learningHint)) {
      return { ok: false, code: "DRAFT_UNSAFE_CONTENT", reason: "学习提示含不安全字符" };
    }
    learningHint = record.learningHint;
  }

  return { ok: true, meaning, learningHint };
}

// ---- model identity 治理（MD-15）----

/**
 * 从 provider 响应解析出的「实际模型身份」。只有 provider 在响应顶层明确返回的实际模型标识
 * 才可作为 resolvedProviderModel。system_fingerprint 不是模型版本。
 */
export interface ProviderModelIdentity {
  /** provider 响应明确的实际模型标识；不足则为 null（不得把配置别名/fingerprint 冒充）。 */
  resolvedProviderModel: string | null;
  /** 来自响应 system_fingerprint（单独字段；不是模型版本）。 */
  providerFingerprint: string | null;
}

/**
 * 判定 resolved_provider_model 是否足够构成「可验证的实际模型身份」。
 * 缺实际模型标识（null/空）→ 状态进入 restricted_model_identity → manual（MD-15）。
 * fingerprint 不能替代。
 */
export function isModelIdentitySufficient(identity: ProviderModelIdentity): boolean {
  return (
    typeof identity.resolvedProviderModel === "string" && identity.resolvedProviderModel.length > 0
  );
}

// ---- draft 错误分类（复用 D 分类，不重新定义操作状态）----

/** DRAFT 永久错误码（不可自动重试，需人工）。 */
export const DRAFT_PERMANENT_MANUAL_ERROR_CODES = new Set<string>([
  "DRAFT_AUTH_FAILED", // 401/403 认证类永久
  "DRAFT_BUDGET_EXCEEDED", // 402 余额不足 / 预算用尽
  "DRAFT_SOURCE_MISSING", // 来源事实缺失/歧义
  "DRAFT_MODEL_IDENTITY_INSUFFICIENT", // resolved_provider_model 不足
  "DRAFT_UNSAFE_CONTENT", // 不安全内容 / 注入残留（重试不自愈）
  "DRAFT_OVER_LENGTH", // 超长（重试不自愈）
  "DRAFT_SCHEMA_INVALID", // schema 不合格（重试不自愈）
  "DRAFT_EXTRA_FIELD", // 多余字段（重试不自愈）
]);

/** invalid JSON / 空输出：有限重试（至多 1 次）后可人工。 */
export const DRAFT_RETRYABLE_LIMITED_ERROR_CODES = new Set<string>([
  "DRAFT_INVALID_JSON",
  "DRAFT_EMPTY_OUTPUT",
]);

/** 网络/限流/服务端瞬态：自动重试。 */
export const DRAFT_TRANSIENT_ERROR_CODES = new Set<string>([
  "DRAFT_NETWORK_ERROR",
  "DRAFT_TIMEOUT",
  "DRAFT_RATE_LIMIT", // 429
  "DRAFT_SERVER_ERROR", // 5xx
]);

export type DraftErrorDisposition =
  | "manual_action"
  | "retry_limited" // 至多 1 次，再失败转 manual
  | "retryable";

/** 分类一个 DRAFT 错误码 → draft 层处置（区别于 operation 层 classifyError）。 */
export function classifyDraftError(code: string | undefined | null): DraftErrorDisposition {
  if (DRAFT_PERMANENT_MANUAL_ERROR_CODES.has(code ?? "")) return "manual_action";
  if (DRAFT_RETRYABLE_LIMITED_ERROR_CODES.has(code ?? "")) return "retry_limited";
  if (DRAFT_TRANSIENT_ERROR_CODES.has(code ?? "")) return "retryable";
  // 未知/空：保守视为 transient，由 maxAttempts 兜底（与 classifyError 语义一致）。
  return "retryable";
}
