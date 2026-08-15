// 阶段 6 工单 06：Deferred draft 领域类型。
//
// handler 不能自行通过 autocommit 写入 enrichment_drafts；它返回经 domain 校验的
// draft 草稿（DeferredDraft）与 resolved model identity，由 executeOperation 在最终
// 事务中与 operation completion 一起写入（与 Ticket 05 的 deferred source fact
// 同一原子模型）。
//
// 本模块不 import Nest、pg、Graphile 或网络库。
import type { DraftStatus } from "./rules.js";

export interface DeferredDraft {
  /** 稳定 draft 业务身份：input 一致性（同 commit row + provider + model alias + version + input_hash）。 */
  draftKey: {
    importBatchCommitRowId: string;
    provider: string;
    configuredModelAlias: string;
    promptTemplateVersion: string;
  };
  importBatchCommitRowId: string;
  lexicalEntryId: string;
  /** Ticket 05 accepted source fact identity（64 hex）。 */
  wiktionarySourceFactId: string;
  operationId: string;
  provider: string;
  configuredModelAlias: string;
  /** provider 响应明确返回的实际模型标识；不足则为 null（MD-15）。 */
  resolvedProviderModel: string | null;
  /** 来自响应 system_fingerprint（单独字段；不是模型版本）。 */
  providerFingerprint: string | null;
  promptTemplateVersion: string;
  inputHash: string;
  requestHash: string;
  responseHash: string | null;
  draftSchemaVersion: number;
  status: DraftStatus;
  simplifiedChineseMeaning: string | null;
  learningHint: string | null;
  validationMetadata: unknown;
  errorCode: string | null;
  safeErrorSummary: string | null;
}

/**
 * 声明式验证一个 DeferredDraft 草稿是否符合 domain 不变量。返回 ok=true 表示可以
 * 安全在事务中写入 enrichment_drafts 表。handler 必须在构建草稿时调用。
 * 校验最小必要身份字段；业务字段校验见 validateDraftOutput。
 */
export function validateDeferredDraft(
  draft: DeferredDraft,
): { ok: true } | { ok: false; reason: string } {
  if (!draft.importBatchCommitRowId || typeof draft.importBatchCommitRowId !== "string")
    return { ok: false, reason: "importBatchCommitRowId invalid" };
  if (!draft.lexicalEntryId || typeof draft.lexicalEntryId !== "string")
    return { ok: false, reason: "lexicalEntryId invalid" };
  if (!draft.wiktionarySourceFactId?.match(/^[0-9a-f]{64}$/))
    return { ok: false, reason: "wiktionarySourceFactId not 64-hex" };
  if (!draft.operationId || typeof draft.operationId !== "string")
    return { ok: false, reason: "operationId invalid" };
  if (draft.provider !== "deepseek") return { ok: false, reason: "provider not deepseek" };
  if (!draft.configuredModelAlias || draft.configuredModelAlias.length === 0)
    return { ok: false, reason: "configuredModelAlias invalid" };
  if (!draft.promptTemplateVersion || draft.promptTemplateVersion.length === 0)
    return { ok: false, reason: "promptTemplateVersion invalid" };
  if (!draft.inputHash?.match(/^[0-9a-f]{64}$/))
    return { ok: false, reason: "inputHash not 64-hex" };
  if (!draft.requestHash?.match(/^[0-9a-f]{64}$/))
    return { ok: false, reason: "requestHash not 64-hex" };
  if (draft.responseHash !== null && !draft.responseHash?.match(/^[0-9a-f]{64}$/))
    return { ok: false, reason: "responseHash not 64-hex" };
  // draft_ready 必须携带简体中文含义；drafting/failed 不得携带成功内容。
  if (draft.status === "draft_ready") {
    if (!draft.simplifiedChineseMeaning || draft.simplifiedChineseMeaning.length === 0)
      return { ok: false, reason: "draft_ready requires simplifiedChineseMeaning" };
  }
  return { ok: true };
}
