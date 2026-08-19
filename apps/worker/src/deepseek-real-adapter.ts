// 阶段 7 工单 22：真实 DeepSeek Adapter（网络、schema 校验、fail-closed）。
//
// 本 handler 是窄提供者缝（@motro/domain 的 OperationHandler），功能与 fake handler 对称：
//   - 通过 operation 目标 commit row 读取 normalized_spelling 与 lexical_entry_id；
//   - 读取 accepted source fact identity（wiktionary_source_fact_id）；
//   - 真实调用 DeepSeek Chat Completions API（POST /chat/completions）；
//   - 服务端 schema 校验（validateDraftOutput）：白名单字段、CJK 检测、拒绝 HTML/URL/控制符；
//   - 对成功：构建 DeferredDraft 草稿（与 fake 同一 shape），由 executeOperation 在最终
//     事务中写入 enrichment_drafts（原子、幂等、附录）。
//
// 安全边界：
//   - API Key 只从 config.deepseek.apiKey 读取（环境变量/secret 注入）；绝不写库/日志/错误；
//   - 缺少 Key → 任务级 fail-closed（DRAFT_AUTH_FAILED）；
//   - enabled=false → 任务级 fail-closed（DRAFT_NETWORK_ERROR）；
//   - endpoint/model/timeout/maxResponseBytes 可配置；
//   - 不保存完整 prompt / 原始 provider response / 例句 / secret / 路径；
//   - 仅返回固定脱敏错误码（safeErrorSummary 由 executor 处理）。
//
// 复用：
//   - readTarget / resolveSourceFactId / Draft*Error 类来自 deepseek-fake-handler；
//   - draftInputHash / draftRequestHash / draftResponseHash / normalizePromptData /
//     validateDraftOutput / validateDeferredDraft / isModelIdentitySufficient 来自 @motro/domain。
import type { Pool } from "pg";
import type { AppConfig } from "@motro/config";
import {
  OperationAbortError,
  draftInputHash,
  draftRequestHash,
  draftResponseHash,
  isModelIdentitySufficient,
  normalizePromptData,
  validateDraftOutput,
  validateDeferredDraft,
  type DeferredDraft,
  type OperationHandler,
  type OperationHandlerRegistry,
} from "@motro/domain";
import {
  DraftManualActionError,
  DraftPermanentError,
  DraftRetryableError,
  readTarget,
  resolveSourceFactId,
} from "./deepseek-fake-handler.js";

export const DEEPSEEK_REAL_TASK_IDENTIFIER = "motro-deepseek-real";
/** Real prompt 模板版本：参与 draft identity，与 fake 的 zh-draft-v1 区分（同源独立意图）。 */
export const REAL_PROMPT_TEMPLATE_VERSION = "zh-draft-real-v1";
/** 模型别名：从 config.deepseek.model 读取（不硬编码）。 */
export const REAL_MAX_TOKENS = 400;
export const REAL_TEMPERATURE = 0;

// ---- 内部类型（DeepSeek Chat Completions 响应）----

interface DeepSeekChatResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  model?: string;
  system_fingerprint?: string | null;
  error?: { message?: string; type?: string };
}

/**
 * 构造真实 DeepSeek adapter。需要 db pool 读取目标 commit row，config 提供端点/密钥。
 * 默认零网络（config.deepseek.enabled=false → 抛 DRAFT_NETWORK_ERROR）。
 */
export function buildDeepSeekRealAdapter(pool: Pool, config: AppConfig): OperationHandlerRegistry {
  const registry = new Map<string, OperationHandler>();
  const { deepseek: dsCfg } = config;
  const modelAlias = dsCfg.model;

  const handler: OperationHandler = {
    taskIdentifier: DEEPSEEK_REAL_TASK_IDENTIFIER,
    async run(operationId, signal) {
      // ---- 1. fail-closed：未启用 / 缺 Key → 拒绝 ----
      if (!dsCfg.enabled) {
        throw new DraftRetryableError(
          "DeepSeek 真实网络未启用（enabled=false）",
          "DRAFT_NETWORK_ERROR",
        );
      }
      if (!dsCfg.apiKey || dsCfg.apiKey.length === 0) {
        throw new DraftManualActionError("认证失败，请检查配置", "DRAFT_AUTH_FAILED");
      }
      if (signal?.aborted) throw new OperationAbortError();

      // ---- 2. 读 operation 与目标 ----
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

      // ---- 3. 构造请求 ----
      // 受控 prompt 数据：只允许 English spelling / POS / definition excerpt（normalizePromptData）。
      const normalized = normalizePromptData({
        englishSpelling: target.normalizedSpelling,
        partOfSpeech: "noun",
        englishDefinitionExcerpt: target.normalizedSpelling,
      });
      const userContent = [
        `spelling: ${normalized.englishSpelling ?? ""}`,
        `partOfSpeech: ${normalized.partOfSpeech ?? ""}`,
        `definition: ${normalized.englishDefinitionExcerpt ?? ""}`,
      ].join("\n");

      const endpoint = new URL(`${dsCfg.apiBaseUrl.replace(/\/$/, "")}/chat/completions`);

      const controller = new AbortController();
      const timeout = AbortSignal.timeout(dsCfg.timeoutMs);
      const onAbort = (): void => controller.abort();
      timeout.addEventListener("abort", onAbort, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        controller.abort();
        timeout.removeEventListener("abort", onAbort);
        signal?.removeEventListener("abort", onAbort);
      };

      let response: Response;
      try {
        response = await fetch(endpoint.toString(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${dsCfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: dsCfg.model,
            messages: [
              {
                role: "system",
                content:
                  "You are a lexicographic assistant. Respond ONLY with a JSON object with exactly these fields: simplifiedChineseMeaning (1-120 simplified Chinese chars, no HTML/URL/control chars), learningHint (optional, <=80 chars). No markdown, no prose.",
              },
              { role: "user", content: userContent },
            ],
            temperature: REAL_TEMPERATURE,
            max_tokens: REAL_MAX_TOKENS,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch {
        cleanup();
        if (signal?.aborted) throw new OperationAbortError();
        throw new DraftRetryableError("网络连接失败", "DRAFT_NETWORK_ERROR");
      }

      // ---- 4. HTTP 状态码 ----
      if (response.status === 401 || response.status === 403) {
        throw new DraftManualActionError("认证失败，请检查配置", "DRAFT_AUTH_FAILED");
      }
      if (response.status === 402 || response.status === 429) {
        throw new DraftRetryableError("服务繁忙，稍后重试", "DRAFT_RATE_LIMIT");
      }
      if (response.status >= 500) {
        throw new DraftRetryableError("服务暂时不可用", "DRAFT_SERVER_ERROR");
      }
      if (response.status >= 400) {
        throw new DraftPermanentError("DeepSeek API 客户端错误", "DRAFT_SCHEMA_INVALID");
      }

      // ---- 5. Content-Type 校验 ----
      const ct = response.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new DraftRetryableError("解析失败", "DRAFT_INVALID_JSON");
      }

      // ---- 6. 响应体大小限制 ----
      let body: string;
      try {
        body = await response.text();
      } catch {
        cleanup();
        throw new DraftRetryableError("网络连接失败", "DRAFT_NETWORK_ERROR");
      }
      cleanup(); // 响应体已完整读取；清理 abort controller / listener。
      if (body.length > dsCfg.maxResponseBytes) {
        throw new DraftRetryableError("返回内容过大", "DRAFT_OVER_LENGTH");
      }

      let parsed: DeepSeekChatResponse;
      try {
        parsed = JSON.parse(body) as DeepSeekChatResponse;
      } catch {
        throw new DraftRetryableError("解析失败", "DRAFT_INVALID_JSON");
      }

      if (parsed.error) {
        // DeepSeek 返回显式 error 对象：分类为 auth/rate_limit/其他
        const errType = parsed.error.type?.toLowerCase() ?? "";
        if (errType.includes("auth") || errType.includes("authentication")) {
          throw new DraftManualActionError("认证失败，请检查配置", "DRAFT_AUTH_FAILED");
        }
        if (response.status === 429 || errType.includes("rate")) {
          throw new DraftRetryableError("服务繁忙，稍后重试", "DRAFT_RATE_LIMIT");
        }
        throw new DraftRetryableError("模型返回错误", "DRAFT_SERVER_ERROR");
      }

      // ---- 7. 提取模型输出 ----
      const content = parsed.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        throw new DraftRetryableError("模型返回空内容", "DRAFT_EMPTY_OUTPUT");
      }

      // ---- 8. 服务端 JSON + schema 校验 ----
      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(content);
      } catch {
        throw new DraftRetryableError("解析失败", "DRAFT_INVALID_JSON");
      }
      const validation = validateDraftOutput(parsedContent);
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

      // ---- 9. 模型身份治理（MD-15）----
      const providerModel = parsed.model ?? null;
      const fingerprint = parsed.system_fingerprint ?? null;
      if (
        !isModelIdentitySufficient({
          resolvedProviderModel: providerModel,
          providerFingerprint: fingerprint,
        })
      ) {
        throw new DraftManualActionError(
          "模型身份不足，需人工确认",
          "DRAFT_MODEL_IDENTITY_INSUFFICIENT",
        );
      }

      // ---- 10. 构建 DeferredDraft ----
      const draftInput = {
        importBatchCommitRowId: row.target_id,
        lexicalEntryId: target.lexicalEntryId,
        wiktionarySourceFactId: sourceFactId,
        englishSpelling: normalized.englishSpelling ?? target.normalizedSpelling,
        partOfSpeech: normalized.partOfSpeech ?? "noun",
        englishDefinitionExcerpt: normalized.englishDefinitionExcerpt ?? validation.meaning,
        configuredModelAlias: modelAlias,
        promptTemplateVersion: REAL_PROMPT_TEMPLATE_VERSION,
        operationInputVersion: inputVersion,
      };
      const inputHash = draftInputHash(draftInput);
      const requestHash = draftRequestHash({
        configuredModelAlias: modelAlias,
        promptTemplateVersion: REAL_PROMPT_TEMPLATE_VERSION,
        inputHash,
        maxTokens: REAL_MAX_TOKENS,
        temperature: REAL_TEMPERATURE,
      });
      const responseHash = draftResponseHash(
        JSON.stringify({
          simplifiedChineseMeaning: validation.meaning,
          learningHint: validation.learningHint,
        }),
      );

      const draft: DeferredDraft = {
        draftKey: {
          importBatchCommitRowId: row.target_id,
          provider: "deepseek",
          configuredModelAlias: modelAlias,
          promptTemplateVersion: REAL_PROMPT_TEMPLATE_VERSION,
        },
        importBatchCommitRowId: row.target_id,
        lexicalEntryId: target.lexicalEntryId,
        wiktionarySourceFactId: sourceFactId,
        operationId,
        provider: "deepseek",
        configuredModelAlias: modelAlias,
        resolvedProviderModel: providerModel,
        providerFingerprint: fingerprint,
        promptTemplateVersion: REAL_PROMPT_TEMPLATE_VERSION,
        inputHash,
        requestHash,
        responseHash,
        draftSchemaVersion: 1,
        status: "draft_ready",
        simplifiedChineseMeaning: validation.meaning,
        learningHint: validation.learningHint,
        validationMetadata: {},
        errorCode: null,
        safeErrorSummary: null,
      };

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
