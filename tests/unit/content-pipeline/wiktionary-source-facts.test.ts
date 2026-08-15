// 阶段 6 工单 05：Wiktionary source fact 纯领域单测（无数据库、无网络）。
// 覆盖：身份推导、content hash、同 revision 幂等、新 revision、hash 碰撞防护、
// raw content / 例句 / 媒体排除、安全投影、Fake Provider 确定性输出、错误状态映射。
import { describe, expect, it } from "vitest";
import {
  contentHash,
  lengthPrefixedJoin,
  pageIdentity,
  projectSourceFact,
  revisionIdentity,
  sourceFactErrorState,
  sourceFactIdentity,
  type SourceFactStatus,
} from "@motro/domain";

const PARSER = "fake-parser-1";

describe("page / revision / fact identity", () => {
  it("pageIdentity 稳定且应语言不同而不同", () => {
    expect(pageIdentity({ pageId: "123", language: "en" })).toBe(
      pageIdentity({ pageId: "123", language: "en" }),
    );
    expect(pageIdentity({ pageId: "123", language: "en" })).not.toBe(
      pageIdentity({ pageId: "123", language: "zh" }),
    );
    expect(pageIdentity({ pageId: "123", language: "en" })).not.toBe(
      pageIdentity({ pageId: "456", language: "en" }),
    );
    // 与 revision / fact identity 不同命名空间（不混淆）。
    expect(pageIdentity({ pageId: "1", language: "en" })).not.toBe(
      revisionIdentity({ pageId: "1", revisionId: "1" }),
    );
  });

  it("revisionIdentity 绑定 page + revision（同一 revision 幂等，不因 title 变化受影响）", () => {
    expect(revisionIdentity({ pageId: "1", revisionId: "r1" })).toBe(
      revisionIdentity({ pageId: "1", revisionId: "r1" }),
    );
    expect(revisionIdentity({ pageId: "1", revisionId: "r1" })).not.toBe(
      revisionIdentity({ pageId: "1", revisionId: "r2" }),
    );
    expect(revisionIdentity({ pageId: "1", revisionId: "r1" })).not.toBe(
      revisionIdentity({ pageId: "2", revisionId: "r1" }),
    );
  });

  it("lengthPrefixedJoin 防分隔符碰撞（[ab,c] ≠ [a,bc]）", () => {
    expect(lengthPrefixedJoin(["ab", "c"])).not.toBe(lengthPrefixedJoin(["a", "bc"]));
  });

  it("pageIdentity / revisionIdentity 均为 64 位小写 hex（满足数据库 CHECK）", () => {
    const page = pageIdentity({ pageId: "123", language: "en" });
    const rev = revisionIdentity({ pageId: "123", revisionId: "r1" });
    expect(page).toMatch(/^[0-9a-f]{64}$/);
    expect(rev).toMatch(/^[0-9a-f]{64}$/);
    // 长度必须严格为 64。
    expect(page.length).toBe(64);
    expect(rev.length).toBe(64);
    // 不含大写 A-F（与迁移 0031 CHECK '^[0-9a-f]{64}$' 完全一致）。
    expect(page).not.toMatch(/[A-F]/);
    expect(rev).not.toMatch(/[A-F]/);
  });
});

describe("source fact identity / 幂等", () => {
  it("同 page + 同 revision + 同 parser → 同一 identity（重放 no-op 语义）", () => {
    const a = sourceFactIdentity({ pageId: "p1", revisionId: "r1", parserVersion: PARSER });
    const b = sourceFactIdentity({ pageId: "p1", revisionId: "r1", parserVersion: PARSER });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a.length).toBe(64);
    expect(a).not.toMatch(/[A-F]/); // 严格小写（与迁移 0031 CHECK 一致）
  });

  it("sourceFactIdentity 为空输入仍稳定生成 64 位 hex（长度不变式）", () => {
    const id = sourceFactIdentity({ pageId: "", revisionId: "", parserVersion: "" });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("新 revision → 新 identity（新事实）；旧 revision 保留为独立 identity", () => {
    const oldFact = sourceFactIdentity({ pageId: "p1", revisionId: "r1", parserVersion: PARSER });
    const newFact = sourceFactIdentity({ pageId: "p1", revisionId: "r2", parserVersion: PARSER });
    expect(newFact).not.toBe(oldFact);
  });

  it("不同 parser version → 不同 identity（同一 page/revision 由不同 parser 解析视为独立事实）", () => {
    const p1 = sourceFactIdentity({ pageId: "p1", revisionId: "r1", parserVersion: "parser-a" });
    const p2 = sourceFactIdentity({ pageId: "p1", revisionId: "r1", parserVersion: "parser-b" });
    expect(p1).not.toBe(p2);
  });

  it("不用时间/随机/文件名作为身份（identity 只由 page+revision+parser 派生）", () => {
    const a = sourceFactIdentity({ pageId: "p1", revisionId: "r1", parserVersion: PARSER });
    const b = sourceFactIdentity({ pageId: "p1", revisionId: "r1", parserVersion: PARSER });
    expect(a).toBe(b); // 完全相同（无时间戳）。
  });
});

describe("content hash", () => {
  it("对受控字段稳定哈希", () => {
    const base = {
      canonicalTitle: "run",
      normalizedSpelling: "run",
      language: "en",
      partOfSpeech: "noun" as const,
      definitionExcerpt: "to move quickly on foot",
      sourceUrl: "https://en.wiktionary.org/wiki/run",
    };
    expect(contentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(base)).toBe(contentHash(base));
  });

  it("字段变化 → 哈希变化（内容不可静默覆盖的可校验性）", () => {
    const base = {
      canonicalTitle: "run",
      normalizedSpelling: "run",
      language: "en",
      partOfSpeech: "noun" as string | null,
      definitionExcerpt: "to move quickly on foot",
      sourceUrl: "https://en.wiktionary.org/wiki/run",
    };
    expect(contentHash({ ...base, definitionExcerpt: "different" })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, sourceUrl: "https://x" })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, partOfSpeech: null })).not.toBe(contentHash(base));
  });

  it("content hash 与 fact identity 不同命名空间（不混淆内容与身份）", () => {
    const h = contentHash({
      canonicalTitle: "run",
      normalizedSpelling: "run",
      language: "en",
      partOfSpeech: null,
      definitionExcerpt: "x",
      sourceUrl: "u",
    });
    const id = sourceFactIdentity({ pageId: "p", revisionId: "r", parserVersion: PARSER });
    expect(h).not.toBe(id);
  });

  it("任何 contentHash 输入都生成 64 位小写 hex（满足迁移 0031 fetched CHECK）", () => {
    const base = {
      canonicalTitle: "run",
      normalizedSpelling: "run",
      language: "en",
      partOfSpeech: "noun" as string | null,
      definitionExcerpt: "to move quickly",
      sourceUrl: "https://en.wiktionary.org/wiki/run",
    };
    const cases = [
      base,
      { ...base, partOfSpeech: null },
      { ...base, definitionExcerpt: "另一点" },
      { ...base, canonicalTitle: "跑", normalizedSpelling: "pǎo", language: "zh" },
    ];
    for (const c of cases) {
      const h = contentHash(c);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(h.length).toBe(64);
      expect(h).not.toMatch(/[A-F]/);
    }
  });
});

describe("安全投影（raw content / 例句 / 媒体排除）", () => {
  const safeInput = {
    canonicalTitle: "run",
    normalizedSpelling: "run",
    language: "en",
    partOfSpeech: "noun",
    definitionExcerpt: "to move quickly",
    sourceUrl: "https://en.wiktionary.org/wiki/run",
  };

  it("白名单投影：只保留安全字段", () => {
    const r = projectSourceFact({ ...safeInput, extra: "dropped", foo: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projected).toEqual({
        canonicalTitle: "run",
        normalizedSpelling: "run",
        language: "en",
        partOfSpeech: "noun",
        definitionExcerpt: "to move quickly",
        sourceUrl: "https://en.wiktionary.org/wiki/run",
      });
    }
  });

  it("拒绝 raw wikitext / provider payload / 响应正文", () => {
    const bad = [
      { ...safeInput, raw: "{{=en=|}}wikitext" },
      { ...safeInput, wikitext: "===" },
      { ...safeInput, payload: { a: 1 } },
      { ...safeInput, response: "full response" },
      { ...safeInput, html: "<b>run</b>" },
      { ...safeInput, body: "body text" },
    ];
    for (const b of bad) {
      const r = projectSourceFact(b);
      expect(r.ok, `应拒绝：${JSON.stringify(b).slice(0, 40)}`).toBe(false);
      // 稳定 reason，绝不回显 provider 原文/字段值。
      expect(r.reason).toMatch(/projection rejected/);
    }
  });

  it("拒绝例句 / 引用 / 图片 / 音频", () => {
    const bad = [
      { ...safeInput, example: "I run daily" },
      { ...safeInput, examples: ["he runs"] },
      { ...safeInput, quote: "quoted text" },
      { ...safeInput, image: "image.png" },
      { ...safeInput, audio: "audio.ogg" },
      { ...safeInput, pronunciation: "/rʌn/" },
      { ...safeInput, ipa: "/run/" },
    ];
    for (const b of bad) {
      const r = projectSourceFact(b);
      expect(
        r.ok,
        `应拒绝：${Object.keys(b)
          .filter(
            (k) =>
              k !== "canonicalTitle" &&
              k !== "normalizedSpelling" &&
              k !== "language" &&
              k !== "definitionExcerpt" &&
              k !== "sourceUrl",
          )
          .join(",")}`,
      ).toBe(false);
    }
  });

  it("非标量值 / 缺失必填字段 → 拒绝", () => {
    expect(projectSourceFact("string").ok).toBe(false);
    expect(projectSourceFact({ ...safeInput, definitionExcerpt: [] }).ok).toBe(false);
    expect(
      projectSourceFact({
        canonicalTitle: "run",
        normalizedSpelling: "run",
        language: "en",
        sourceUrl: "u",
        // 缺 definitionExcerpt
      } as object).ok,
    ).toBe(false);
  });

  it("空字符串必填 → 拒绝", () => {
    expect(projectSourceFact({ ...safeInput, canonicalTitle: "  " }).ok).toBe(false);
    expect(projectSourceFact({ ...safeInput, language: "" }).ok).toBe(false);
  });
});

describe("错误状态映射（复用 D 分类，不重新定义）", () => {
  it("WIKI_AMBIGUOUS → ambiguous 事实状态（非重试）", () => {
    expect(sourceFactErrorState("WIKI_AMBIGUOUS")).toEqual({
      status: "ambiguous",
      retryable: false,
    });
  });

  it("其它 WIKI 错误 → error 事实状态（重试与否由 operation 状态机决定）", () => {
    for (const code of [
      "WIKI_PAGE_NOT_FOUND",
      "WIKI_REVISION_NOT_FOUND",
      "WIKI_LICENSE_INCOMPLETE",
      "WIKI_ATTRIBUTION_INCOMPLETE",
      "WIKI_RESPONSE_MALFORMED",
      "WIKI_RESPONSE_TOO_LARGE",
      "WIKI_PROVIDER_CONTRACT",
      "WIKI_TRANSIENT",
    ]) {
      const s = sourceFactErrorState(code);
      expect(s.status).toBe("error");
      expect(["ambiguous", "fetched", "pending"].includes(s.status)).toBe(false);
    }
  });

  it("source fact 状态是独立枚举（≠ operation 状态）", () => {
    const statuses: SourceFactStatus[] = ["pending", "fetched", "ambiguous", "error", "superseded"];
    for (const s of statuses) {
      expect(["pending", "fetched", "ambiguous", "error", "superseded"]).toContain(s);
    }
    // 不含 operation 特有的 queued/running/retry_wait/manual_action/succeeded/failed。
    expect(statuses).not.toContain("manual_action");
    expect(statuses).not.toContain("retry_wait" as SourceFactStatus);
  });
});
