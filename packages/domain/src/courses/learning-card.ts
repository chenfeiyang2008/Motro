// 学习卡与学习展示的纯领域规则（阶段 5 工单 01）。
// 只描述不依赖数据库的不变量：方向校验、初始卡状态、方向对规则、卡身份键、展示状态映射。
// FSRS 调度计算属于工单 02，本文件不实现任何调度逻辑。

export const CARD_DIRECTIONS = ["en_to_zh", "zh_to_en"] as const;
export type CardDirection = (typeof CARD_DIRECTIONS)[number];

export const CARD_STATES = ["new", "learning", "review"] as const;
export type CardState = (typeof CARD_STATES)[number];

export const SCHEDULER_VERSION = "fsrs-v6";

/** 方向校验：英文→中文与中文→英文是两个允许的独立方向。 */
export function validateCardDirection(direction: string): string[] {
  if (!CARD_DIRECTIONS.includes(direction as CardDirection)) {
    return [`方向不合法：${direction}；只允许 ${CARD_DIRECTIONS.join(" / ")}`];
  }
  return [];
}

export interface InitialCardStateInput {
  userId: string;
  courseId: string;
  courseItemId: string;
  direction: CardDirection;
  /** 可注入时钟，默认取当前时间；写入数据库前始终由服务端重新生成。 */
  now?: Date;
}

export interface InitialCardState {
  userId: string;
  courseId: string;
  courseItemId: string;
  direction: CardDirection;
  state: "new";
  stability: number;
  difficulty: number;
  scheduledDays: number;
  elapsedDays: number;
  reps: number;
  lapses: number;
  lastReviewAt: string | null;
  dueAt: string;
  schedulerVersion: string;
  stateVersion: number;
}

/** 初始学习卡状态：新卡 + FSRS v6 初始字段，立即到期（new 卡待首测）。 */
export function buildInitialCardState(input: InitialCardStateInput): InitialCardState {
  const now = input.now ?? new Date();
  return {
    userId: input.userId,
    courseId: input.courseId,
    courseItemId: input.courseItemId,
    direction: input.direction,
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
    stateVersion: 0,
  };
}

/** 同一课程词项的两个方向卡：英文→中文与中文→英文是两张独立卡。 */
export function buildDirectionalCardsForItem(
  input: Omit<InitialCardStateInput, "direction">,
): InitialCardState[] {
  return CARD_DIRECTIONS.map((direction) => buildInitialCardState({ ...input, direction }));
}

/** 卡身份键：用户 + 稳定课程词项 + 方向。跨用户隔离；跨课程因 course_item_id 不同而不共享。 */
export function cardIdentityKey(
  userId: string,
  courseItemId: string,
  direction: CardDirection,
): string {
  return `${userId}:${courseItemId}:${direction}`;
}

/** 两行卡共享同一身份（用户 + 词项 + 方向相同）则视为同一张卡，可用于去重断言。 */
export function sameCardIdentity(
  a: { userId: string; courseItemId: string; direction: string },
  b: { userId: string; courseItemId: string; direction: string },
): boolean {
  return (
    cardIdentityKey(a.userId, a.courseItemId, a.direction as CardDirection) ===
    cardIdentityKey(b.userId, b.courseItemId, b.direction as CardDirection)
  );
}

export interface ExposureRowInput {
  first_exposed_at: Date | string;
}

export interface ExposureState {
  exposed: boolean;
  firstExposedAt: string | null;
}

/** 展示行（可能为 null）→ 该词项对当前用户是否已展示及首次展示时间。 */
export function buildExposureState(row: ExposureRowInput | null): ExposureState {
  if (!row) return { exposed: false, firstExposedAt: null };
  return { exposed: true, firstExposedAt: new Date(row.first_exposed_at).toISOString() };
}

export interface BuildExposureRecordInput {
  userId: string;
  courseItemId: string;
  lexicalEntryId: string;
  courseId: string;
  releaseId: string;
  releasedItemId: string;
  requestId?: string | null;
  now?: Date;
}

export interface ExposureRecord {
  userId: string;
  courseItemId: string;
  lexicalEntryId: string;
  courseId: string;
  releaseId: string;
  releasedItemId: string;
  firstExposedAt: string;
  requestId: string | null;
}

/** 学习展示记录字段（id 由数据库生成）：首次展示事实的快照形状。 */
export function buildExposureRecord(input: BuildExposureRecordInput): ExposureRecord {
  const now = input.now ?? new Date();
  return {
    userId: input.userId,
    courseItemId: input.courseItemId,
    lexicalEntryId: input.lexicalEntryId,
    courseId: input.courseId,
    releaseId: input.releaseId,
    releasedItemId: input.releasedItemId,
    firstExposedAt: now.toISOString(),
    requestId: input.requestId ?? null,
  };
}
