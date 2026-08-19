// 阶段 7 工单 22：真实 DeepSeek Adapter 单元测试。
// mock global.fetch，不需要真实网络/数据库。只测 adapter 的网络边界与错误分类。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AppConfig } from "@motro/config";
import {
  buildDeepSeekRealAdapter,
  DEEPSEEK_REAL_TASK_IDENTIFIER,
} from "../../../apps/worker/src/deepseek-real-adapter.js";
import {
  DraftManualActionError,
  DraftPermanentError,
  DraftRetryableError,
} from "../../../apps/worker/src/deepseek-fake-handler.js";

// ---- 测试工具 ----

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): AppConfig {
  return {
    env: "test",
    providerMode: "fake",
    wiktionary: {
      apiBaseUrl: "https://en.wiktionary.org/w/api.php",
      userAgent: "MotroBot/1.0",
      allowNetwork: false,
      timeoutMs: 1000,
      maxResponseBytes: 100_000,
      hostAllowlist: ["en.wiktionary.org"],
    },
    deepseek: {
      enabled: true,
      apiKey: "sk-test-key-12345",
      apiBaseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      timeoutMs: 1000,
      maxResponseBytes: 100_000,
    },
    ...overrides,
  } as unknown as AppConfig;
}

function makePool(sourceFactId = "a".repeat(64)): Pool {
  return {
    query: vi.fn().mockImplementation((_sql: string) => {
      // 操作目标查询
      if (_sql.includes("application_operations")) {
        return Promise.resolve({
          rows: [
            {
              target_type: "import_batch_commit_row",
              target_id: "commit-row-1",
              input_version: 1,
            },
          ],
        });
      }
      // 目标 commit row（readTarget）
      if (_sql.includes("import_batch_commit_rows")) {
        return Promise.resolve({
          rows: [
            {
              normalized_spelling: "run",
              lexical_entry_id: "00000000-0000-0000-0000-000000000001",
            },
          ],
        });
      }
      // 来源事实 identity
      if (_sql.includes("wiktionary_source_facts")) {
        return Promise.resolve({
          rows: sourceFactId ? [{ source_fact_identity: sourceFactId }] : [],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

function makeDSResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    choices: [
      {
        message: { content: '{"simplifiedChineseMeaning":"奔跑","learningHint":"优先记忆动词义"}' },
      },
    ],
    model: "deepseek-chat-0101",
    system_fingerprint: "fp-abc123",
    ...overrides,
  });
}

function mockResponse(
  body: string,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return {
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    url: "https://api.deepseek.com/chat/completions",
    redirected: false,
    headers: new Headers({ "content-type": "application/json", ...(opts.headers ?? {}) }),
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function run(config: AppConfig, pool: Pool) {
  const registry = buildDeepSeekRealAdapter(pool, config);
  const handler = registry.get(DEEPSEEK_REAL_TASK_IDENTIFIER)!;
  return handler.run("op-1");
}

// ---- 测试 ----

describe("deepseek-real-adapter（网络边界 + 错误分类）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("正常响应 → succeeded + DeferredDraft", async () => {
    fetchMock.mockResolvedValue(mockResponse(makeDSResponse()));
    const result = await run(makeConfig(), makePool());
    expect(result.outcome).toBe("succeeded");
    expect(result.deferredDrafts).toHaveLength(1);
    const draft = (result.deferredDrafts as unknown as Array<Record<string, unknown>>)[0]!;
    expect(draft.simplifiedChineseMeaning).toBe("奔跑");
    expect(draft.status).toBe("draft_ready");
    expect(draft.provider).toBe("deepseek");
    expect(draft.resolvedProviderModel).toBe("deepseek-chat-0101");
    // Authorization header 校验
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers["Authorization"]).toMatch(
      /^Bearer sk-/,
    );
  });

  it("enabled=false → 立即 DRAFT_NETWORK_ERROR，不发网络", async () => {
    const cfg = makeConfig({ deepseek: { ...makeConfig().deepseek, enabled: false } });
    fetchMock.mockResolvedValue(mockResponse(makeDSResponse()));
    try {
      await run(cfg, makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftRetryableError).errorCode).toBe("DRAFT_NETWORK_ERROR");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("无 apiKey → DRAFT_AUTH_FAILED (manual_action)", async () => {
    const cfg = makeConfig({ deepseek: { ...makeConfig().deepseek, apiKey: "" } });
    fetchMock.mockResolvedValue(mockResponse(makeDSResponse()));
    try {
      await run(cfg, makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftManualActionError).errorCode).toBe("DRAFT_AUTH_FAILED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401/403 → DRAFT_AUTH_FAILED", async () => {
    fetchMock.mockResolvedValue(
      mockResponse('{"error":{"message":"unauthorized"}}', { status: 401 }),
    );
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftManualActionError).errorCode).toBe("DRAFT_AUTH_FAILED");
    }
  });

  it("429 → DRAFT_RATE_LIMIT (retryable)", async () => {
    fetchMock.mockResolvedValue(
      mockResponse('{"error":{"message":"rate limited"}}', { status: 429 }),
    );
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftRetryableError).errorCode).toBe("DRAFT_RATE_LIMIT");
    }
  });

  it("5xx → DRAFT_SERVER_ERROR (retryable)", async () => {
    fetchMock.mockResolvedValue(mockResponse('{"error":{"message":"down"}}', { status: 500 }));
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftRetryableError).errorCode).toBe("DRAFT_SERVER_ERROR");
    }
  });

  it("空输出 → DRAFT_EMPTY_OUTPUT (retryable)", async () => {
    fetchMock.mockResolvedValue(
      mockResponse(JSON.stringify({ choices: [{ message: { content: "" } }], model: "x" })),
    );
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftRetryableError).errorCode).toBe("DRAFT_EMPTY_OUTPUT");
    }
  });

  it("非 JSON → DRAFT_INVALID_JSON (retryable)", async () => {
    fetchMock.mockResolvedValue(mockResponse("this is not json"));
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftRetryableError).errorCode).toBe("DRAFT_INVALID_JSON");
    }
  });

  it("HTML 内容 → DRAFT_UNSAFE_CONTENT (permanent)", async () => {
    fetchMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({
          choices: [
            { message: { content: '{"simplifiedChineseMeaning":"<script>alert(1)</script>"}' } },
          ],
          model: "x",
        }),
      ),
    );
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftPermanentError).errorCode).toBe("DRAFT_UNSAFE_CONTENT");
    }
  });

  it("超长释义 → DRAFT_OVER_LENGTH (permanent)", async () => {
    const longMeaning = "一".repeat(200);
    fetchMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({
          choices: [{ message: { content: `{"simplifiedChineseMeaning":"${longMeaning}"}` } }],
          model: "x",
        }),
      ),
    );
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftPermanentError).errorCode).toBe("DRAFT_OVER_LENGTH");
    }
  });

  it("Authorization header 始终存在，apiKey 不写入日志（注释安全）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(mockResponse(makeDSResponse()));
    await run(makeConfig(), makePool());
    // 日志中不应出现 apiKey 原文
    for (const call of spy.mock.calls.flat()) {
      expect(String(call)).not.toContain("sk-test-key-12345");
    }
    spy.mockRestore();
  });

  it("来源事实缺失 → DRAFT_SOURCE_MISSING (manual_action)", async () => {
    // pool 返回空 source fact
    const pool = {
      query: vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
        if (params?.[0] === "op-1") {
          return Promise.resolve({
            rows: [
              {
                target_type: "import_batch_commit_row",
                target_id: "commit-row-1",
                input_version: 1,
              },
            ],
          });
        }
        if (_sql.includes("lexical_entry_id")) {
          return Promise.resolve({
            rows: [{ normalized_spelling: "run", lexical_entry_id: "eid-1" }],
          });
        }
        return Promise.resolve({ rows: [] }); // no source fact
      }),
    } as unknown as Pool;
    fetchMock.mockResolvedValue(mockResponse(makeDSResponse()));
    try {
      await run(makeConfig(), pool);
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftManualActionError).errorCode).toBe("DRAFT_SOURCE_MISSING");
    }
  });

  it("schema 不匹配（含多余字段）→ DRAFT_EXTRA_FIELD (permanent)", async () => {
    const badJson = JSON.stringify({ simplifiedChineseMeaning: "奔跑", extraField: "bad" });
    fetchMock.mockResolvedValue(
      mockResponse(JSON.stringify({ choices: [{ message: { content: badJson } }], model: "x" })),
    );
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftPermanentError).errorCode).toBe("DRAFT_EXTRA_FIELD");
    }
  });

  it("网络超时 → DRAFT_NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    try {
      await run(makeConfig(), makePool());
      throw new Error("should throw");
    } catch (e) {
      expect((e as DraftRetryableError).errorCode).toBe("DRAFT_NETWORK_ERROR");
    }
  });
});
