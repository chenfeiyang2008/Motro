// 阶段 6 工单 06：DeepSeek Fake Provider + Worker handler seam（内网、零网络）。
//
// 本 handler 是窄提供者缝（@motro/domain 的 OperationHandler），功能：
//   - 通过 operation 的目标 commit row 读取稳定的 normalized_spelling / lexical_entry_id；
//   - 读取 Ticket 05 accepted source fact identity（wiktionary_source_fact_id；本票只消费
//     已保存事实的 identity，不假设 05 表的其它物理形态）；
//   - 用确定性、无网络的 Fake Provider 产出固定 DeepSeek 结果（覆盖 成功/空/非JSON/JSON
//     错/extra field/不安全/超长/429/5xx/401/预算/模型身份不足 等 §16 fixture 矩阵）；
//   - 服务端 schema 验证（validateDraftOutput）：白名单字段、多余字段拒绝、CJK 基础检测；
//   - 对成功：构建 DeferredDraft 草稿，经 domain 校验后放入 result.deferredDrafts，
//     由 executeOperation 在【最终事务】中与 operation completion 一起写入
//     enrichment_drafts（原子、附录、同 identity 重放 no-op）；
//   - 对 error/manual_action/retryable：抛对应 DRAFT 错误码（不写任何 draft）。
//
// 强制边界（本文件）：
//   - 零网络：不发 HTTP、不访问 DNS、不读真实 key、不调用外部 URL；
//   - 不保存完整 prompt / 原始 provider response / 例句 / secret / 路径；
//   - resolved_provider_model 只保存把响应解析出的实际模型标识；不足为空 →
//     restricted_model_identity（MD-15；不伪造版本、不把 alias/fingerprint 冒充实际版本）；
//   - 仅在成功时写入 draft（error/retryable/manual 不写，维持人工解决后重试→成功的幂等路径）；
//   - operation target 仍是真实 import_batch_commit_row。
import type { Pool } from "pg";
import {
  OperationAbortError,
  draftInputHash,
  draftRequestHash,
  draftResponseHash,
  normalizePromptData,
  validateDraftOutput,
  validateDeferredDraft,
  type DeferredDraft,
  type OperationHandler,
  type OperationHandlerRegistry,
} from "@motro/domain";

export const DEEPSEEK_FAKE_TASK_IDENTIFIER = "motro-deepseek-fake";
export const DEEPSEEK_FAKE_QUEUE = "local";
/** Fake prompt 模板版本：参与 draft identity（同输入同模板 → 同一意图）。 */
export const FAKE_PROMPT_TEMPLATE_VERSION = "zh-draft-v1";
/** 配置批准的模型别名（滚动别名；实际解析模型由响应给出）。 */
export const CONFIGURED_MODEL_ALIAS = "deepseek-v4-flash";
export const FAKE_MAX_TOKENS = 400;
export const FAKE_TEMPERATURE = 0;

// ---- 行为选择（按 operation.input_version 确定性触发）----
// 对齐 to-agent-06 §16 fixture 矩阵编号。

export const IV_SUCCESS = 1; // 成功：最小中文草稿
export const IV_EMPTY_OUTPUT = 2; // 空响应（可重试，至多 1 次）
export const IV_NON_JSON = 3; // 非 JSON 文本（可重试，至多 1 次）
export const IV_JSON_SYNTAX_ERROR = 4; // JSON 语法错误（可重试，至多 1 次）
export const IV_SCHEMA_INVALID = 5; // JSON 但 schema 不合格（permanent）
export const IV_EXTRA_FIELD = 6; // 含多余字段（permanent）
export const IV_UNSAFE_CONTENT = 7; // HTML/script/URL/控制符（permanent）
export const IV_OVER_LENGTH = 9; // 超字段长度（permanent）
export const IV_RATE_LIMIT = 10; // 429（可重试）
export const IV_SERVER_ERROR = 11; // 5xx（可重试）
export const IV_CONNECTION_FAILURE = 12; // 连接失败（可重试）
export const IV_AUTH_FAILED = 16; // 401/403（manual_action）
export const IV_BUDGET_EXCEEDED = 17; // 402/预算（manual_action）
export const IV_MODEL_IDENTITY_INSUFFICIENT = 25; // resolved 空/不足（manual_action）
export const IV_SOURCE_MISSING = 23; // 来源事实缺失（manual_action）

// ---- Fake Provider 结果（确定性、无网络、无随机）----

export type FakeDraftOutcome =
  | {
      kind: "success";
      rawJson: string;
      resolvedProviderModel: string;
      providerFingerprint: string;
    }
  | {
      /** 模型返回了 JSON 对象，但服务端 validateDraftOutput 必然拒绝（多余字段/不合格/不安全等）。 */
      kind: "json_to_validate";
      rawJson: string;
      expectCode: string;
      resolvedProviderModel: string;
      providerFingerprint: string;
    }
  | { kind: "empty" }
  | { kind: "non_json" }
  | { kind: "json_syntax_error" }
  | { kind: "rate_limit" }
  | { kind: "server_error" }
  | { kind: "connection_failure" }
  | { kind: "auth_failed" }
  | { kind: "budget_exceeded" }
  | { kind: "model_identity_insufficient" }
  | { kind: "source_missing" };

/**
 * 确定性 Fake DeepSeek：同一 (inputVersion, englishSpelling) 永远返回同一结果。
 * 绝不发 HTTP、绝不访问 DNS、绝不读 key。
 * resolvedProviderModel 在成功时由「响应」明确返回；model_identity_insufficient 场景
 * 只返回 fingerprint、无实际模型标识（MD-15 正演）。
 */
export function fakeDeepseek(inputVersion: number, englishSpelling: string): FakeDraftOutcome {
  const norm = spellingNorm(englishSpelling);
  switch (inputVersion) {
    case IV_SUCCESS:
      return {
        kind: "success",
        // JSON mode：合法对象，仅含允许的业务字段。
        rawJson: JSON.stringify({
          simplifiedChineseMeaning: `${norm}的简体中文释义`,
          learningHint: "优先记忆名词义项",
        }),
        resolvedProviderModel: "deepseek-v4-flash-0731",
        providerFingerprint: "fp-abc123",
      };
    case IV_EMPTY_OUTPUT:
      return { kind: "empty" };
    case IV_NON_JSON:
      return { kind: "non_json" };
    case IV_JSON_SYNTAX_ERROR:
      return { kind: "json_syntax_error" };
    case IV_SCHEMA_INVALID:
      return {
        kind: "json_to_validate",
        rawJson: JSON.stringify({ simplifiedChineseMeaning: "有效含义", extraUnscoped: 1 }),
        expectCode: "DRAFT_EXTRA_FIELD",
        resolvedProviderModel: "deepseek-v4-flash-0731",
        providerFingerprint: "fp-abc123",
      };
    case IV_EXTRA_FIELD:
      return {
        kind: "json_to_validate",
        rawJson: JSON.stringify({
          simplifiedChineseMeaning: "有效含义",
          modelInjected: "x",
          url: "http://x",
        }),
        expectCode: "DRAFT_EXTRA_FIELD",
        resolvedProviderModel: "deepseek-v4-flash-0731",
        providerFingerprint: "fp-abc123",
      };
    case IV_UNSAFE_CONTENT:
      return {
        kind: "json_to_validate",
        rawJson: JSON.stringify({ simplifiedChineseMeaning: "run<script>alert(1)</script>的释义" }),
        expectCode: "DRAFT_UNSAFE_CONTENT",
        resolvedProviderModel: "deepseek-v4-flash-0731",
        providerFingerprint: "fp-abc123",
      };
    case IV_OVER_LENGTH:
      return {
        kind: "json_to_validate",
        rawJson: JSON.stringify({ simplifiedChineseMeaning: "一".repeat(200) }),
        expectCode: "DRAFT_OVER_LENGTH",
        resolvedProviderModel: "deepseek-v4-flash-0731",
        providerFingerprint: "fp-abc123",
      };
    case IV_RATE_LIMIT:
      return { kind: "rate_limit" };
    case IV_SERVER_ERROR:
      return { kind: "server_error" };
    case IV_CONNECTION_FAILURE:
      return { kind: "connection_failure" };
    case IV_AUTH_FAILED:
      return { kind: "auth_failed" };
    case IV_BUDGET_EXCEEDED:
      return { kind: "budget_exceeded" };
    case IV_MODEL_IDENTITY_INSUFFICIENT:
      return { kind: "model_identity_insufficient" };
    case IV_SOURCE_MISSING:
      return { kind: "source_missing" };
    default:
      return {
        kind: "success",
        rawJson: JSON.stringify({ simplifiedChineseMeaning: `${norm}的默认释义` }),
        resolvedProviderModel: "deepseek-v4-flash-0731",
        providerFingerprint: "fp-abc123",
      };
  }
}

function spellingNorm(s: string): string {
  return s.trim().replace(/\s+/g, " ").slice(0, 1000);
}

// ---- DRAFT 错误类（复用 D classification 类别，不重新定义操作状态机）----

export class DraftManualActionError extends Error {
  constructor(message: string, draftCode: string) {
    super(message);
    this.name = "DraftManualActionError";
    this.errorCode = draftCode;
  }
  readonly errorCode: string;
}

export class DraftPermanentError extends Error {
  constructor(message: string, draftCode: string) {
    super(message);
    this.name = "DraftPermanentError";
    this.errorCode = draftCode;
  }
  readonly errorCode: string;
}

export class DraftRetryableError extends Error {
  constructor(message: string, draftCode: string) {
    super(message);
    this.name = "DraftRetryableError";
    this.errorCode = draftCode;
  }
  readonly errorCode: string;
}

/** 读 operation 目标 commit row 的受控字段（只读稳定字段，绝不写业务事实）。 */
async function readTarget(
  pool: Pool,
  targetId: string,
): Promise<{
  normalizedSpelling: string;
  lexicalEntryId: string;
}> {
  const res = await pool.query<{ normalized_spelling: string; lexical_entry_id: string }>(
    `SELECT normalized_spelling, lexical_entry_id FROM import_batch_commit_rows WHERE id = $1`,
    [targetId],
  );
  const row = res.rows[0];
  if (!row)
    throw new DraftPermanentError("operation target commit row missing", "DRAFT_SOURCE_MISSING");
  return { normalizedSpelling: row.normalized_spelling, lexicalEntryId: row.lexical_entry_id };
}

/**
 * 从已保存的 Ticket 05 accepted source fact 取 identity。本票只消费「身份」，
 * 用于 draft.wiktionary_source_fact_id；source fact 表我们只按 identity 反查，
 * 找不到即视为来源缺失。
 */
async function resolveSourceFactId(pool: Pool, commitRowId: string): Promise<string | null> {
  const res = await pool.query<{ source_fact_identity: string }>(
    `SELECT source_fact_identity FROM wiktionary_source_facts
     WHERE commit_row_id = $1 AND status = 'fetched'
     ORDER BY created_at DESC LIMIT 1`,
    [commitRowId],
  );
  return res.rows[0]?.source_fact_identity ?? null;
}

/**
 * 构建一条 draft 的 deferred 草稿（纯函数，无副作用）。
 * 不调用 pool.query——draft 写入由 executeOperation 在最终事务中与 completeAttempt 同事务完成。
 */
function buildDraft(
  importBatchCommitRowId: string,
  lexicalEntryId: string,
  wiktionarySourceFactId: string,
  operationId: string,
  input: { englishSpelling: string; englishDefinitionExcerpt: string; partOfSpeech: string | null },
  inputVersion: number,
  outcome: {
    simplifiedChineseMeaning: string;
    learningHint: string | null;
    resolvedProviderModel: string;
    providerFingerprint: string;
  },
): DeferredDraft {
  const inputHash = draftInputHash({
    importBatchCommitRowId,
    lexicalEntryId,
    wiktionarySourceFactId,
    englishSpelling: input.englishSpelling,
    partOfSpeech: input.partOfSpeech,
    englishDefinitionExcerpt: input.englishDefinitionExcerpt,
    configuredModelAlias: CONFIGURED_MODEL_ALIAS,
    promptTemplateVersion: FAKE_PROMPT_TEMPLATE_VERSION,
    operationInputVersion: inputVersion,
  });
  const requestHash = draftRequestHash({
    configuredModelAlias: CONFIGURED_MODEL_ALIAS,
    promptTemplateVersion: FAKE_PROMPT_TEMPLATE_VERSION,
    inputHash,
    maxTokens: FAKE_MAX_TOKENS,
    temperature: FAKE_TEMPERATURE,
  });
  const responseHash = draftResponseHash(
    JSON.stringify({
      simplifiedChineseMeaning: outcome.simplifiedChineseMeaning,
      learningHint: outcome.learningHint,
    }),
  );
  return {
    draftKey: {
      importBatchCommitRowId,
      provider: "deepseek",
      configuredModelAlias: CONFIGURED_MODEL_ALIAS,
      promptTemplateVersion: FAKE_PROMPT_TEMPLATE_VERSION,
    },
    importBatchCommitRowId,
    lexicalEntryId,
    wiktionarySourceFactId,
    operationId,
    provider: "deepseek",
    configuredModelAlias: CONFIGURED_MODEL_ALIAS,
    resolvedProviderModel: outcome.resolvedProviderModel,
    providerFingerprint: outcome.providerFingerprint,
    promptTemplateVersion: FAKE_PROMPT_TEMPLATE_VERSION,
    inputHash,
    requestHash,
    responseHash,
    draftSchemaVersion: 1,
    status: "draft_ready",
    simplifiedChineseMeaning: outcome.simplifiedChineseMeaning,
    learningHint: outcome.learningHint,
    validationMetadata: {},
    errorCode: null,
    safeErrorSummary: null,
  };
}

/**
 * 构造 DeepSeek Fake handler。需要 db pool 以读取目标 commit row 与 source fact identity。
 * 行为由 operation.input_version 确定性选择（见 fixture 常量）。
 */
export function buildDeepSeekFakeHandler(pool: Pool): OperationHandlerRegistry {
  const registry = new Map<string, OperationHandler>();
  const handler: OperationHandler = {
    taskIdentifier: DEEPSEEK_FAKE_TASK_IDENTIFIER,
    async run(operationId, signal) {
      if (signal?.aborted) throw new OperationAbortError();
      const op = await pool.query<{
        target_type: string;
        target_id: string;
        input_version: number;
      }>(`SELECT target_type, target_id, input_version FROM application_operations WHERE id = $1`, [
        operationId,
      ]);
      const row = op.rows[0];
      if (!row) throw new DraftManualActionError("operation missing", "DRAFT_SOURCE_MISSING");
      if (row.target_type !== "import_batch_commit_row") {
        throw new DraftPermanentError("unsupported target type", "DRAFT_SOURCE_MISSING");
      }
      const target = await readTarget(pool, row.target_id);
      const sourceFactId = await resolveSourceFactId(pool, row.target_id);
      if (!sourceFactId) {
        throw new DraftManualActionError("来源事实缺失或存在歧义", "DRAFT_SOURCE_MISSING");
      }
      const inputVersion = row.input_version;
      const outcome = fakeDeepseek(inputVersion, target.normalizedSpelling);

      // ---- 失败/瞬态/人工：抛出对应 DRAFT 错误码（不写 draft）----
      switch (outcome.kind) {
        case "empty":
          throw new DraftRetryableError("模型返回空内容", "DRAFT_EMPTY_OUTPUT");
        case "non_json":
          throw new DraftRetryableError("解析失败", "DRAFT_INVALID_JSON");
        case "json_syntax_error":
          throw new DraftRetryableError("解析失败", "DRAFT_INVALID_JSON");
        case "rate_limit":
          throw new DraftRetryableError("服务繁忙，稍后重试", "DRAFT_RATE_LIMIT");
        case "server_error":
          throw new DraftRetryableError("服务暂时不可用", "DRAFT_SERVER_ERROR");
        case "connection_failure":
          throw new DraftRetryableError("网络连接失败", "DRAFT_NETWORK_ERROR");
        case "auth_failed":
          throw new DraftManualActionError("认证失败，请检查配置", "DRAFT_AUTH_FAILED");
        case "budget_exceeded":
          throw new DraftManualActionError("预算/配额不足", "DRAFT_BUDGET_EXCEEDED");
        case "model_identity_insufficient":
          // MD-15 正演：只有 fingerprint、无实际模型标识 → 模型身份不足 → manual；不伪造版本。
          throw new DraftManualActionError(
            "模型身份不足，需人工确认",
            "DRAFT_MODEL_IDENTITY_INSUFFICIENT",
          );
        case "source_missing":
          throw new DraftManualActionError("来源事实缺失或存在歧义", "DRAFT_SOURCE_MISSING");
        case "json_to_validate":
          break; // 交下方统一 JSON.parse + validateDraftOutput
        case "success":
          break;
      }

      // ---- 服务端校验（模型返回的 JSON）----
      const rawJson = outcome.rawJson;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        throw new DraftRetryableError("解析失败", "DRAFT_INVALID_JSON");
      }
      const validation = validateDraftOutput(parsed);
      if (!validation.ok) {
        const permanent =
          validation.code === "DRAFT_EXTRA_FIELD" ||
          validation.code === "DRAFT_UNSAFE_CONTENT" ||
          validation.code === "DRAFT_OVER_LENGTH" ||
          validation.code === "DRAFT_SCHEMA_INVALID";
        if (permanent) {
          throw new DraftPermanentError("草稿内容不合规", validation.code);
        }
        throw new DraftRetryableError("解析失败", validation.code);
      }

      // 构建 deferred draft（受控字段：拼写 / 定义摘要 / 词性）
      const normalized = normalizePromptData({
        englishSpelling: target.normalizedSpelling,
        partOfSpeech: "noun",
        englishDefinitionExcerpt: validation.meaning,
      });
      const draft = buildDraft(
        row.target_id,
        target.lexicalEntryId,
        sourceFactId,
        operationId,
        {
          englishSpelling: normalized.englishSpelling ?? target.normalizedSpelling,
          englishDefinitionExcerpt: normalized.englishDefinitionExcerpt ?? validation.meaning,
          partOfSpeech: normalized.partOfSpeech ?? "noun",
        },
        inputVersion,
        {
          simplifiedChineseMeaning: validation.meaning,
          learningHint: validation.learningHint,
          resolvedProviderModel: outcome.resolvedProviderModel,
          providerFingerprint: outcome.providerFingerprint,
        },
      );
      const v = validateDeferredDraft(draft);
      if (!v.ok) {
        throw new DraftPermanentError(
          `invalid deferred draft: ${v.reason}`,
          "DRAFT_SCHEMA_INVALID",
        );
      }
      return {
        outcome: "succeeded",
        summary: "DeepSeek 中文草稿已生成（draft_ready）",
        deferredDrafts: [draft],
      };
    },
  };
  registry.set(handler.taskIdentifier, handler);
  return registry;
}

export type { DeferredDraft };
