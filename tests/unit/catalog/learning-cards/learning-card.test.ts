// 学习卡与学习展示领域纯函数单测（阶段 5 工单 01）：
// 方向校验、初始卡状态、双向卡规则、卡身份键、展示状态映射、展示记录形状。
import { describe, expect, it } from "vitest";
import {
  CARD_DIRECTIONS,
  INITIAL_SCHEDULER_PARAMETERS_VERSION,
  SCHEDULER_VERSION,
  buildDirectionalCardsForItem,
  buildExposureRecord,
  buildExposureState,
  buildInitialCardState,
  cardIdentityKey,
  sameCardIdentity,
  validateCardDirection,
} from "@motro/domain";

describe("validateCardDirection", () => {
  it("en_to_zh 与 zh_to_en 是两个合法方向", () => {
    expect(validateCardDirection("en_to_zh")).toEqual([]);
    expect(validateCardDirection("zh_to_en")).toEqual([]);
    expect(CARD_DIRECTIONS).toEqual(["en_to_zh", "zh_to_en"]);
  });

  it("其他值返回错误信息", () => {
    expect(validateCardDirection("zh_to_en ")).not.toEqual([]);
    expect(validateCardDirection("to_memory")).not.toEqual([]);
    expect(validateCardDirection("")).not.toEqual([]);
  });
});

describe("buildInitialCardState", () => {
  it("新卡：state=new、FSRS 初始字段、立即到期、fsrs-v6", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    const card = buildInitialCardState({
      userId: "u1",
      courseId: "c1",
      courseItemId: "item-1",
      direction: "en_to_zh",
      now,
    });
    expect(card).toEqual({
      userId: "u1",
      courseId: "c1",
      courseItemId: "item-1",
      direction: "en_to_zh",
      state: "new",
      stability: 0,
      difficulty: 0,
      scheduledDays: 0,
      elapsedDays: 0,
      reps: 0,
      lapses: 0,
      lastReviewAt: null,
      dueAt: now.toISOString(),
      schedulerVersion: SCHEDULER_VERSION,
      schedulerParametersVersion: INITIAL_SCHEDULER_PARAMETERS_VERSION,
      stateVersion: 0,
    });
  });

  it("未注入时钟时使用当前时间", () => {
    const before = Date.now();
    const card = buildInitialCardState({
      userId: "u1",
      courseId: "c1",
      courseItemId: "item-1",
      direction: "zh_to_en",
    });
    const due = new Date(card.dueAt).getTime();
    expect(due).toBeGreaterThanOrEqual(before);
    expect(due).toBeLessThanOrEqual(Date.now());
  });
});

describe("buildDirectionalCardsForItem（同一课程词项两个方向独立卡）", () => {
  it("返回 en_to_zh 与 zh_to_en 两张初始卡，其余身份字段一致", () => {
    const cards = buildDirectionalCardsForItem({
      userId: "u1",
      courseId: "c1",
      courseItemId: "item-1",
    });
    expect(cards.map((c) => c.direction).sort()).toEqual(["en_to_zh", "zh_to_en"]);
    expect(cards.every((c) => c.userId === "u1")).toBe(true);
    expect(cards.every((c) => c.courseItemId === "item-1")).toBe(true);
    expect(cards.every((c) => c.state === "new")).toBe(true);
  });
});

describe("cardIdentityKey / sameCardIdentity（身份规则）", () => {
  it("用户 + 课程词项 + 方向组成唯一身份键", () => {
    expect(cardIdentityKey("u1", "i1", "en_to_zh")).toBe("u1:i1:en_to_zh");
    expect(cardIdentityKey("u1", "i1", "zh_to_en")).toBe("u1:i1:zh_to_en");
    expect(cardIdentityKey("u1", "i2", "en_to_zh")).toBe("u1:i2:en_to_zh");
    expect(cardIdentityKey("u2", "i1", "en_to_zh")).toBe("u2:i1:en_to_zh");
  });

  it("同身份判定：跨用户/跨词项/跨方向都不共享", () => {
    const base = { userId: "u1", courseItemId: "i1", direction: "en_to_zh" };
    expect(sameCardIdentity(base, { ...base })).toBe(true);
    expect(sameCardIdentity(base, { ...base, userId: "u2" })).toBe(false);
    expect(sameCardIdentity(base, { ...base, courseItemId: "i2" })).toBe(false);
    expect(sameCardIdentity(base, { ...base, direction: "zh_to_en" })).toBe(false);
  });
});

describe("buildExposureState（展示状态映射）", () => {
  it("无展示行 → 未展示", () => {
    expect(buildExposureState(null)).toEqual({ exposed: false, firstExposedAt: null });
  });

  it("有展示行 → 已展示并返回首次展示时间", () => {
    const state = buildExposureState({ first_exposed_at: new Date("2026-08-07T01:02:03.000Z") });
    expect(state.exposed).toBe(true);
    expect(state.firstExposedAt).toBe("2026-08-07T01:02:03.000Z");
  });
});

describe("buildExposureRecord（首次展示事实形状）", () => {
  it("返回 source release 引用与首次展示时间", () => {
    const now = new Date("2026-08-07T02:00:00.000Z");
    const record = buildExposureRecord({
      userId: "u1",
      courseItemId: "i1",
      lexicalEntryId: "e1",
      courseId: "c1",
      releaseId: "r2",
      releasedItemId: "ri9",
      requestId: "req_1",
      now,
    });
    expect(record).toEqual({
      userId: "u1",
      courseItemId: "i1",
      lexicalEntryId: "e1",
      courseId: "c1",
      releaseId: "r2",
      releasedItemId: "ri9",
      firstExposedAt: now.toISOString(),
      requestId: "req_1",
    });
  });

  it("requestId 缺省为 null", () => {
    const record = buildExposureRecord({
      userId: "u1",
      courseItemId: "i1",
      lexicalEntryId: "e1",
      courseId: "c1",
      releaseId: "r1",
      releasedItemId: "ri1",
    });
    expect(record.requestId).toBeNull();
  });
});
