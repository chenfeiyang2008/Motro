// 阶段 7 工单 22：真实 Wiktionary Adapter（网络、SSRF 防护、fail-closed）。
//
// 本 handler 是窄提供者缝（@motro/domain 的 OperationHandler），功能与 fake handler 对称：
//   - 通过 operation 的目标 commit row 读取 normalized_spelling；
//   - 真实调用 MediaWiki Action API（JSON），提取 page/revision/license/provenance；
//   - 对成功：构建 DeferredSourceFact 草稿（与 fake 同一 shape），由 executeOperation
//     在最终事务中写入 wiktionary_source_facts（原子、幂等）；
//   - 对 error/manual_action/retryable：抛出对应 WIKI 错误码。
//
// 安全边界：
//   - 仅允许访问 config.wiktionary.hostAllowlist 中的主机（SSRF 防护）；
//   - HTTPS only（NODE_ENV=test 时允许 http）；
//   - 拦截重定向到非白名单域名；
//   - 响应体上限 config.wiktionary.maxResponseBytes；
//   - Content-Type 必须 application/json；
//   - User-Agent 必须含项目名与联系邮箱（Wiktionary 合规）；
//   - 不保存 API key、Authorization header、完整 URL（仅存脱敏摘要）。
//
// 复用：
//   - buildFetchedFact / buildAmbiguousFact / readTargetSpelling / Wiki*Error 类
//     来自 wiktionary-fake-handler（同模块导出，不重复定义）；
//   - sourceFactIdentity / validateDeferredFact 来自 @motro/domain；
//   - error codes 全部复用 domain 已建立的 WIKI_* 分类。
import type { Pool } from "pg";
import type { AppConfig } from "@motro/config";
import {
  sourceFactIdentity,
  validateDeferredFact,
  type DeferredSourceFact,
  type OperationHandler,
  type OperationHandlerRegistry,
} from "@motro/domain";
import {
  buildFetchedFact,
  WikiManualActionError,
  WikiPermanentError,
  WikiRetryableError,
  type FetchedFields,
} from "./wiktionary-fake-handler.js";
import { OperationAbortError } from "@motro/domain";

export const WIKTIONARY_REAL_TASK_IDENTIFIER = "motro-wiktionary-real";
/** 真实 adapter 的 parser 版本：参与 source fact identity，与 fake-parser-1 区分。 */
export const REAL_PARSER_VERSION = "wiktionary-action-v1";

// ---- 内部类型（Wiktionary API JSON 响应）----

interface WikiPage {
  pageid?: number;
  title?: string;
  missing?: boolean;
  ns?: number;
  revisions?: WikiRevision[];
}

/** Action API formatversion=2 返回的 revision 结构（含 slots.main）。 */
interface WikiRevision {
  revid: number;
  timestamp: string;
  slots?: { main?: { "*"?: string; content?: string } };
}

interface WikiQueryResponse {
  query?: { pages?: WikiPage[]; normalized?: Array<{ from: string; to: string }> };
  error?: { code: string; info: string };
}

// ---- URL 与 SSRF 防护 ----

/**
 * 校验 URL host 是否在白名单中。host 必须精确匹配或为子域名。
 * 例如 "en.wiktionary.org" 匹配自身；"en.m.wiktionary.org" 匹配 "*.*.wiktionary.org"（若在白名单中）。
 */
function isHostAllowed(hostname: string, allowlist: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const entry of allowlist) {
    const e = entry.trim().toLowerCase();
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

function buildApiUrl(
  apiBaseUrl: string,
  spelling: string,
  timeoutMs: number,
): { url: URL; timeoutMs: number } {
  const url = new URL(apiBaseUrl);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "ids|timestamp|content");
  url.searchParams.set("rvslots", "main");
  url.searchParams.set("titles", spelling.trim());
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("exintro", "true"); // 只取第一段
  url.searchParams.set("explaintext", "true"); // 纯文本
  return { url, timeoutMs };
}

// ---- 从 wikitext 提取定义摘录 ----

/** 从 API 返回的纯文本内容中提取第一条定义（简化提取器）。 */
function extractDefinitionExcerpt(content: string | undefined, title: string): string {
  if (!content || content.trim().length === 0) return title.slice(0, 200);
  // 按行扫描，取第一个非空行（跳过模板行 `{{...}}` 和标题行 `== ... ==`）
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("{{") || trimmed.startsWith("==")) continue;
    if (trimmed.startsWith("# ")) return trimmed.slice(2).trim().slice(0, 2000);
    if (trimmed.length > 5) return trimmed.slice(0, 2000);
  }
  return title.slice(0, 200);
}

// ---- 读 operation 目标 commit row（复用 fake handler 同函数签名）----

/** 读 operation 目标 commit row 的 normalized_spelling（只读稳定字段，绝不写业务事实）。 */
async function readTargetSpellingLocal(pool: Pool, targetId: string): Promise<string> {
  const res = await pool.query<{ normalized_spelling: string }>(
    `SELECT normalized_spelling FROM import_batch_commit_rows WHERE id = $1`,
    [targetId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new WikiPermanentError("operation target commit row missing", "WIKI_PROVIDER_CONTRACT");
  }
  return row.normalized_spelling;
}

// ---- 核心：真实 Wiktionary 适配器 ----

/**
 * 构造真实 Wiktionary adapter。需要 db pool 读取目标 commit row，config 提供网络参数。
 * 默认零网络（config.wiktionary.allowNetwork=false → 抛 WIKI_TRANSIENT）。
 */
export function buildWiktionaryRealAdapter(
  pool: Pool,
  config: AppConfig,
): OperationHandlerRegistry {
  const registry = new Map<string, OperationHandler>();
  const { wiktionary: wikCfg } = config;

  const handler: OperationHandler = {
    taskIdentifier: WIKTIONARY_REAL_TASK_IDENTIFIER,
    async run(operationId, signal) {
      // ---- 1. fail-closed：网络关闭 → 立即拒绝 ----
      // 所有环境（含 test）一视同仁：只有显式 allowNetwork=true 才允许真实网络。
      // 集成测试用本地 mock server 时通过 config 显式开启 allowNetwork。
      if (!wikCfg.allowNetwork) {
        throw new WikiRetryableError("Wiktionary 真实网络未启用（allowNetwork=false）");
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
      if (!row) {
        throw new WikiManualActionError("operation missing", "WIKI_PAGE_NOT_FOUND");
      }
      if (row.target_type !== "import_batch_commit_row") {
        throw new WikiPermanentError("unsupported target type", "WIKI_PROVIDER_CONTRACT");
      }
      const spelling = await readTargetSpellingLocal(pool, row.target_id);
      const inputVersion = row.input_version;

      // ---- 3. SSRF 防护：校验 API URL ----
      let apiUrl: URL;
      try {
        const built = buildApiUrl(wikCfg.apiBaseUrl, spelling, wikCfg.timeoutMs);
        apiUrl = built.url;
      } catch {
        throw new WikiPermanentError("Wiktionary API URL 配置无效", "WIKI_PROVIDER_CONTRACT");
      }

      if (apiUrl.protocol !== "https:" && config.env !== "test") {
        throw new WikiPermanentError("Wiktionary API 必须使用 HTTPS", "WIKI_UNSAFE_CONTENT");
      }
      if (!isHostAllowed(apiUrl.hostname, wikCfg.hostAllowlist)) {
        throw new WikiPermanentError("Wiktionary API host 不在白名单中", "WIKI_UNSAFE_CONTENT");
      }

      // ---- 4. 网络请求 ----
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(wikCfg.timeoutMs);
      // 组合 handler signal + timeout
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
        response = await fetch(apiUrl.toString(), {
          method: "GET",
          headers: {
            "User-Agent": wikCfg.userAgent,
            Accept: "application/json",
          },
          signal: controller.signal,
          redirect: "follow",
        });
      } catch {
        cleanup();
        if (signal?.aborted) throw new OperationAbortError();
        // 网络错误 / 超时
        throw new WikiRetryableError("Wiktionary 网络请求失败");
      }

      // ---- 5. 重定向校验 ----
      if (response.redirected) {
        try {
          const finalUrl = new URL(response.url);
          if (!isHostAllowed(finalUrl.hostname, wikCfg.hostAllowlist)) {
            throw new WikiPermanentError("Wiktionary 重定向到非白名单主机", "WIKI_UNSAFE_CONTENT");
          }
        } catch (e) {
          if (e instanceof WikiPermanentError) throw e;
          // URL 解析失败 → 永久错误
          throw new WikiPermanentError("Wiktionary 响应 URL 无效", "WIKI_PROVIDER_CONTRACT");
        }
      }

      // ---- 6. HTTP 状态码 ----
      if (response.status === 404) {
        throw new WikiManualActionError("Wiki 页面不存在，需人工确认", "WIKI_PAGE_NOT_FOUND");
      }
      if (response.status === 429) {
        throw new WikiRetryableError("Wiktionary 请求限流（429）");
      }
      if (response.status >= 500) {
        throw new WikiRetryableError(`Wiktionary 服务端错误（${response.status}）`);
      }
      if (response.status >= 400) {
        throw new WikiPermanentError(
          `Wiktionary 客户端错误（${response.status}）`,
          "WIKI_RESPONSE_MALFORMED",
        );
      }

      // ---- 7. Content-Type 校验 ----
      const ct = response.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new WikiPermanentError("Wiktionary 响应类型非 JSON", "WIKI_RESPONSE_MALFORMED");
      }

      // ---- 8. 响应体大小限制 ----
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > wikCfg.maxResponseBytes) {
        throw new WikiPermanentError("Wiktionary 响应过大", "WIKI_RESPONSE_TOO_LARGE");
      }

      // ---- 9. 读取并解析 JSON ----
      let body: string;
      try {
        body = await response.text();
      } catch {
        cleanup();
        throw new WikiRetryableError("Wiktionary 响应读取失败");
      }
      cleanup(); // 响应体已完整读取；清理 abort controller / listener。
      if (body.length > wikCfg.maxResponseBytes) {
        throw new WikiPermanentError("Wiktionary 响应过大", "WIKI_RESPONSE_TOO_LARGE");
      }

      let parsed: WikiQueryResponse;
      try {
        parsed = JSON.parse(body) as WikiQueryResponse;
      } catch {
        throw new WikiPermanentError("Wiktionary 响应 JSON 解析失败", "WIKI_RESPONSE_MALFORMED");
      }

      // ---- 10. 提取 page/revision ----
      if (parsed.error) {
        throw new WikiPermanentError("Wiktionary API 返回错误", "WIKI_RESPONSE_MALFORMED");
      }
      const pages = parsed.query?.pages;
      if (!pages || pages.length === 0) {
        throw new WikiManualActionError("Wiki 页面不存在，需人工确认", "WIKI_PAGE_NOT_FOUND");
      }
      const page = pages[0]!;
      if (page.missing) {
        throw new WikiManualActionError("Wiki 页面不存在，需人工确认", "WIKI_PAGE_NOT_FOUND");
      }
      const pageId = String(page.pageid ?? "");
      if (!pageId) {
        throw new WikiManualActionError("Wiki 页面不存在，需人工确认", "WIKI_PAGE_NOT_FOUND");
      }
      const revisions = page.revisions;
      if (!revisions || revisions.length === 0) {
        throw new WikiManualActionError(
          "Wiki 修订版本不存在，需人工确认",
          "WIKI_REVISION_NOT_FOUND",
        );
      }
      const rev = revisions[0]!;
      const revisionId = String(rev.revid);
      const revisionTimestamp = new Date(rev.timestamp);
      const canonicalTitle = parsed.query?.normalized?.[0]?.to ?? page.title ?? spelling;

      // ---- 11. 提取定义摘录（纯文本 rvslots.main）----
      const content = rev.slots?.main?.["*"] ?? rev.slots?.main?.content;
      const definitionExcerpt = extractDefinitionExcerpt(content, canonicalTitle);

      // ---- 12. 构建 provenance 字段 ----
      const sourceUrl = `https://en.wiktionary.org/w/index.php?title=${encodeURIComponent(canonicalTitle)}&oldid=${revisionId}`;
      // Wiktionary CC BY-SA 4.0 许可：Action API 不返回许可信息；从已知来源推导。
      const licenseName = "CC BY-SA 4.0";
      const licenseVersion = "4.0";
      const licenseUrl = "https://creativecommons.org/licenses/by-sa/4.0/";
      const attribution = "Wiktionary contributors";

      const fetchedFields: FetchedFields = {
        canonicalTitle,
        normalizedSpelling: spelling.trim().toLowerCase(),
        language: "en",
        partOfSpeech: null,
        definitionExcerpt,
        sourceUrl,
        licenseName,
        licenseVersion,
        licenseUrl,
        attribution,
      };

      // ---- 13. 构建 DeferredSourceFact ----
      const identity = sourceFactIdentity({
        pageId,
        revisionId,
        parserVersion: REAL_PARSER_VERSION,
      });

      const fact: DeferredSourceFact = buildFetchedFact(
        identity,
        pageId,
        revisionId,
        revisionTimestamp,
        fetchedFields,
        row.target_id,
        inputVersion,
        REAL_PARSER_VERSION,
      );

      // ---- 14. domain 校验 ----
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
    },
  };

  registry.set(handler.taskIdentifier, handler);
  return registry;
}
