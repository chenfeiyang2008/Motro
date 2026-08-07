// FSRS v6 调度适配器单测（阶段 5 工单 02）。
// 确定性验证：固定时钟、固定参数版本下，四级评分的调度输出与预期精确一致；
// 学习→复习、复习→再学习（lapse）、到期边界、方向独立、非法评分拒绝、UTC 跨日边界、
// 参数版本可追溯与确定性重放。
import { describe, expect, it } from "vitest";
import {
  SCHEDULER_VERSION,
  defaultFsrsParameters,
  fsrsParameterVersion,
  isFourScoreRating,
  scheduleNextLearningCard,
  validateRating,
  type CardSchedulingInput,
  type NextScheduleCard,
} from "@motro/domain";

const NOW = new Date("2026-08-07T00:00:00.000Z");
const PARAMS = defaultFsrsParameters();
const PARAM_VERSION = fsrsParameterVersion(PARAMS);

/** 新卡（与数据库 learning_cards 初始行一致的镜像）。 */
function newCard(over: Partial<CardSchedulingInput> = {}) {
  return {
    state: "new",
    stability: 0,
    difficulty: 0,
    scheduledDays: 0,
    elapsedDays: 0,
    reps: 0,
    lapses: 0,
    learningSteps: 0,
    lastReviewAt: null,
    dueAt: "2026-08-07T00:00:00.000Z",
    schedulerVersion: SCHEDULER_VERSION,
    schedulerParametersVersion: PARAM_VERSION,
    stateVersion: 0,
    ...over,
  } as CardSchedulingInput;
}

/** 把一次调度输出转成下一轮输入（模拟数据库往返）。 */
function persist(out: NextScheduleCard): CardSchedulingInput {
  return {
    state: out.state,
    stability: out.stability,
    difficulty: out.difficulty,
    scheduledDays: out.scheduledDays,
    elapsedDays: out.elapsedDays,
    reps: out.reps,
    lapses: out.lapses,
    learningSteps: out.learningSteps,
    lastReviewAt: out.lastReviewAt,
    dueAt: out.dueAt,
    schedulerVersion: out.schedulerVersion,
    schedulerParametersVersion: out.schedulerParametersVersion,
    stateVersion: out.stateVersion,
  };
}

describe("validateRating（四级评分约束）", () => {
  it("只允许 Again/Hard/Good/Easy", () => {
    for (const r of ["again", "hard", "good", "easy"]) {
      expect(isFourScoreRating(r)).toBe(true);
      expect(validateRating(r)).toEqual([]);
    }
  });

  it("非法评分被拒绝（不触碰调度）", () => {
    for (const r of ["manual", "skip", "", "Again", "GOOD", "5"]) {
      expect(isFourScoreRating(r)).toBe(false);
      expect(validateRating(r)).not.toEqual([]);
    }
  });
});

describe("scheduleNextLearningCard（新卡四级评分）", () => {
  it("新卡 Again → learning，1 分钟步骤，stability=w1", () => {
    const out = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "again",
      parameters: PARAMS,
    });
    expect(out.state).toBe("learning");
    expect(out.stability).toBeCloseTo(0.212, 3);
    expect(out.difficulty).toBeCloseTo(6.4133, 4);
    expect(out.scheduledDays).toBe(0);
    expect(out.reps).toBe(1);
    expect(out.lapses).toBe(0);
    expect(out.learningSteps).toBe(0);
    expect(out.lastReviewAt).toBe("2026-08-07T00:00:00.000Z");
    expect(out.dueAt).toBe("2026-08-07T00:01:00.000Z");
    expect(out.schedulerVersion).toBe(SCHEDULER_VERSION);
    expect(out.schedulerParametersVersion).toBe(PARAM_VERSION);
    expect(out.stateVersion).toBe(1);
  });

  it("新卡 Hard → learning，6 分钟步骤", () => {
    const out = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "hard",
      parameters: PARAMS,
    });
    expect(out.state).toBe("learning");
    expect(out.stability).toBeCloseTo(1.2931, 3);
    expect(out.difficulty).toBeCloseTo(5.11217071, 3);
    expect(out.dueAt).toBe("2026-08-07T00:06:00.000Z");
  });

  it("新卡 Good → learning，10 分钟步骤，learningSteps 递增为 1", () => {
    const out = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    expect(out.state).toBe("learning");
    expect(out.stability).toBeCloseTo(2.3065, 3);
    expect(out.difficulty).toBeCloseTo(2.11810397, 3);
    expect(out.scheduledDays).toBe(0);
    expect(out.dueAt).toBe("2026-08-07T00:10:00.000Z");
    expect(out.learningSteps).toBe(1);
  });

  it("新卡 Easy → review，首卡直接进入复习，间隔 8 天", () => {
    const out = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "easy",
      parameters: PARAMS,
    });
    expect(out.state).toBe("review");
    expect(out.stability).toBeCloseTo(8.2956, 3);
    expect(out.difficulty).toBe(1);
    expect(out.scheduledDays).toBe(8);
    expect(out.dueAt).toBe("2026-08-15T00:00:00.000Z");
    expect(out.learningSteps).toBe(0);
  });
});

describe("scheduleNextLearningCard（学习→复习过渡）", () => {
  it("两次 Good：第一次进 learning 步骤，第二次完成后进入 review 且间隔 2 天", () => {
    const step1 = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    expect(step1.state).toBe("learning");
    const step2 = scheduleNextLearningCard({
      card: persist(step1),
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    expect(step2.state).toBe("review");
    expect(step2.scheduledDays).toBe(2);
    expect(step2.stability).toBeCloseTo(2.3065, 3);
    expect(step2.difficulty).toBeCloseTo(2.11121424, 3);
    expect(step2.reps).toBe(2);
    expect(step2.dueAt).toBe("2026-08-09T00:00:00.000Z");
    expect(step2.learningSteps).toBe(0);
  });
});

describe("scheduleNextLearningCard（复习与到期边界）", () => {
  const reviewCard = () => ({
    state: "review" as const,
    stability: 2.3065,
    difficulty: 2.11121424,
    scheduledDays: 2,
    elapsedDays: 0,
    reps: 2,
    lapses: 0,
    learningSteps: 0,
    lastReviewAt: "2026-08-07T00:00:00.000Z",
    dueAt: "2026-08-09T00:00:00.000Z",
    schedulerVersion: SCHEDULER_VERSION,
    schedulerParametersVersion: PARAM_VERSION,
    stateVersion: 2,
  });

  it("复习卡到期 3 天后 Good：elapsedDays=3，间隔按记忆保留增长", () => {
    const later = new Date("2026-08-10T00:00:00.000Z");
    const out = scheduleNextLearningCard({
      card: reviewCard(),
      now: later,
      rating: "good",
      parameters: PARAMS,
    });
    expect(out.state).toBe("review");
    expect(out.elapsedDays).toBe(3);
    expect(out.stability).toBeCloseTo(13.8358397, 3);
    expect(out.difficulty).toBeCloseTo(2.1043314, 3);
    expect(out.scheduledDays).toBe(14);
    expect(out.reps).toBe(3);
    expect(out.lapses).toBe(0);
    expect(out.dueAt).toBe("2026-08-24T00:00:00.000Z");
    expect(out.stateVersion).toBe(3);
  });

  it("复习卡到期 3 天后 Again：进入再学习，lapses 递增 1，reps 也递增", () => {
    const later = new Date("2026-08-10T00:00:00.000Z");
    const out = scheduleNextLearningCard({
      card: reviewCard(),
      now: later,
      rating: "again",
      parameters: PARAMS,
    });
    expect(out.state).toBe("learning"); // 再学习折叠为 learning
    expect(out.lapses).toBe(1);
    expect(out.reps).toBe(3);
    expect(out.stability).toBeCloseTo(0.63697811, 3);
    expect(out.difficulty).toBeCloseTo(7.39223814, 3);
    expect(out.scheduledDays).toBe(0);
    expect(out.dueAt).toBe("2026-08-10T00:10:00.000Z"); // relearning step 10m
    expect(out.learningSteps).toBe(0);
  });

  it("再学习完成 Good：回到 review，lapses 保持 1，间隔 1 天", () => {
    const relearn = {
      state: "learning" as const,
      stability: 0.63697811,
      difficulty: 7.39223814,
      scheduledDays: 0,
      elapsedDays: 3,
      reps: 3,
      lapses: 1,
      learningSteps: 0,
      lastReviewAt: "2026-08-10T00:00:00.000Z",
      dueAt: "2026-08-10T00:10:00.000Z",
      schedulerVersion: SCHEDULER_VERSION,
      schedulerParametersVersion: PARAM_VERSION,
      stateVersion: 3,
    };
    const out = scheduleNextLearningCard({
      card: relearn,
      now: new Date("2026-08-10T00:05:00.000Z"),
      rating: "good",
      parameters: PARAMS,
    });
    expect(out.state).toBe("review");
    expect(out.lapses).toBe(1);
    expect(out.reps).toBe(4);
    expect(out.scheduledDays).toBe(1);
    expect(out.dueAt).toBe("2026-08-11T00:05:00.000Z");
  });
});

describe("scheduleNextLearningCard（确定性）", () => {
  it("同一输入两次调用产生完全一致的输出", () => {
    const a = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    const b = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    expect(a).toEqual(b);
  });

  it("已进入 review 的历史卡不会静默从自定义参数切回默认参数（版本不匹配被拒绝）", () => {
    const custom = {
      ...PARAMS,
      requestRetention: 0.85,
    };
    const customVersion = fsrsParameterVersion(custom);
    expect(customVersion).not.toBe(PARAM_VERSION);

    // 该历史卡上次由自定义参数集调度，persisted 版本是 customVersion。
    const reviewCardWithCustom = {
      state: "review" as const,
      stability: 3.0,
      difficulty: 2.0,
      scheduledDays: 3,
      elapsedDays: 0,
      reps: 2,
      lapses: 0,
      learningSteps: 0,
      lastReviewAt: "2026-08-01T00:00:00.000Z",
      dueAt: "2026-08-04T00:00:00.000Z",
      schedulerVersion: SCHEDULER_VERSION,
      schedulerParametersVersion: customVersion,
      stateVersion: 2,
    };

    // 用默认参数调度 → 版本不匹配，必须拒绝，绝不静默切回默认参数。
    expect(() =>
      scheduleNextLearningCard({
        card: reviewCardWithCustom,
        now: NOW,
        rating: "good",
        parameters: PARAMS,
      }),
    ).toThrow(/参数版本不匹配/);

    // 用同一自定义参数调度 → 版本一致 → 正常返回，输出间隔按保留率 0.85。
    const out = scheduleNextLearningCard({
      card: reviewCardWithCustom,
      now: NOW,
      rating: "good",
      parameters: custom,
    });
    expect(out.schedulerParametersVersion).toBe(customVersion);
    expect(out.scheduledDays).toBeGreaterThan(0);
    expect(out.schedulerVersion).toBe(SCHEDULER_VERSION);
  });
});

describe("scheduleNextLearningCard（非法评分双保险）", () => {
  it("非法评分抛错而非静默处理", () => {
    // 类型层面 FourScoreRating 已挡住非法评分；运行时校验是双保险，这里显式注入非法值。
    const badRating = "manual" as string;
    expect(() =>
      scheduleNextLearningCard({
        card: newCard(),
        now: NOW,
        rating: badRating as "again",
        parameters: PARAMS,
      }),
    ).toThrow(/无效评分/);
  });
});

describe("scheduleNextLearningCard（无效服务器时间与非法持久化日期拒绝）", () => {
  it("无效 now（NaN）抛领域错误，绝不回退到 1970", () => {
    const invalidNow = new Date("not-a-date");
    expect(Number.isNaN(invalidNow.getTime())).toBe(true);
    expect(() =>
      scheduleNextLearningCard({
        card: newCard(),
        now: invalidNow,
        rating: "good",
        parameters: PARAMS,
      }),
    ).toThrow(/无效服务器时间/);
  });

  it("非 new 卡因无效 lastReviewAt 被拒绝（不得当 undefined 静默丢弃）", () => {
    const card = {
      ...newCard({
        state: "review" as const,
        reps: 2,
        lapses: 0,
        lastReviewAt: "bad-date",
        dueAt: "2026-08-09T00:00:00.000Z",
      }),
      schedulerParametersVersion: PARAM_VERSION,
    };
    expect(() =>
      scheduleNextLearningCard({ card, now: NOW, rating: "good", parameters: PARAMS }),
    ).toThrow(/last_review_at/);
  });

  it("非 new 卡因非法 dueAt 被拒绝", () => {
    const card = {
      ...newCard({
        state: "review" as const,
        reps: 2,
        lapses: 0,
        lastReviewAt: "2026-08-07T00:00:00.000Z",
        dueAt: "not-a-date",
      }),
      schedulerParametersVersion: PARAM_VERSION,
    };
    expect(() =>
      scheduleNextLearningCard({ card, now: NOW, rating: "good", parameters: PARAMS }),
    ).toThrow(/due_at/);
  });
});

describe("scheduleNextLearningCard（参数版本参与调度边界）", () => {
  it("a) 新卡占位版本可按默认参数首次调度，输出真实参数版本", () => {
    const placeholderCard = newCard({ schedulerParametersVersion: "fsrs-v6/default" });
    const out = scheduleNextLearningCard({
      card: placeholderCard,
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    expect(out.schedulerParametersVersion).toBe(PARAM_VERSION);
    expect(out.stateVersion).toBe(1);
  });

  it("a') 占位版本 + 未指定参数（默认）也可首次调度", () => {
    const placeholderCard = newCard({ schedulerParametersVersion: "fsrs-v6/default" });
    const out = scheduleNextLearningCard({ card: placeholderCard, now: NOW, rating: "again" });
    expect(out.schedulerParametersVersion).toBe(PARAM_VERSION);
  });

  it("a'') 占位新卡 + 自定义参数集被拒绝（只允许首次进入默认参数集）", () => {
    const placeholderCard = newCard({ schedulerParametersVersion: "fsrs-v6/default" });
    const custom = { ...PARAMS, requestRetention: 0.85 };
    expect(() =>
      scheduleNextLearningCard({
        card: placeholderCard,
        now: NOW,
        rating: "good",
        parameters: custom,
      }),
    ).toThrow(/占位版本.*只允许首次进入默认/);
  });

  it("b) 非 new 卡参数版本不匹配被拒绝", () => {
    const mismatched = {
      ...newCard({
        state: "review" as const,
        reps: 2,
        lapses: 0,
        lastReviewAt: "2026-08-07T00:00:00.000Z",
        dueAt: "2026-08-09T00:00:00.000Z",
      }),
      schedulerParametersVersion: "fsrs-6.0:pxx-unknown",
    };
    expect(() =>
      scheduleNextLearningCard({ card: mismatched, now: NOW, rating: "good", parameters: PARAMS }),
    ).toThrow(/参数版本不匹配/);
  });

  it("b') 非 new 卡携带占位版本（非未调度初始卡）被拒绝", () => {
    const notUnseen = {
      ...newCard({
        state: "learning" as const,
        reps: 1,
        lapses: 0,
        lastReviewAt: "2026-08-07T00:00:00.000Z",
        dueAt: "2026-08-07T00:10:00.000Z",
      }),
      schedulerParametersVersion: "fsrs-v6/default",
    };
    expect(() =>
      scheduleNextLearningCard({ card: notUnseen, now: NOW, rating: "good", parameters: PARAMS }),
    ).toThrow(/占位/);
  });

  it("d) 完全相同状态、时间、参数版本和评分得到完全相同结果", () => {
    const card = newCard({ schedulerParametersVersion: PARAM_VERSION });
    const a = scheduleNextLearningCard({ card, now: NOW, rating: "hard", parameters: PARAMS });
    const b = scheduleNextLearningCard({ card, now: NOW, rating: "hard", parameters: PARAMS });
    expect(a).toEqual(b);
  });
});

describe("scheduleNextLearningCard（UTC 跨日边界与时区稳定性）", () => {
  it("跨月边界：8/31 23:59:59 到期，下月 1 日 00:00:00 复习，间隔不因本地时区漂移", () => {
    const nextMonth = new Date("2026-09-01T00:00:00.000Z");
    const card = {
      state: "review" as const,
      stability: 3.0,
      difficulty: 2.0,
      scheduledDays: 1,
      elapsedDays: 0,
      reps: 2,
      lapses: 0,
      learningSteps: 0,
      lastReviewAt: "2026-08-30T00:00:00.000Z",
      dueAt: "2026-08-31T23:59:59.000Z",
      schedulerVersion: SCHEDULER_VERSION,
      schedulerParametersVersion: PARAM_VERSION,
      stateVersion: 2,
    };
    const out = scheduleNextLearningCard({
      card,
      now: nextMonth,
      rating: "good",
      parameters: PARAMS,
    });
    expect(out.lastReviewAt).toBe("2026-09-01T00:00:00.000Z");
    // 距上次复习 2 天、stability=3.0 → FSRS 计算 12 天间隔，绝不受本地时区影响。
    expect(out.elapsedDays).toBe(2);
    expect(out.scheduledDays).toBe(12);
    expect(out.stability).toBeCloseTo(11.94746206, 3);
    expect(out.dueAt).toBe("2026-09-13T00:00:00.000Z");
  });

  it("机器时区不影响结果：等价 UTC 时间点输出一致（跨时区用例）", () => {
    // 相同绝对时刻的两种表示（同一毫秒），调度结果必须一致。
    const t1 = new Date("2026-03-08T06:00:00.000Z");
    const t2 = new Date("2026-03-08T06:00:00.000Z");
    const out1 = scheduleNextLearningCard({
      card: newCard(),
      now: t1,
      rating: "easy",
      parameters: PARAMS,
    });
    const out2 = scheduleNextLearningCard({
      card: newCard(),
      now: t2,
      rating: "easy",
      parameters: PARAMS,
    });
    expect(out1).toEqual(out2);
  });
});

describe("scheduleNextLearningCard（方向独立性）", () => {
  it("两张方向卡互不影响：同一输入分别调度输出相同（方向是身份属性，非调度输入）", () => {
    const enOut = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    const zhOut = scheduleNextLearningCard({
      card: newCard(),
      now: NOW,
      rating: "good",
      parameters: PARAMS,
    });
    expect(enOut).toEqual(zhOut);
    // 输出不含方向字段：调度不感知方向，方向隔离由卡身份（user+item+direction）保证。
    expect("direction" in enOut).toBe(false);
  });
});
