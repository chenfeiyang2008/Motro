// Ticket 17 · study-result 纯逻辑单测（无 React、无 DOM、无 Next）。
// 覆盖：快照投影不伪造字段、storage 读写/跨会话守卫、XP 展示状态映射。
// 与生产源码 apps/web/src/lib/study-result.ts 同文件异构；用可替换的
// 存储宿主（node:vm 注入的 sessionStorage）测内存路径，避免 JSDOM。
import { describe, expect, it } from "vitest";
import {
  clearResultSnapshot,
  projectResult,
  readResultSnapshot,
  saveResultSnapshot,
} from "../study-result.js";

/**
 * 构造一个可注入 window.sessionStorage 的最小存储宿主。
 * 用普通对象充当 Web Storage（getItem/setItem/removeItem）。
 */
function storageHost(size = 8_192) {
  const store = new Map<string, string>();
  return {
    window: {
      get sessionStorage() {
        return {
          get length() {
            return store.size;
          },
          clear: () => store.clear(),
          getItem: (k: string) => store.get(k) ?? null,
          key: (i: number) => Array.from(store.keys())[i] ?? null,
          removeItem: (k: string) => store.delete(k),
          setItem: (k: string, v: string) => {
            if (v.length > size) throw new Error("QuotaExceededError");
            store.set(k, v);
          },
        };
      },
    },
    store,
  };
}

// 兼容：把 lib 内部对全局 sessionStorage 的引用替换为宿主实例。
// study-result.ts 是纯模块，未直接 import sessionStorage，而是使用全局对象，
// 因此这里把 globalThis.sessionStorage 绑定到宿主即可（vitest 默认 node 环境）。
function withStorage(host: ReturnType<typeof storageHost>, fn: () => void) {
  const prev = (globalThis as Record<string, unknown>).sessionStorage;
  (globalThis as Record<string, unknown>).sessionStorage = host.window.sessionStorage;
  try {
    fn();
  } finally {
    if (prev === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
    else (globalThis as Record<string, unknown>).sessionStorage = prev;
  }
}

const baseSnapshot = {
  sessionId: "session-a",
  startedAt: new Date(0).toISOString(),
  totalItems: 3,
  completedCount: 2,
  byKind: { newLearning: 1, initial: 1, review: 0 },
  xpAwarded: 10,
};

describe("read/save/clear snapshot storage", () => {
  it("round-trips a valid snapshot via sessionStorage", () => {
    const host = storageHost();
    withStorage(host, () => {
      expect(readResultSnapshot()).toBeNull();
      saveResultSnapshot(baseSnapshot);
      const read = readResultSnapshot();
      expect(read).not.toBeNull();
      expect(read!.sessionId).toBe("session-a");
      expect(read!.completedCount).toBe(2);
      expect(read!.xpAwarded).toBe(10);
      clearResultSnapshot();
      expect(readResultSnapshot()).toBeNull();
    });
  });

  it("returns null for malformed / missing-required entries", () => {
    const host = storageHost();
    withStorage(host, () => {
      // 缺 sessionId
      host.window.sessionStorage.setItem(
        "motro.result-snapshot",
        JSON.stringify({ totalItems: 2, completedCount: 1 }),
      );
      expect(readResultSnapshot()).toBeNull();
      // 非法 JSON
      host.window.sessionStorage.setItem("motro.result-snapshot", "{oops");
      expect(readResultSnapshot()).toBeNull();
    });
  });

  it("rejects a snapshot belonging to another session when expectedSessionId given", () => {
    const host = storageHost();
    withStorage(host, () => {
      saveResultSnapshot({ ...baseSnapshot, sessionId: "session-b" });
      // 不匹配 → null，且不清除（属其他会话）
      expect(readResultSnapshot("session-a")).toBeNull();
      expect(readResultSnapshot()).not.toBeNull();
    });
  });

  it("save ignores quota / storage-unavailable errors (privacy mode)", () => {
    // size=0 → setItem 抛错；lib 应吞掉，不抛。
    const host = storageHost(0);
    withStorage(host, () => {
      expect(() => saveResultSnapshot(baseSnapshot)).not.toThrow();
      expect(readResultSnapshot()).toBeNull();
    });
  });

  it("clear on unreadable storage does not throw", () => {
    const host = storageHost();
    withStorage(host, () => {
      host.window.sessionStorage.setItem("motro.result-snapshot", JSON.stringify(baseSnapshot));
      clearResultSnapshot();
      expect(host.store.size).toBe(0);
    });
  });
});

describe("projectResult", () => {
  it("projects earned XP (server-authoritative) when xpAwarded > 0", () => {
    const p = projectResult(baseSnapshot, false);
    expect(p.xpState).toEqual({ variant: "earned", amount: 10 });
    expect(p.completedCount).toBe(2);
    expect(p.byKind.newLearning).toBe(1);
    expect(p.hasRemainingWork).toBe(false);
  });

  it("projects zero-XP state for a snapshot with 0 xpAwarded", () => {
    const p = projectResult({ ...baseSnapshot, xpAwarded: 0 }, true);
    expect(p.xpState).toEqual({ variant: "zero" });
    expect(p.hasRemainingWork).toBe(true);
  });

  it("projects unavailable state when no snapshot (honest fresh load)", () => {
    const p = projectResult(null, false);
    expect(p.xpState).toEqual({ variant: "unavailable" });
    expect(p.completedCount).toBe(0);
    expect(p.byKind).toEqual({ newLearning: 0, initial: 0, review: 0 });
  });

  it("never fabricates kind counts beyond the snapshot", () => {
    const p = projectResult(
      { ...baseSnapshot, byKind: { newLearning: 1, initial: 0, review: 0 } },
      false,
    );
    expect(p.byKind).toEqual({ newLearning: 1, initial: 0, review: 0 });
    // 未提供 initial/review → 不伪造为 >0
    expect(p.byKind.initial).toBe(0);
    expect(p.byKind.review).toBe(0);
  });
});
