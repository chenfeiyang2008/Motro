// 词条/来源 schema：与 db/migrations/0004_manual_lexicon.sql 保持一致。
// 规范化拼写仅建普通索引，不用唯一约束覆盖同形异义词（应用层重复判定决定）。
// canonical_spelling 精确唯一，防止并发创建产生完全相同词条。
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./platform-identity.js";

export const lexicalEntries = pgTable(
  "lexical_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalSpelling: text("canonical_spelling").notNull(),
    normalizedSpelling: text("normalized_spelling").notNull(),
    partOfSpeech: text("part_of_speech"),
    pronunciation: text("pronunciation"),
    senses: jsonb("senses").notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lexical_entries_normalized_spelling_idx").on(t.normalizedSpelling),
    uniqueIndex("lexical_entries_canonical_spelling_unique").on(t.canonicalSpelling),
  ],
);

export const lexicalSources = pgTable(
  "lexical_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lexicalEntryId: uuid("lexical_entry_id")
      .notNull()
      .references(() => lexicalEntries.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceNote: text("source_note"),
    contentHash: text("content_hash").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lexical_sources_entry_id_idx").on(t.lexicalEntryId),
    uniqueIndex("lexical_sources_manual_idempotency_unique").on(
      t.lexicalEntryId,
      t.sourceType,
      t.contentHash,
    ),
  ],
);
