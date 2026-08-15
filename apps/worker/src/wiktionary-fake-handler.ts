// 阶段 6 工单 05 + 原子性修复：Wiktionary Fake Provider + Worker handler seam（内网、零网络）。
//
// 本 handler 是窄提供者缝（@motro/domain 的 OperationHandler），功能：
//   - 通过 operation 的目标 commit row 读取稳定的 normalized_spelling；
//   - 用确定性、无网络的 Fake Provider 产出固定 fixture；
//   - 对成功/歧义场景：构建 DeferredSourceFact 草稿，经 domain 校验后放入
//     result.deferredFacts，由 executeOperation 在【最终事务】中与 operation completion
//     一起写入 wiktionary_source_facts（原子、附录、同 identity 重放 no-op）；
//   - 对 error/manual_action/retryable：抛出对应 WIKI 错误码（不写任何 fact），交由 D 的
//     operation-executor 分类路由（manual_action / failed / retry_wait）。
//
// 原子性边界（本文件，Ticket 05 source-fact atomicity）：
//   - handler 绝不通过 autocommit 自行写入 wiktionary_source_facts；只返回 deferredFacts 草稿；
//   - source fact 写入与 operation 完成在同一事务（executeOperation 负责），任一步失败整体回滚；
//   - 零网络；不保存 raw wikitext / provider payload / 例句 / 引用 / 图片 / 音频；
//   - 错误摘要固定/脱敏，不保存 provider 原文；
//   - 不新增 wiktionary_source_fact operation target；operation target 仍是真实
//     import_batch_commit_row。
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import {
  contentHash,
  OperationAbortError,
  pageIdentity,
  revisionIdentity,
  sourceFactIdentity,
  validateDeferredFact,
  type DeferredSourceFact,
  type OperationHandler,
  type OperationHandlerRegistry,
} from "@motro/domain";

export const WIKTIONARY_FAKE_TASK_IDENTIFIER = "motro-wiktionary-fake";
export const WIKTIONARY_FAKE_QUEUE = "local";
/** Fake parser 稳定版本号：参与 source fact identity（同 page+revision 同 parser）。 */
export const FAKE_PARSER_VERSION = "fake-parser-1";

// ---- 行为选择（按 operation.input_version 确定性触发）----

export const IV_FETCH = 1; // success（抓取成功，写入 fetched 事实）
export const IV_SAME_REVISION = 2; // 同 revision 重放（同一 identity → 唯一事实）
export const IV_NEW_REVISION = 3; // 新 revision → 新事实（旧 revision 保留）
export const IV_PAGE_MISSING = 4; // WIKI_PAGE_NOT_FOUND（manual_action）
export const IV_REVISION_MISSING = 5; // WIKI_REVISION_NOT_FOUND（manual_action）
export const IV_MALFORMED = 6; // WIKI_RESPONSE_MALFORMED（permanent）
export const IV_OVERSIZED = 7; // WIKI_RESPONSE_TOO_LARGE（permanent）
export const IV_LICENSE_INCOMPLETE = 8; // WIKI_LICENSE_INCOMPLETE（manual_action）
export const IV_ATTRIBUTION_INCOMPLETE = 9; // WIKI_ATTRIBUTION_INCOMPLETE（manual_action）
export const IV_AMBIGUOUS = 10; // WIKI_AMBIGUOUS（manual_action）
export const IV_PERMANENT = 11; // WIKI_PROVIDER_CONTRACT（permanent）
export const IV_RETRYABLE = 12; // WIKI_TRANSIENT（retryable）

// ---- Fake Provider 结果（确定性、无网络、无随机）----

export interface FakeFetchedFields {
  canonicalTitle: string;
  normalizedSpelling: string;
  language: string;
  partOfSpeech: string | null;
  definitionExcerpt: string;
  sourceUrl: string;
  licenseName: string;
  licenseVersion: string;
  licenseUrl: string;
  attribution: string;
}

export type FakeProviderOutcome =
  | {
      kind: "fetched";
      pageId: string;
      revisionId: string;
      revisionTimestamp: Date;
      fields: FakeFetchedFields;
    }
  | { kind: "page_missing" }
  | { kind: "revision_missing" }
  | { kind: "malformed" }
  | { kind: "oversized" }
  | { kind: "license_incomplete" }
  | { kind: "attribution_incomplete" }
  | { kind: "ambiguous"; pageId: string; revisionId: string; note: string }
  | { kind: "permanent" }
  | { kind: "retryable" };

/** 由 spelling 稳定派生 page id（确定性，不用随机/时间/文件名）。 */
function stablePageId(spelling: string): string {
  return `p-${sha256Hex(spelling).slice(0, 16)}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 确定性 Fake Provider：同一 (spelling, inputVersion, revisionEpoch) 永远返回同一结果。
 * revisionEpoch 让「新 revision」与「同 revision」可区分；调用方传入稳定值。
 * 绝不发 HTTP，绝不访问 DNS，绝不读 key。
 */
export function fakeProvider(
  spelling: string,
  inputVersion: number,
  revisionEpoch: number,
): FakeProviderOutcome {
  const norm = spelling.trim().toLowerCase();
  const pageId = stablePageId(norm);
  switch (inputVersion) {
    case IV_FETCH:
      return {
        kind: "fetched",
        pageId,
        revisionId: `r-${revisionEpoch}-1`,
        revisionTimestamp: new Date(1_700_000_000_000),
        fields: {
          canonicalTitle: norm,
          normalizedSpelling: norm,
          language: "en",
          partOfSpeech: "noun",
          definitionExcerpt: `a controlled definition excerpt for ${norm}`,
          sourceUrl: `urn:fake:wiktionary:page:${norm}`,
          licenseName: "CC BY-SA 4.0",
          licenseVersion: "4.0",
          licenseUrl: "urn:fake:license:cc-by-sa-4.0",
          attribution: "Wiktionary contributors",
        },
      };
    case IV_SAME_REVISION:
      // 同 revision：与 IV_FETCH 相同 pageId/revisionId → 同一 source_fact_identity。
      return {
        kind: "fetched",
        pageId,
        revisionId: `r-${revisionEpoch}-1`,
        revisionTimestamp: new Date(1_700_000_000_000),
        fields: {
          canonicalTitle: norm,
          normalizedSpelling: norm,
          language: "en",
          partOfSpeech: "noun",
          definitionExcerpt: `a controlled definition excerpt for ${norm}`,
          sourceUrl: `urn:fake:wiktionary:page:${norm}`,
          licenseName: "CC BY-SA 4.0",
          licenseVersion: "4.0",
          licenseUrl: "urn:fake:license:cc-by-sa-4.0",
          attribution: "Wiktionary contributors",
        },
      };
    case IV_NEW_REVISION:
      // 新 revision：revisionId 前进 → 新 source_fact_identity，旧事实保留。
      return {
        kind: "fetched",
        pageId,
        revisionId: `r-${revisionEpoch}-2`,
        revisionTimestamp: new Date(1_700_000_100_000),
        fields: {
          canonicalTitle: norm,
          normalizedSpelling: norm,
          language: "en",
          partOfSpeech: "noun",
          definitionExcerpt: `a controlled definition excerpt v2 for ${norm}`,
          sourceUrl: `urn:fake:wiktionary:page:${norm}`,
          licenseName: "CC BY-SA 4.0",
          licenseVersion: "4.0",
          licenseUrl: "urn:fake:license:cc-by-sa-4.0",
          attribution: "Wiktionary contributors",
        },
      };
    case IV_PAGE_MISSING:
      return { kind: "page_missing" };
    case IV_REVISION_MISSING:
      return { kind: "revision_missing" };
    case IV_MALFORMED:
      return { kind: "malformed" };
    case IV_OVERSIZED:
      return { kind: "oversized" };
    case IV_LICENSE_INCOMPLETE:
      return { kind: "license_incomplete" };
    case IV_ATTRIBUTION_INCOMPLETE:
      return { kind: "attribution_incomplete" };
    case IV_AMBIGUOUS:
      return {
        kind: "ambiguous",
        pageId,
        revisionId: `r-${revisionEpoch}-1`,
        note: "spelling matches multiple Wiktionary pages",
      };
    case IV_PERMANENT:
      return { kind: "permanent" };
    case IV_RETRYABLE:
      return { kind: "retryable" };
    default:
      return {
        kind: "fetched",
        pageId,
        revisionId: `r-${revisionEpoch}-1`,
        revisionTimestamp: new Date(1_700_000_000_000),
        fields: {
          canonicalTitle: norm,
          normalizedSpelling: norm,
          language: "en",
          partOfSpeech: null,
          definitionExcerpt: `a controlled definition excerpt for ${norm}`,
          sourceUrl: `urn:fake:wiktionary:page:${norm}`,
          licenseName: "CC BY-SA 4.0",
          licenseVersion: "4.0",
          licenseUrl: "urn:fake:license:cc-by-sa-4.0",
          attribution: "Wiktionary contributors",
        },
      };
  }
}

// ---- WIKI 错误类（复用 D 分类，不重新定义）----

export class WikiManualActionError extends Error {
  constructor(message: string, wikiCode: string) {
    super(message);
    this.name = "WikiManualActionError";
    this.errorCode = wikiCode;
  }
  readonly errorCode: string;
}

export class WikiPermanentError extends Error {
  constructor(message: string, wikiCode: string) {
    super(message);
    this.name = "WikiPermanentError";
    this.errorCode = wikiCode;
  }
  readonly errorCode: string;
}

export class WikiRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiRetryableError";
    this.errorCode = "WIKI_TRANSIENT";
  }
  readonly errorCode = "WIKI_TRANSIENT";
}

/** 读 operation 目标 commit row 的 normalized_spelling（只读稳定字段，绝不写业务事实）。 */
async function readTargetSpelling(pool: Pool, targetId: string): Promise<string> {
  const res = await pool.query<{ normalized_spelling: string }>(
    `SELECT normalized_spelling FROM import_batch_commit_rows WHERE id = $1`,
    [targetId],
  );
  const row = res.rows[0];
  if (!row)
    throw new WikiPermanentError("operation target commit row missing", "WIKI_PROVIDER_CONTRACT");
  return row.normalized_spelling;
}

/**
 * 构建一条 fetched source fact 的 deferred 草稿（纯函数，无副作用）。
 * 不调用 pool.query——事实写入由 executeOperation 在最终事务中与 completeAttempt 同事务完成。
 * contentHash 由 handler 计算后传入，供 DB CHECK 校验；validateDeferredFact 在返回前验证。
 */
function buildFetchedFact(
  identity: string,
  pageId: string,
  revisionId: string,
  revisionTimestamp: Date,
  fields: FakeFetchedFields,
  commitRowId: string | null,
  inputVersion: number,
): DeferredSourceFact {
  const pageHash = pageIdentity({ pageId, language: fields.language });
  const revHash = revisionIdentity({ pageId, revisionId });
  const cHash = contentHash({
    canonicalTitle: fields.canonicalTitle,
    normalizedSpelling: fields.normalizedSpelling,
    language: fields.language,
    partOfSpeech: fields.partOfSpeech,
    definitionExcerpt: fields.definitionExcerpt,
    sourceUrl: fields.sourceUrl,
  });
  return {
    sourceFactIdentity: identity,
    pageIdentityHash: pageHash,
    revisionIdentityHash: revHash,
    pageId,
    revisionId,
    revisionTimestamp,
    canonicalTitle: fields.canonicalTitle,
    normalizedSpelling: fields.normalizedSpelling,
    language: fields.language,
    partOfSpeech: fields.partOfSpeech,
    definitionExcerpt: fields.definitionExcerpt,
    sourceUrl: fields.sourceUrl,
    contentHash: cHash,
    licenseName: fields.licenseName,
    licenseVersion: fields.licenseVersion,
    licenseUrl: fields.licenseUrl,
    attribution: fields.attribution,
    parserVersion: FAKE_PARSER_VERSION,
    status: "fetched",
    ambiguityNote: null,
    ambiguityCandidates: null,
    commitRowId,
    inputVersionUsed: inputVersion,
  };
}

/**
 * 构建一条 ambiguous source fact 的 deferred 草稿（纯函数，无副作用）。
 * candidate 列表供 Ticket 07 人工选择；绝不自动归一。不保存 provider 原文。
 * contentHash 为 null（ambiguous 无 fetched 内容）；DB CHECK 保证 ambiguous 必须携带 candidates。
 */
function buildAmbiguousFact(
  identity: string,
  pageId: string,
  revisionId: string,
  note: string,
  parserVersion: string,
  commitRowId: string | null,
  inputVersion: number,
): DeferredSourceFact {
  const pageHash = pageIdentity({ pageId, language: "en" });
  const revHash = revisionIdentity({ pageId, revisionId });
  return {
    sourceFactIdentity: identity,
    pageIdentityHash: pageHash,
    revisionIdentityHash: revHash,
    pageId,
    revisionId,
    revisionTimestamp: null,
    canonicalTitle: `ambiguous:${pageId}`,
    normalizedSpelling: "en",
    language: "en",
    partOfSpeech: null,
    definitionExcerpt: "no single definition available",
    sourceUrl: "urn:fake:wiktionary:page",
    contentHash: null,
    licenseName: null,
    licenseVersion: null,
    licenseUrl: null,
    attribution: null,
    parserVersion,
    status: "ambiguous",
    ambiguityNote: note,
    ambiguityCandidates: [
      { sourceName: "Wiktionary", candidateIndex: 1, pageTitle: `ambiguous-candidate-${pageId}` },
      {
        sourceName: "Wiktionary",
        candidateIndex: 2,
        pageTitle: `ambiguous-candidate-${pageId}-alt`,
      },
    ],
    commitRowId,
    inputVersionUsed: inputVersion,
  };
}

/**
 * 构造 Wiktionary Fake handler。需要 db pool 以读取目标 commit row 与写入 source fact。
 * 行为由 operation.input_version 确定性选择（见 fixture 常量）。
 */
export function buildWiktionaryFakeHandler(pool: Pool): OperationHandlerRegistry {
  const registry = new Map<string, OperationHandler>();
  const handler: OperationHandler = {
    taskIdentifier: WIKTIONARY_FAKE_TASK_IDENTIFIER,
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
      if (!row) {
        throw new WikiManualActionError("operation missing", "WIKI_PAGE_NOT_FOUND");
      }
      if (row.target_type !== "import_batch_commit_row") {
        // 校验 target 仍是真实 commit row；否则视为 provider 契约问题（永久）。
        throw new WikiPermanentError("unsupported target type", "WIKI_PROVIDER_CONTRACT");
      }
      const spelling = await readTargetSpelling(pool, row.target_id);
      const inputVersion = row.input_version;
      const outcome = fakeProvider(spelling, inputVersion, 1);

      switch (outcome.kind) {
        case "fetched": {
          const identity = sourceFactIdentity({
            pageId: outcome.pageId,
            revisionId: outcome.revisionId,
            parserVersion: FAKE_PARSER_VERSION,
          });
          const fact = buildFetchedFact(
            identity,
            outcome.pageId,
            outcome.revisionId,
            outcome.revisionTimestamp,
            outcome.fields,
            row.target_id,
            inputVersion,
          );
          // domain 校验：非法草稿直接抛永久错误（不写事实，由 executor 记录 failed）。
          const v = validateDeferredFact(fact);
          if (!v.ok) {
            throw new WikiPermanentError(
              `invalid deferred fact: ${v.reason}`,
              "WIKI_PROVIDER_CONTRACT",
            );
          }
          return {
            outcome: "succeeded",
            summary: "Wiki 源事实已抓取（fetched）",
            deferredFacts: [fact],
          };
        }
        case "page_missing":
          throw new WikiManualActionError("Wiki 页面不存在，需人工确认", "WIKI_PAGE_NOT_FOUND");
        case "revision_missing":
          throw new WikiManualActionError(
            "Wiki 修订版本不存在，需人工确认",
            "WIKI_REVISION_NOT_FOUND",
          );
        case "license_incomplete":
          throw new WikiManualActionError(
            "Wiki 来源许可信息不完整，需人工补充",
            "WIKI_LICENSE_INCOMPLETE",
          );
        case "attribution_incomplete":
          throw new WikiManualActionError(
            "Wiki 来源归属信息不完整，需人工补充",
            "WIKI_ATTRIBUTION_INCOMPLETE",
          );
        case "ambiguous": {
          // D5 歧义保留 + 原子性：返回 outcome='failed' + errorCode='WIKI_AMBIGUOUS'
          // 并携带 deferred ambiguous fact，让 executeOperation 在【同一事务】中写 fact +
          // completeAttempt 路由到 manual_action。这保证「ambiguous 事实只与 ambiguous
          // operation 结果一起提交」；stale_claim 或失败则整体回滚。
          // 歧义事实 identity 用显式歧义后缀，与后续 manual resolve→重试成功的 fetched 事实
          // （plain identity）解耦，避免 ON CONFLICT 冲突。
          const ambiguousParser = `${FAKE_PARSER_VERSION}:ambiguous`;
          const ambiguousIdentity = sourceFactIdentity({
            pageId: outcome.pageId,
            revisionId: outcome.revisionId,
            parserVersion: ambiguousParser,
          });
          const fact = buildAmbiguousFact(
            ambiguousIdentity,
            outcome.pageId,
            outcome.revisionId,
            outcome.note,
            ambiguousParser,
            row.target_id,
            inputVersion,
          );
          const v = validateDeferredFact(fact);
          if (!v.ok) {
            throw new WikiPermanentError(
              `invalid ambiguous fact: ${v.reason}`,
              "WIKI_PROVIDER_CONTRACT",
            );
          }
          return {
            outcome: "failed",
            summary: "Wiki 目标存在歧义，需人工确认",
            errorCode: "WIKI_AMBIGUOUS",
            deferredFacts: [fact],
          };
        }
        case "malformed":
          throw new WikiPermanentError("Wiki 数据源响应格式异常", "WIKI_RESPONSE_MALFORMED");
        case "oversized":
          throw new WikiPermanentError("Wiki 数据源响应过大", "WIKI_RESPONSE_TOO_LARGE");
        case "permanent":
          throw new WikiPermanentError("Wiki 数据源提供者契约不符", "WIKI_PROVIDER_CONTRACT");
        case "retryable":
          throw new WikiRetryableError("Wiki 数据源临时失败，等待自动重试");
      }
    },
  };
  registry.set(handler.taskIdentifier, handler);
  return registry;
}
