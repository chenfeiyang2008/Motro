// FSRS v6 参数版本引用（阶段 5 工单 02）。
//
// 目的：让「算法版本」与「算法参数版本」可被明确区分、独立追踪：
//   - schedulerVersion         = 算法版本（fsrs-v6），见 ../learning-card.ts 的 SCHEDULER_VERSION。
//   - schedulerParametersVersion = 同一套 FSRS-6.0 默认参数的内容引用。
//
// 参数来源：官方 ts-fsrs@5.4.1 的 generatorParameters() 默认值。这里不硬编码 w 数值，
// 而是直接读取 ts-fsrs 暴露的默认常量，再用这些常量计算一个稳定版本串，从而：
//   - 与官方实现保持一致，参数不会在我方复制中漂移；
//   - 版本串对参数内容敏感（默认参数变更即产生新版本），对既有学习卡做参数版本可追溯。
//
// 纯函数：不依赖时钟、随机数或本地时区；任何时刻调用返回同一参数对象与版本串。
import {
  default_enable_fuzz,
  default_enable_short_term,
  default_learning_steps,
  default_maximum_interval,
  default_relearning_steps,
  default_request_retention,
  default_w,
} from "ts-fsrs";

/** FSRS 参数对象：由官方 v6 默认值与一个显式命名构成，供调度时构建 fsrs 实例。 */
export interface FsrsParameters {
  /** 请求保留率（默认 0.9）。 */
  requestRetention: number;
  /** 最大间隔天数（默认 36500）。 */
  maximumInterval: number;
  /** FSRS-6.0 的 21 维权重数组。 */
  w: readonly number[];
  /** 关闭模糊，保证确定性调度；官方默认即为 false。 */
  enableFuzz: boolean;
  /** 启用短时记忆步骤（学习/再学习步骤）；官方默认即为 true。 */
  enableShortTerm: boolean;
  /** (再)学习步骤，如 ["1m","10m"]。 */
  learningSteps: readonly string[];
  relearningSteps: readonly string[];
}

/**
 * 参数版本引用串：`fsrs-6.0:p<指纹>`。
 * 指纹对参数内容敏感（保留率、最大间隔、权重、模糊/短时开关、步骤）；
 * 同一参数内容恒等，参数变化即翻版。纯函数、无副作用。
 */
export function fsrsParameterVersion(params: FsrsParameters): string {
  const fingerprint = [
    `rr:${params.requestRetention}`,
    `mi:${params.maximumInterval}`,
    `fuzz:${params.enableFuzz ? 1 : 0}`,
    `st:${params.enableShortTerm ? 1 : 0}`,
    `steps:${params.learningSteps.join("+")}|${params.relearningSteps.join("+")}`,
    `w:${params.w.join(",")}`,
  ].join(";");
  return `fsrs-6.0:p${fingerprint}`;
}

/** 权重数组 → 稳定标识串，供诊断与测试断言（不参与版本指纹，避免为每个实现细节翻版本）。 */
export function weightIdentifier(w: readonly number[]): string {
  return w.map((v) => String(v)).join(",");
}

/**
 * FSRS v6 默认参数引用：真正的模块级常量，创建时一次性冻结，任何调用返回同一对象。
 * schedulerParametersVersion = fsrsParameterVersion(DEFAULT_FSRS_PARAMETERS)。
 * 只读、无时钟/随机数/时区依赖，恒等引用保证确定性。
 */
export const DEFAULT_FSRS_PARAMETERS: Readonly<FsrsParameters> = Object.freeze({
  requestRetention: default_request_retention,
  maximumInterval: default_maximum_interval,
  w: Object.freeze([...default_w]),
  enableFuzz: default_enable_fuzz,
  enableShortTerm: default_enable_short_term,
  learningSteps: Object.freeze([...default_learning_steps]),
  relearningSteps: Object.freeze([...default_relearning_steps]),
});

/** 兼容别名：返回唯一的模块级冻结常量（不再每次新建）。 */
export function defaultFsrsParameters(): Readonly<FsrsParameters> {
  return DEFAULT_FSRS_PARAMETERS;
}

/**
 * 未调度初始卡的参数版本占位（0011 migration 对既有/新卡回填的字符串）。
 * 只允许 state=new、reps=0、lapses=0、learningSteps=0 的未调度卡首次进入默认参数集；
 * 第一次成功调度后输出真实 fsrsParameterVersion。
 */
export const INITIAL_PARAMETERS_PLACEHOLDER = "fsrs-v6/default";
