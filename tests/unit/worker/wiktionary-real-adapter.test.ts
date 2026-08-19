// 阶段 7 工单 22：真实 Wiktionary Adapter 单元测试。
// mock global.fetch，不需要真实网络/数据库。只测 adapter 的网络边界与错误分类。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AppConfig } from "@motro/config";
import {
  buildWiktionaryRealAdapter,
  WIKTIONARY_REAL_TASK_IDENTIFIER,
} from "../../../apps/worker/src/wiktionary-real-adapter.js";
import {
  WikiManualActionError,
  WikiPermanentError,
  WikiRetryableError,
} from "../../../apps/worker/src/wiktionary-fake-handler.js";

// ---- 测试工具 ----

/** 构造一个最小配置。默认 allowNetwork=true（单元测试 mock fetch，不触真实网络）。 */
function makeConfig(overrides: Partial<Record<string, unknown>> = {}): AppConfig {
  return {
    env: "test",
    providerMode: "fake",
    wiktionary: {
      apiBaseUrl: "https://en.wiktionary.org/w/api.php",
      userAgent: "MotroBot/1.0 (contact: motro@example.com)",
      allowNetwork: true,
      timeoutMs: 1000,
      maxResponseBytes: 100_000,
      hostAllowlist: ["en.wiktionary.org", "127.0.0.1"],
    },
    deepseek: {
      enabled: false,
      apiKey: undefined,
      apiBaseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      timeoutMs: 1000,
      maxResponseBytes: 100_000,
    },
    ...overrides,
  } as unknown as AppConfig;
}

/** 模拟 pg pool：按 SQL 内容分发查询结果。 */
function makePool(spelling = "run"): Pool {
  return {
    query: vi.fn().mockImplementation((_sql: string) => {
      if (_sql.includes("application_operations")) {
        return Promise.resolve({
          rows: [
            { target_type: "import_batch_commit_row", target_id: "commit-row-1", input_version: 1 },
          ],
        });
      }
      if (_sql.includes("import_batch_commit_rows")) {
        return Promise.resolve({ rows: [{ normalized_spelling: spelling }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

/** 构造 MediaWiki Action API 响应 body。 */
function apiBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    query: {
      normalized: [{ from: "run", to: "run" }],
      pages: [
        {
          pageid: 12345,
          title: "run",
          revisions: [
            {
              revid: 98765,
              timestamp: "2024-01-01T00:00:00Z",
              slots: { main: { "*": "# (transitive) to move quickly" } },
            },
          ],
        },
      ],
    },
    ...overrides,
  });
}

/** 构造 Response mock。 */
function mockResponse(
  body: string,
  opts: {
    status?: number;
    headers?: Record<string, string>;
    url?: string;
    redirected?: boolean;
  } = {},
): Response {
  return {
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    url: opts.url ?? "https://en.wiktionary.org/w/api.php?action=query",
    redirected: opts.redirected ?? false,
    headers: new Headers({
      "content-type": "application/json; charset=utf-8",
      ...(opts.headers ?? {}),
    }),
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/** 注册 handler 并执行 run（op-1）。 */
async function run(config: AppConfig, pool: Pool) {
  const registry = buildWiktionaryRealAdapter(pool, config);
  const handler = registry.get(WIKTIONARY_REAL_TASK_IDENTIFIER)!;
  return handler.run("op-1");
}

// ---- 测试 ----

describe("wiktionary-real-adapter（网络边界 + 错误分类）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("正常响应 → succeeded + DeferredSourceFact", async () => {
    fetchMock.mockResolvedValue(mockResponse(apiBody()));
    const result = await run(makeConfig(), makePool("run"));
    expect(result.outcome).toBe("succeeded");
    expect(result.deferredFacts).toHaveLength(1);
    const fact = (result.deferredFacts as unknown as Array<Record<string, unknown>>)[0]!;
    expect(fact.pageId).toBe("12345");
    expect(fact.revisionId).toBe("98765");
    expect(fact.licenseName).toBe("CC BY-SA 4.0");
    expect(fact.attribution).toContain("Wiktionary");
    expect(fact.sourceUrl).toMatch(/oldid=98765/);
    expect(fact.normalizedSpelling).toBe("run");
    // User-Agent 校验
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("action=query");
    expect((init as { headers: Record<string, string> }).headers["User-Agent"]).toContain(
      "motro@example.com",
    );
  });

  it("HTTP 404 → WIKI_PAGE_NOT_FOUND (manual_action)", async () => {
    fetchMock.mockResolvedValue(mockResponse("{}", { status: 404 }));
    try {
      await run(makeConfig(), makePool("x"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiManualActionError).errorCode).toBe("WIKI_PAGE_NOT_FOUND");
    }
  });

  it("query.pages[0].missing → WIKI_PAGE_NOT_FOUND", async () => {
    fetchMock.mockResolvedValue(
      mockResponse(JSON.stringify({ query: { pages: [{ title: "x", missing: true }] } })),
    );
    try {
      await run(makeConfig(), makePool("x"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiManualActionError).errorCode).toBe("WIKI_PAGE_NOT_FOUND");
    }
  });

  it("无 revision → WIKI_REVISION_NOT_FOUND", async () => {
    fetchMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({ query: { pages: [{ pageid: 1, title: "x", revisions: [] }] } }),
      ),
    );
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiManualActionError).errorCode).toBe("WIKI_REVISION_NOT_FOUND");
    }
  });

  it("非法 Content-Type → WIKI_RESPONSE_MALFORMED", async () => {
    fetchMock.mockResolvedValue(
      mockResponse("<html>oops</html>", { headers: { "content-type": "text/html" } }),
    );
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_RESPONSE_MALFORMED");
    }
  });

  it("超大响应（content-length）→ WIKI_RESPONSE_TOO_LARGE", async () => {
    const cfg = makeConfig({ wiktionary: { ...makeConfig().wiktionary, maxResponseBytes: 100 } });
    fetchMock.mockResolvedValue(
      mockResponse(apiBody(), { headers: { "content-length": "99999" } }),
    );
    try {
      await run(cfg, makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_RESPONSE_TOO_LARGE");
    }
  });

  it("超大响应（body 长度）→ WIKI_RESPONSE_TOO_LARGE", async () => {
    const cfg = makeConfig({ wiktionary: { ...makeConfig().wiktionary, maxResponseBytes: 10 } });
    fetchMock.mockResolvedValue(mockResponse(apiBody()));
    try {
      await run(cfg, makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_RESPONSE_TOO_LARGE");
    }
  });

  it("非白名单 host → WIKI_UNSAFE_CONTENT，不发网络请求", async () => {
    const cfg = makeConfig({
      wiktionary: {
        ...makeConfig().wiktionary,
        apiBaseUrl: "https://evil.example.com/w/api.php",
        hostAllowlist: ["en.wiktionary.org"],
      },
    });
    fetchMock.mockResolvedValue(mockResponse(apiBody()));
    try {
      await run(cfg, makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_UNSAFE_CONTENT");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("重定向到外域 → WIKI_UNSAFE_CONTENT", async () => {
    fetchMock.mockResolvedValue(
      mockResponse(apiBody(), { url: "https://evil.example.com/redirected", redirected: true }),
    );
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_UNSAFE_CONTENT");
    }
  });

  it("429 → WIKI_TRANSIENT (retryable)", async () => {
    fetchMock.mockResolvedValue(mockResponse("{}", { status: 429 }));
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiRetryableError).errorCode).toBe("WIKI_TRANSIENT");
    }
  });

  it("5xx → WIKI_TRANSIENT (retryable)", async () => {
    fetchMock.mockResolvedValue(mockResponse("{}", { status: 503 }));
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiRetryableError).errorCode).toBe("WIKI_TRANSIENT");
    }
  });

  it("4xx 非 404 → WIKI_RESPONSE_MALFORMED (permanent)", async () => {
    fetchMock.mockResolvedValue(mockResponse("{}", { status: 400 }));
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_RESPONSE_MALFORMED");
    }
  });

  it("allowNetwork=false 且非 test 环境 → 立即 WIKI_TRANSIENT，不发网络", async () => {
    const cfg = makeConfig({
      env: "production",
      providerMode: "real",
      wiktionary: { ...makeConfig().wiktionary, allowNetwork: false },
    });
    fetchMock.mockResolvedValue(mockResponse(apiBody()));
    try {
      await run(cfg, makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiRetryableError).errorCode).toBe("WIKI_TRANSIENT");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("网络超时 → WIKI_TRANSIENT", async () => {
    fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiRetryableError).errorCode).toBe("WIKI_TRANSIENT");
    }
  });

  it("JSON 解析失败 → WIKI_RESPONSE_MALFORMED", async () => {
    fetchMock.mockResolvedValue(mockResponse("not-json-at-all"));
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_RESPONSE_MALFORMED");
    }
  });

  it("API 错误响应 → WIKI_RESPONSE_MALFORMED", async () => {
    fetchMock.mockResolvedValue(
      mockResponse(JSON.stringify({ error: { code: "badparams", info: "..." } })),
    );
    try {
      await run(makeConfig(), makePool("run"));
      throw new Error("should throw");
    } catch (e) {
      expect((e as WikiPermanentError).errorCode).toBe("WIKI_RESPONSE_MALFORMED");
    }
  });
});
