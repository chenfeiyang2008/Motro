// 阶段 6 工单 05：Wiktionary source fact schema（内网、零网络、append-only 事实）。
// 与 db/migrations/0031_wiktionary_source_facts.sql 保持一致。
//
// 本表是「内网零网络 foundation」的物理承载：一次抓取（同 page + revision + parser）
// 形成一条不可变事实。绝不保存 raw wikitext / provider payload / 例句 / 引用 /
// 图片 / 音频 / HTML。
//
// operation target 仍是真实 import_batch_commit_row（0031 通过可选外键关联到
// import_batch_commit_rows，不新增 wiktionary_source_fact operation target，也不扩展
// 0028 白名单）。page/revision identity 通过 source_fact_identity 与 input hash/version
// 表达，不引入新的 target_type。
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { importBatchCommitRows } from "./imports.js";

export const wiktionarySourceFacts = pgTable(
  "wiktionary_source_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 业务幂等身份：同 page + revision + parser version 只产生一条。
    sourceFactIdentity: text("source_fact_identity").notNull(),
    // page/revision/cluster 身份派生来源（各自唯一）。
    pageIdentityHash: text("page_identity_hash").notNull(),
    revisionIdentityHash: text("revision_identity_hash").notNull(),
    pageId: text("page_id").notNull(),
    revisionId: text("revision_id").notNull(),
    revisionTimestamp: timestamp("revision_timestamp", { withTimezone: true }),
    canonicalTitle: text("canonical_title").notNull(),
    normalizedSpelling: text("normalized_spelling").notNull(),
    language: text("language").notNull(),
    partOfSpeech: text("part_of_speech"),
    definitionExcerpt: text("definition_excerpt").notNull(),
    // content_hash 语义由数据库 CHECK 权威裁决（与 0031 完全一致）：
    //   - fetched      → content_hash 非空且 64 位小写 hex；
    //   - 其它状态     → content_hash 必须为 NULL。
    // 因此本列【可空】。不得改成 notNull() 掩盖状态语义。
    contentHash: text("content_hash"),
    sourceUrl: text("source_url").notNull(),
    licenseName: text("license_name"),
    licenseVersion: text("license_version"),
    licenseUrl: text("license_url"),
    attribution: text("attribution"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    parserVersion: text("parser_version").notNull(),
    status: text("status").notNull().default("pending"), // pending/fetched/ambiguous/error/superseded
    ambiguityNote: text("ambiguity_note"),
    // 歧义候选（D5）：仅 ambiguous 状态携带结构化候选数组，其它状态必须为空（0031 CHECK）。
    ambiguityCandidates: jsonb("ambiguity_candidates"),
    // 业务关联：可选地绑定到真实 import commit row（不伪造 target，不新增 target_type）。
    commitRowId: uuid("commit_row_id").references(() => importBatchCommitRows.id, {
      onDelete: "restrict",
    }),
    inputVersionUsed: integer("input_version_used"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 同 page + revision + parser 只产生一条事实（幂等重放 no-op）。
    uniqueIndex("wiktionary_source_facts_identity_unique").on(t.sourceFactIdentity),
    index("wiktionary_source_facts_page_revision_idx").on(
      t.pageIdentityHash,
      t.revisionIdentityHash,
    ),
    index("wiktionary_source_facts_content_hash_idx").on(t.contentHash),
    index("wiktionary_source_facts_commit_row_idx")
      .on(t.commitRowId)
      .where(sql`${t.commitRowId} IS NOT NULL`),
    index("wiktionary_source_facts_status_idx").on(t.status),
    index("wiktionary_source_facts_created_at_idx").on(t.createdAt),
  ],
);
