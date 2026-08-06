// 课程/草稿/单元/词项 schema：与 db/migrations/0005_course_drafts_and_units.sql
// 及 0006_draft_course_items.sql 保持一致。
// 一门课程至多一个 active draft；draft 写操作用整数 version 做乐观并发控制。
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditEvents } from "./platform-identity.js";
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
