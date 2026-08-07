// 课程/草稿/单元/词项/发布版本 schema：与 db/migrations/0005~0007 保持一致。
// 一门课程至多一个 active draft；draft 写操作用整数 version 做乐观并发控制；
// release rows 由显式 SQL 触发器禁止 UPDATE/DELETE。
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditEvents, users } from "./platform-identity.js";
import { lexicalEntries } from "./lexicon.js";

export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    level: text("level").notNull().default("a1"),
    description: text("description").notNull().default(""),
    visibility: text("visibility").notNull().default("draft"),
    status: text("status").notNull().default("active"),
    // 真实约束是复合外键 `(id, current_release_id)` → course_releases(course_id, id)，
    // 保证只能指向同一课程的 release，见 0007 migration；这里不声明简单 FK 以免误生成。
    currentReleaseId: uuid("current_release_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("courses_slug_unique").on(t.slug)],
);

// 注意：真实约束“同一课程至多一个 active draft”是部分唯一索引
// `(course_id) WHERE status = 'active'`，见 db/migrations/0005_course_drafts_and_units.sql。
// 当前 Drizzle 版本无法表达部分唯一索引，因此这里【不】声明 uniqueIndex：
// 若声明普通 `uniqueIndex(course_id)` 会生成错误的全局唯一约束，误阻止 archived 草稿。
// 显式 SQL migration 是唯一真实约束来源；schema 只表达列与引用关系。
export const courseDrafts = pgTable("course_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id")
    .notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  title: text("title").notNull(),
  level: text("level").notNull().default("a1"),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"),
  basedOnReleaseId: uuid("based_on_release_id").references(() => courseReleases.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const draftUnits = pgTable(
  "draft_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => courseDrafts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("draft_units_draft_position_unique").on(t.draftId, t.position),
    uniqueIndex("draft_units_draft_unit_id_unique").on(t.draftId, t.id),
    index("draft_units_draft_id_idx").on(t.draftId),
  ],
);

export const draftCourseItems = pgTable(
  "draft_course_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftUnitId: uuid("draft_unit_id")
      .notNull()
      .references(() => draftUnits.id, { onDelete: "cascade" }),
    lexicalEntryId: uuid("lexical_entry_id")
      .notNull()
      .references(() => lexicalEntries.id),
    position: integer("position").notNull(),
    meaning: text("meaning").notNull(),
    hint: text("hint"),
    contentReviewReference: uuid("content_review_reference")
      .notNull()
      .references(() => auditEvents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("draft_course_items_unit_position_unique").on(t.draftUnitId, t.position),
    uniqueIndex("draft_course_items_draft_item_id_unique").on(t.draftUnitId, t.id),
    index("draft_course_items_unit_id_idx").on(t.draftUnitId),
    index("draft_course_items_lexical_entry_id_idx").on(t.lexicalEntryId),
  ],
);

export const courseReleases = pgTable(
  "course_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    releaseNumber: integer("release_number").notNull(),
    title: text("title").notNull(),
    level: text("level").notNull().default("a1"),
    description: text("description").notNull().default(""),
    sourceDraftVersion: integer("source_draft_version").notNull(),
    contentHash: text("content_hash").notNull(),
    releaseNote: text("release_note").notNull().default(""),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("course_releases_course_number_unique").on(t.courseId, t.releaseNumber),
    index("course_releases_course_id_idx").on(t.courseId),
  ],
);

export const releasedUnits = pgTable(
  "released_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => courseReleases.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
  },
  (t) => [
    uniqueIndex("released_units_release_position_unique").on(t.releaseId, t.position),
    uniqueIndex("released_units_release_unit_unique").on(t.releaseId, t.unitId),
    index("released_units_release_id_idx").on(t.releaseId),
  ],
);

export const releasedCourseItems = pgTable(
  "released_course_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => courseReleases.id, { onDelete: "cascade" }),
    releasedUnitId: uuid("released_unit_id")
      .notNull()
      .references(() => releasedUnits.id, { onDelete: "cascade" }),
    courseItemId: uuid("course_item_id").notNull(),
    lexicalEntryId: uuid("lexical_entry_id").notNull(),
    position: integer("position").notNull(),
    englishSpelling: text("english_spelling").notNull(),
    meaning: text("meaning").notNull(),
    hint: text("hint"),
    contentReviewReference: uuid("content_review_reference").notNull(),
  },
  (t) => [
    uniqueIndex("released_items_release_unit_position_unique").on(
      t.releaseId,
      t.releasedUnitId,
      t.position,
    ),
    uniqueIndex("released_items_release_item_unique").on(t.releaseId, t.courseItemId),
    index("released_items_release_id_idx").on(t.releaseId),
  ],
);

// 学习者报名：软停用保留历史；每用户至多一个 active primary。
// partial unique index `(user_id) WHERE active AND is_primary` 在 0009 migration，
// Drizzle 无法表达部分唯一索引，这里只声明普通唯一 (user_id, course_id)。
export const courseEnrollments = pgTable(
  "course_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
    isPrimary: boolean("is_primary").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("course_enrollments_user_course_unique").on(t.userId, t.courseId),
    index("course_enrollments_user_id_idx").on(t.userId),
    index("course_enrollments_course_id_idx").on(t.courseId),
  ],
);

// 学习卡：每 (user, course_item, direction) 一张可调度记忆对象（阶段 5 工单 01）。
// 真实约束在 0010 migration：方向/状态 CHECK、UNIQUE(user, course_item, direction)、
// course_item_id 只经应用层绑定 current release 已发布词项（无父表可设外键）。
export const learningCards = pgTable(
  "learning_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    courseItemId: uuid("course_item_id").notNull(),
    direction: text("direction").notNull(),
    state: text("state").notNull().default("new"),
    stability: doublePrecision("stability").notNull().default(0),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    scheduledDays: integer("scheduled_days").notNull().default(0),
    elapsedDays: integer("elapsed_days").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
    lastReviewAt: timestamp("last_review_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    schedulerVersion: text("scheduler_version").notNull().default("fsrs-v6"),
    schedulerParametersVersion: text("scheduler_parameters_version")
      .notNull()
      .default("fsrs-v6/default"),
    stateVersion: integer("state_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("learning_cards_user_item_direction_unique").on(
      t.userId,
      t.courseItemId,
      t.direction,
    ),
    index("learning_cards_user_due_idx").on(t.userId, t.dueAt),
    index("learning_cards_course_item_idx").on(t.courseItemId),
    index("learning_cards_course_id_idx").on(t.courseId),
  ],
);

// 学习展示：首次看过学习面的事实（阶段 5 工单 01）。
// 真实约束在 0010 migration：UNIQUE(user, course_item)、UPDATE/DELETE 由触发器拒绝（不可变）。
export const learningExposures = pgTable(
  "learning_exposures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseItemId: uuid("course_item_id").notNull(),
    lexicalEntryId: uuid("lexical_entry_id").notNull(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => courseReleases.id, { onDelete: "restrict" }),
    releasedItemId: uuid("released_item_id")
      .notNull()
      .references(() => releasedCourseItems.id, { onDelete: "restrict" }),
    firstExposedAt: timestamp("first_exposed_at", { withTimezone: true }).notNull().defaultNow(),
    requestId: text("request_id"),
  },
  (t) => [
    uniqueIndex("learning_exposures_user_item_unique").on(t.userId, t.courseItemId),
    index("learning_exposures_user_lexical_idx").on(t.userId, t.lexicalEntryId),
    index("learning_exposures_course_item_idx").on(t.courseItemId),
  ],
);

// 每日计划学习会话（阶段 5 工单 03）。
// 真实约束在 0012 migration：状态 CHECK、预算 1–120、partial unique (user_id) WHERE active、
// release_id 冻结创建时刻的 current release、plan_rule_version 冻结计划规则。
// 0013 migration 追加复合外键 (course_id, release_id) → course_releases(course_id, id)，
// 禁止跨课程 release 快照（见下方 foreignKey 声明，与真实约束保持一致）。
export const studySessions = pgTable(
  "study_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => courseReleases.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    dailyBudgetMinutes: integer("daily_budget_minutes").notNull(),
    planRuleVersion: text("plan_rule_version").notNull(),
    cursor: integer("cursor").notNull().default(1),
    plannedAt: timestamp("planned_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("study_sessions_user_id_idx").on(t.userId),
    index("study_sessions_release_id_idx").on(t.releaseId),
    // 复合外键：会话的 (course_id, release_id) 必须指向同一课程的 release（0013 migration）。
    foreignKey({
      columns: [t.courseId, t.releaseId],
      foreignColumns: [courseReleases.courseId, courseReleases.id],
    }),
  ],
);

// 会话计划项（阶段 5 工单 03）：可恢复计划快照，非调度真相来源。
// 真实约束在 0012 migration：position/session 唯一、item_kind/state CHECK、card 引用 learning_cards。
// 0015 migration 追加支撑 review_events 关系一致性的唯一键：
//   UNIQUE (session_id, id)、UNIQUE (id, card_id)——见下方 uniqueIndex 声明，与真实约束保持一致。
export const studySessionItems = pgTable(
  "study_session_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => studySessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => learningCards.id, { onDelete: "restrict" }),
    courseItemId: uuid("course_item_id").notNull(),
    itemKind: text("item_kind").notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("study_session_items_session_position_unique").on(t.sessionId, t.position),
    uniqueIndex("study_session_items_session_id_id_unique").on(t.sessionId, t.id),
    uniqueIndex("study_session_items_id_card_id_unique").on(t.id, t.cardId),
    index("study_session_items_session_id_idx").on(t.sessionId),
    index("study_session_items_card_id_idx").on(t.cardId),
  ],
);

// 复习事件：学习者对单张卡提交一次评分的不可变事实（阶段 5 工单 04）。
// 真实约束在 0014 migration：UNIQUE(user_id, client_event_id)、rating CHECK、
// is_initial_review NOT NULL、UPDATE/DELETE 由触发器拒绝（不可变）、
// state_before / state_after 为完整 JSON 快照（审计与重建依据）。不创建 XP/进度缓存/解锁表。
// 0015 migration 追加复合外键保证关系一致性（事件引用的 session/item/card 必须属于同一条计划项）：
//   (session_id, session_item_id) → study_session_items(session_id, id)；
//   (session_item_id, card_id) → study_session_items(id, card_id)。
// 见下方 foreignKey 声明，与真实约束保持一致。
export const reviewEvents = pgTable(
  "review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => studySessions.id, { onDelete: "restrict" }),
    sessionItemId: uuid("session_item_id")
      .notNull()
      .references(() => studySessionItems.id, { onDelete: "restrict" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => learningCards.id, { onDelete: "restrict" }),
    clientEventId: text("client_event_id").notNull(),
    requestHash: text("request_hash").notNull(),
    rating: text("rating").notNull(),
    isInitialReview: boolean("is_initial_review").notNull(),
    schedulerVersion: text("scheduler_version").notNull(),
    schedulerParametersVersion: text("scheduler_parameters_version").notNull(),
    stateBefore: jsonb("state_before").notNull(),
    stateAfter: jsonb("state_after").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    responseJson: jsonb("response_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_events_user_client_event_unique").on(t.userId, t.clientEventId),
    index("review_events_card_reviewed_idx").on(t.cardId, t.reviewedAt),
    index("review_events_session_id_idx").on(t.sessionId),
    index("review_events_session_item_idx").on(t.sessionItemId),
    index("review_events_user_id_idx").on(t.userId),
    index("review_events_card_is_initial_idx").on(t.cardId, t.isInitialReview),
    // 关系一致性复合外键（0015 migration）：事件的 session/item 必须指向同一条计划项，
    // 且 item 与卡必须匹配该计划项绑定的卡。
    foreignKey({
      columns: [t.sessionId, t.sessionItemId],
      foreignColumns: [studySessionItems.sessionId, studySessionItems.id],
    }),
    foreignKey({
      columns: [t.sessionItemId, t.cardId],
      foreignColumns: [studySessionItems.id, studySessionItems.cardId],
    }),
  ],
);
