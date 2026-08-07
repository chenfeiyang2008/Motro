// FSRS v6 调度适配器（阶段 5 工单 02）。
//
// 版本化、纯函数、确定性可测的调度边界：输入当前卡状态 + 固定参数版本 + 服务器时间 + 四级评分，
// 输出下一学习状态。绝不在本模块内使用 new Date()/随机数/本地时区——调度完全由输入决定；
// 时间点一律按 UTC（Date timestamptz）。
//
// 只支持 Again/Hard/Good/Easy；其他评分在进入本边界之前已被校验拒绝（见 rating.ts）。
// 不重写历史事件；不创建 ReviewEvent；不触碰数据库。方向独立：同一课程词项两张卡各自推进，
// 本函数不感知方向，仅按卡状态调度。
//
// 严格性：
//   - 无效服务器时间（now.getTime() 为 NaN）必须抛领域错误，绝不静默回退到某固定时刻。
//   - 无效持久化时间串（lastReviewAt / dueAt 不可解析）在需要该时间时必须明确拒绝，不得当 undefined。
//   - 参数版本参与调度边界：对非 new 卡，传入参数集计算出的 fsrsParameterVersion 必须与
//     card.schedulerParametersVersion 一致，不一致即抛错（禁止历史卡静默换参数）。
//   - 0011 占位 'fsrs-v6/default' 只允许未调度初始卡（new、reps=0、lapses=0、learningSteps=0）
//     首次进入默认参数集；其他带占位或未知/不匹配版本的历史卡拒绝。
//
// 状态模型：ts-fsrs 内部有四态（New/Learning/Review/Relearning），而数据库仅存
// new/learning/review 三态。Relearning 折叠到 learning；用 lapses>=1 区分「再学习」与
// 首次学习（new→Good 的 learning 卡 lapses 恒为 0），从而重放下一轮时能重建 ts-fsrs 内部态，
// 保证调度不失真（学习步骤与再学习步骤的间隔不同，折叠会破坏确定性）。
import { FSRS, Rating, State, generatorParameters, type Card as FsrsCard } from "ts-fsrs";
import { SCHEDULER_VERSION } from "../learning-card.js";
import {
  DEFAULT_FSRS_PARAMETERS,
  INITIAL_PARAMETERS_PLACEHOLDER,
  fsrsParameterVersion,
  type FsrsParameters,
} from "./parameters.js";
import { isFourScoreRating, type FourScoreRating } from "./rating.js";

export type StoredCardState = "new" | "learning" | "review";

/** 输入：当前学习卡的调度相关状态（数据库中 learning_cards 行的镜像）。 */
export interface CardSchedulingInput {
  state: StoredCardState;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  elapsedDays: number;
  reps: number;
  lapses: number;
  /** 已完成的学习/再学习步骤数（ts-fsrs 决定下一步必需）。 */
  learningSteps: number;
  lastReviewAt: string | null;
  dueAt: string;
  schedulerVersion: string;
  /** 该卡上次调度所依据的参数版本引用。 */
  schedulerParametersVersion: string;
  stateVersion: number;
}

export interface ScheduleNextCardInput {
  card: CardSchedulingInput;
  /** 服务器权威时间（UTC 时间点）。无效 Date（NaN）会抛领域错误。 */
  now: Date;
  rating: FourScoreRating;
  /** 本次调度使用的参数集；缺省用官方 v6 默认。非 new 卡其版本必须与 card.schedulerParametersVersion 一致。 */
  parameters?: FsrsParameters;
}

/** 调度的明确领域错误：消息含卡状态/原因，绝不静默改写卡状态或产生部分结果。 */
export class SchedulingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulingInputError";
  }
}

export interface NextScheduleCard {
  state: "learning" | "review";
  stability: number;
  difficulty: number;
  scheduledDays: number;
  /** 距上次复习的经过天数（由 ts-fsrs 计算）。 */
  elapsedDays: number;
  reps: number;
  lapses: number;
  /** 下一轮调度时所需的学习步骤计数（ts-fsrs 内部状态的一部分）。 */
  learningSteps: number;
  lastReviewAt: string;
  dueAt: string;
  schedulerVersion: string;
  schedulerParametersVersion: string;
  stateVersion: number;
}

const RATING_TO_GRADE: Record<FourScoreRating, number> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/** 解析持久化时间字符串；非法值抛领域错误（绝不当作 undefined 静默丢弃）。 */
function parseStoredDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new SchedulingInputError(
      `非法持久化时间：${field}=${value} 无法解析，拒绝调度（不改写卡状态）`,
    );
  }
  return d;
}

/** 解析必需的持久化时间字符串；null 或非法值都抛领域错误。 */
function resolveRequiredDate(value: string | null, field: string): Date {
  if (value === null) {
    throw new SchedulingInputError(`调度需要 ${field} 但持久化值为 null，无法计算（不改写卡状态）`);
  }
  return parseStoredDate(value, field);
}

/**
 * 校验并返回本次使用的参数版本与 FsrsParameters：
 *   - new 未调度的纯初始卡：允许占位版本，首次使用默认参数集，输出真实版本。
 *   - 其他（new 卡带真实版本、learning/review 卡）：card.schedulerParametersVersion 必须与
 *     本次参数算出的版本一致，否则抛错（历史卡不得静默换参数）。
 */
function resolveParameters(
  card: CardSchedulingInput,
  requested?: FsrsParameters,
): { params: FsrsParameters; isUnseenNewCard: boolean } {
  const isUnseenNewCard =
    card.state === "new" && card.reps === 0 && card.lapses === 0 && card.learningSteps === 0;

  const storedVersion = card.schedulerParametersVersion;
  // 占位版本只允许未调度初始卡首次进入「默认 FSRS v6 参数集」：
  // 必须用 DEFAULT_FSRS_PARAMETERS，若调用方显式传入任何非默认参数集则拒绝。
  if (storedVersion === INITIAL_PARAMETERS_PLACEHOLDER) {
    if (!isUnseenNewCard) {
      throw new SchedulingInputError(
        `参数版本为占位 ${INITIAL_PARAMETERS_PLACEHOLDER} 却不是未调度初始卡(state=${card.state}, reps=${card.reps})，拒绝按默认参数调度`,
      );
    }
    if (requested !== undefined && requested !== DEFAULT_FSRS_PARAMETERS) {
      throw new SchedulingInputError(
        `占位版本 ${INITIAL_PARAMETERS_PLACEHOLDER} 的未调度初始卡只允许首次进入默认 FSRS v6 参数集，拒绝使用自定义参数首次调度`,
      );
    }
    return { params: DEFAULT_FSRS_PARAMETERS, isUnseenNewCard: true };
  }

  const params = requested ?? DEFAULT_FSRS_PARAMETERS;
  const computedVersion = fsrsParameterVersion(params);
  if (storedVersion !== computedVersion) {
    throw new SchedulingInputError(
      `参数版本不匹配：卡保存 ${storedVersion}，本次计算 ${computedVersion}；历史卡不得静默换参数`,
    );
  }
  return { params, isUnseenNewCard: false };
}

/** 由已存储状态 + lapses 重建 ts-fsrs 内部状态。 */
function resolveFsrsState(state: StoredCardState, lapses: number): State {
  if (state === "new") return State.New;
  if (state === "review") return State.Review;
  // learning：若曾 lapse（lapses>=1）则是「再学习」，否则为「初学习」。
  return lapses >= 1 ? State.Relearning : State.Learning;
}

/**
 * 计算下一学习状态（纯函数）：
 * 输入当前状态 + 固定时间 + 四级评分 + 参数版本 → 输出下一状态与 dueAt 等。
 * 非法 now、非法持久化时间、参数版本不匹配均抛 SchedulingInputError，绝不部分推进。
 */
export function scheduleNextLearningCard(input: ScheduleNextCardInput): NextScheduleCard {
  if (!isFourScoreRating(input.rating)) {
    throw new SchedulingInputError(
      `无效评分：${input.rating}；FSRS 只允许 ${["again", "hard", "good", "easy"].join(" / ")}`,
    );
  }
  if (Number.isNaN(input.now.getTime())) {
    throw new SchedulingInputError(`无效服务器时间：无法解析，拒绝调度（不改写卡状态）`);
  }
  const now = input.now;

  const { params, isUnseenNewCard } = resolveParameters(input.card, input.parameters);
  const fsrs = new FSRS(generatorParameters(transcribeParams(params)));

  const internalState = resolveFsrsState(input.card.state, input.card.lapses);

  // new 卡：用 ts-fsrs 空卡（此时不读 dueAt/lastReviewAt；两者本就不在该状态使用）。
  // 非 new 卡：必须解析持久化因子的 dueAt/lastReviewAt，任何非法值都抛错。
  const card: FsrsCard =
    internalState === State.New
      ? {
          due: now,
          stability: 0,
          difficulty: 0,
          elapsed_days: 0,
          scheduled_days: 0,
          learning_steps: 0,
          reps: 0,
          lapses: 0,
          state: State.New,
        }
      : {
          due: parseStoredDate(input.card.dueAt, "due_at"),
          stability: input.card.stability,
          difficulty: input.card.difficulty,
          elapsed_days: input.card.elapsedDays,
          scheduled_days: input.card.scheduledDays,
          learning_steps: input.card.learningSteps,
          reps: input.card.reps,
          lapses: input.card.lapses,
          state: internalState,
          // 非 new 卡计算经过天数必须依赖 last_review；null 或非法值都明确拒绝。
          last_review: resolveRequiredDate(input.card.lastReviewAt, "last_review_at"),
        };

  const next = fsrs.next(card, now, RATING_TO_GRADE[input.rating]).card;

  const outState: NextScheduleCard["state"] = next.state === State.Review ? "review" : "learning";

  return {
    state: outState,
    stability: next.stability,
    difficulty: next.difficulty,
    scheduledDays: next.scheduled_days,
    elapsedDays: next.elapsed_days,
    reps: next.reps,
    lapses: next.lapses,
    learningSteps: next.learning_steps,
    lastReviewAt: now.toISOString(),
    dueAt: next.due.toISOString(),
    schedulerVersion: SCHEDULER_VERSION,
    // 首次调度（原来是占位版本）输出真实参数版本；其余保持卡已声明且校验过的版本。
    schedulerParametersVersion: isUnseenNewCard
      ? fsrsParameterVersion(params)
      : input.card.schedulerParametersVersion,
    stateVersion: input.card.stateVersion + 1,
  };
}

/** 把我们的 FsrsParameters 转译成 ts-fsrs 的 generatorParameters 输入。 */
function transcribeParams(params: FsrsParameters): Parameters<typeof generatorParameters>[0] {
  return {
    request_retention: params.requestRetention,
    maximum_interval: params.maximumInterval,
    w: params.w,
    enable_fuzz: params.enableFuzz,
    enable_short_term: params.enableShortTerm,
    learning_steps: params.learningSteps as never,
    relearning_steps: params.relearningSteps as never,
  };
}
