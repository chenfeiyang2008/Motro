// 阶段 6 工单 05 原子性修复：deferred source fact 领域类型。
//
// handler 不能自行通过 autocommit 写入 wiktionary_source_facts；它只返回经过
// domain 校验的 fact 草稿（DeferredSourceFact）。由 executeOperation 在最终
// 事务中：INSERT facts + completeAttempt，任一步骤失败则整体 rollback，
// 确保不可变 source fact 与 operation 状态永远原子一致。
//
// 本模块不 import Nest、pg、Graphile 或网络库。
export interface DeferredSourceFact {
  sourceFactIdentity: string;
  pageIdentityHash: string;
  revisionIdentityHash: string;
  pageId: string;
  revisionId: string;
  revisionTimestamp: Date | null;
  canonicalTitle: string;
  normalizedSpelling: string;
  language: string;
  partOfSpeech: string | null;
  definitionExcerpt: string;
  sourceUrl: string;
  /** fetched → 64 位小写 hex；ambiguous → null（数据库 CHECK 权威裁决）。 */
  contentHash: string | null;
  licenseName: string | null;
  licenseVersion: string | null;
  licenseUrl: string | null;
  attribution: string | null;
  parserVersion: string;
  status: "fetched" | "ambiguous";
  ambiguityNote: string | null;
  ambiguityCandidates: unknown | null;
  commitRowId: string | null;
  inputVersionUsed: number | null;
}

/**
 * 声明式验证一个 DeferredSourceFact 草稿是否符合 domain 不变量。
 * 返回 ok=true 表示可以安全在事务中写入 wiktionary_source_facts 表。
 * handler 必须在构建草稿时调用此函数，不得跳过。
 */
export function validateDeferredFact(
  fact: DeferredSourceFact,
): { ok: true } | { ok: false; reason: string } {
  if (!fact.sourceFactIdentity.match(/^[0-9a-f]{64}$/))
    return { ok: false, reason: "sourceFactIdentity not 64-hex" };
  if (!fact.pageIdentityHash.match(/^[0-9a-f]{64}$/))
    return { ok: false, reason: "pageIdentityHash not 64-hex" };
  if (!fact.revisionIdentityHash.match(/^[0-9a-f]{64}$/))
    return { ok: false, reason: "revisionIdentityHash not 64-hex" };
  if (!fact.pageId || fact.pageId.length > 256) return { ok: false, reason: "pageId invalid" };
  if (!fact.revisionId || fact.revisionId.length > 256)
    return { ok: false, reason: "revisionId invalid" };
  if (!fact.canonicalTitle || fact.canonicalTitle.length > 512)
    return { ok: false, reason: "canonicalTitle invalid" };
  if (!fact.normalizedSpelling || fact.normalizedSpelling.length > 512)
    return { ok: false, reason: "normalizedSpelling invalid" };
  if (!fact.language || fact.language.length > 16) return { ok: false, reason: "language invalid" };
  if (!fact.definitionExcerpt || fact.definitionExcerpt.length > 2000)
    return { ok: false, reason: "definitionExcerpt invalid" };
  if (!fact.sourceUrl || fact.sourceUrl.length > 2000)
    return { ok: false, reason: "sourceUrl invalid" };
  if (!fact.parserVersion || fact.parserVersion.length > 128)
    return { ok: false, reason: "parserVersion invalid" };
  if (fact.status !== "fetched" && fact.status !== "ambiguous")
    return { ok: false, reason: "invalid status" };
  // fetched → contentHash 必须经 CHECK 推导；ambiguous → ambiguity_candidates 必须有值
  if (fact.status === "fetched") {
    if (!fact.definitionExcerpt || fact.definitionExcerpt.length === 0)
      return { ok: false, reason: "fetched requires definitionExcerpt" };
  }
  if (fact.status === "ambiguous" && !fact.ambiguityCandidates)
    return { ok: false, reason: "ambiguous requires ambiguityCandidates" };
  return { ok: true };
}
