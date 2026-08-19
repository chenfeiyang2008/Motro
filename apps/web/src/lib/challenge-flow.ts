// 周挑战答题流程的纯逻辑（Ticket 21）。
// 只做状态机 / 进度投影 / 结果投影；绝不自行判分、不计算积分、不把题目或资格写入
// localStorage 作为事实源。积分/判分权威完全来自服务端 ChallengeVerdict。
//
// 不变量：
//   - 每题必须收到服务端成功响应后才推进到下一题；
//   - 不允许前端计算分数；pointsAwarded 只透传服务端 verdict；
//   - 重复提交由组件层对同一 position 去重（本模块只建模，不发起请求）;
//   - 倒计时结束、周截止、空题目、409 冲突都映射到明确状态。

export type ChallengeDirection = "en_to_zh" | "zh_to_en";
export type ChallengeQuestionType = "choice" | "spelling";
export type ChallengeVerdictKind = "scored" | "review" | "wrong" | "already_scored";

export interface ChallengeItemFlow {
  position: number;
  direction: ChallengeDirection;
  questionType: ChallengeQuestionType;
  englishSpelling: string;
  meaning: string;
}

export interface VerdictFlow {
  isCorrect: boolean;
  pointsAwarded: number;
  kind: ChallengeVerdictKind;
  correctAnswer: string;
}

export type PerItemState =
  | { phase: "answering" } // 等待输入/提交
  | { phase: "submitting" } // 已提交，等服务端
  | { phase: "answered"; verdict: VerdictFlow } // 服务端已判分
  | { phase: "retryable"; error: string }; // 网络/可重试失败，保留输入，可重试

export interface ChallengeFlowState {
  attemptId: string | null;
  weekKey: string;
  weekEndIso: string; // 服务端返回的北京时间截止
  /** 服务端返回的倒计时截止时刻（本题测验的 expiresAt）；null 表示由周截止约束。 */
  expiresAtIso: string | null;
  items: ChallengeItemFlow[];
  currentIndex: number;
  perItem: PerItemState[];
  /** 服务端累计已答正确数（前端只累积透传的 verdict，不自行判分）。 */
  answeredCount: number;
  scoreEligibleCorrectCount: number;
  phase:
    | "loading"
    | "not_eligible" // no exposed words (attemptId null + empty items)
    | "in_progress"
    | "completed"
    | "cutoff"
    | "conflict"
    | "ended";
}

const TOTAL_ITEMS = 10;

/** 从服务端 ChallengeCurrent 投影成流程态。空 items + null attemptId → not_eligible。 */
export function buildInitialFlow(input: {
  attemptId: string | null;
  weekKey: string;
  weekEndIso: string;
  expiresAtIso?: string | null;
  items: ChallengeItemFlow[];
  status?: string;
}): ChallengeFlowState {
  if (input.attemptId === null || input.items.length === 0) {
    return {
      attemptId: null,
      weekKey: input.weekKey,
      weekEndIso: input.weekEndIso,
      expiresAtIso: input.expiresAtIso ?? null,
      items: [],
      currentIndex: 0,
      perItem: [],
      answeredCount: 0,
      scoreEligibleCorrectCount: 0,
      phase: "not_eligible",
    };
  }
  return {
    attemptId: input.attemptId,
    weekKey: input.weekKey,
    weekEndIso: input.weekEndIso,
    expiresAtIso: input.expiresAtIso ?? null,
    items: input.items,
    currentIndex: 0,
    perItem: input.items.map(() => ({ phase: "answering" })),
    answeredCount: 0,
    scoreEligibleCorrectCount: 0,
    phase: "in_progress",
  };
}

/** 当前展示位置的索引（从 0 起）。不存在时返回 null。 */
export function currentQuestionIndex(state: ChallengeFlowState): number | null {
  return state.phase === "in_progress" && state.items.length > 0 ? state.currentIndex : null;
}

/** 是否所有题都已完成。 */
export function allAnswered(state: ChallengeFlowState): boolean {
  return state.items.length > 0 && state.perItem.every((p) => p.phase === "answered");
}

/**
 * 收到服务端成功 verdict 后推进。
 * 仅透传服务端的 isCorrect / pointsAwarded / kind，绝不本地计算。
 */
export function applyVerdict(
  state: ChallengeFlowState,
  position: number,
  verdict: VerdictFlow,
): ChallengeFlowState {
  const idx = state.items.findIndex((i) => i.position === position);
  if (idx < 0) return state;
  const perItem = state.perItem.slice();
  perItem[idx] = { phase: "answered", verdict };

  const answeredCount = perItem.filter((p) => p.phase === "answered" && p.verdict.isCorrect).length;
  const scoreEligibleCorrectCount = perItem.filter(
    (p) => p.phase === "answered" && p.verdict.pointsAwarded > 0,
  ).length;

  const allDone = perItem.every((p) => p.phase === "answered");
  const nextIndex = allDone ? state.currentIndex : Math.min(idx + 1, state.items.length - 1);

  return {
    ...state,
    perItem,
    answeredCount,
    scoreEligibleCorrectCount,
    currentIndex: nextIndex,
    phase: allDone ? "completed" : "in_progress",
  };
}

/**
 * 网络失败 / 可重试错误：把当前 position 标记为 retryable，保留用户输入。
 * 不推进、不判分、不丢题。
 */
export function markRetryable(
  state: ChallengeFlowState,
  position: number,
  error: string,
): ChallengeFlowState {
  const idx = state.items.findIndex((i) => i.position === position);
  if (idx < 0) return state;
  const perItem = state.perItem.slice();
  perItem[idx] = { phase: "retryable", error };
  return { ...state, perItem };
}

/** 409 冲突（并发/状态冲突）：提示重新同步，退回加载态由组件重新获取当前 attempt。 */
export function markConflict(state: ChallengeFlowState): ChallengeFlowState {
  return { ...state, phase: "conflict" };
}

/** 倒计时结束 / 周截止：停止提交，进入 ended。 */
export function markEnded(state: ChallengeFlowState): ChallengeFlowState {
  return {
    ...state,
    phase: state.phase === "completed" ? "completed" : "ended",
  };
}

// ---- 结果页投影（只读服务端结果）----

export interface ChallengeResultProjection {
  totalItems: number;
  correctCount: number;
  /** 本次新增 Challenge Points（只透传服务端 verdict 的 pointsAwarded 累加，不自行计算）。 */
  newChallengePoints: number;
  /** 已经计分的复习题数量（kind === 'already_scored'）。 */
  alreadyScoredCount: number;
}

/** 从最终流程态投影结果页事实。未完成时返回 null。 */
export function projectResult(state: ChallengeFlowState): ChallengeResultProjection | null {
  if (state.phase !== "completed" || state.items.length === 0) return null;
  return {
    totalItems: state.items.length,
    correctCount: state.answeredCount,
    // 本次新增 CP：只累加服务端 verdict 的 pointsAwarded，绝不自行判分。
    newChallengePoints: state.perItem.reduce(
      (acc, p) => acc + (p.phase === "answered" ? p.verdict.pointsAwarded : 0),
      0,
    ),
    alreadyScoredCount: state.perItem.filter(
      (p) => p.phase === "answered" && p.verdict.kind === "already_scored",
    ).length,
  };
}

/** 进度标签："n / 10"。 */
export function progressLabel(state: ChallengeFlowState): string {
  const done = state.perItem.filter((p) => p.phase === "answered").length;
  return `${done} / ${TOTAL_ITEMS}`;
}

/** 剩余秒数 ≤ 0 时表示已结束。 */
export function isExpired(expiresAtIso: string | null, nowIso: string): boolean {
  if (!expiresAtIso) return false;
  return new Date(expiresAtIso).getTime() <= new Date(nowIso).getTime();
}
