// 阶段 6 工单 06：Enrichment draft schema（内网、零网络、DeepSeek Fake-only foundation）。
// 与 db/migrations/0033_enrichment_drafts.sql 保持一致。
//
// enrichment_drafts 是「已保存英文来源事实 → 受控 DeepSeek 请求 → 简体中文候选」的
// 不可变审计事实。模型输出绝不是事实/最终词条/课程内容/学习内容；只有经 Ticket 07
// 人工审核接受后才可能进入学习者范围。
//
// 绝不保存完整 prompt、原始 provider response、secret、路径。只保存脱敏后的 hash、
// 模型身份（configured alias 与实际 resolved、fingerprint）、状态与受控结果字段。
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
import { lexicalEntries } from "./lexicon.js";
import { applicationOperations } from "./operations.js";

export const enrichmentDrafts = pgTable(
  "enrichment_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importBatchCommitRowId: uuid("import_batch_commit_row_id")
      .notNull()
      .references(() => importBatchCommitRows.id, { onDelete: "restrict" }),
    lexicalEntryId: uuid("lexical_entry_id")
      .notNull()
      .references(() => lexicalEntries.id, { onDelete: "restrict" }),
    // Ticket 05 accepted source fact identity（64 位小写 hex）。
    wiktionarySourceFactId: text("wiktionary_source_fact_id").notNull(),
    // 可空：05 阶段先无 DeepSeek op；一个 operation 至多一个 draft 意图（部分唯一索引）。
    operationId: uuid("operation_id").references(() => applicationOperations.id, {
      onDelete: "restrict",
    }),
    provider: text("provider").notNull().default("deepseek"),
    // 部署配置中的滚动别名（如 deepseek-v4-flash）；≠ 实际已解析版本。
    configuredModelAlias: text("configured_model_alias").notNull(),
    // 仅保存 provider 响应明确返回的实际模型标识；不足为空（MD-15）。
    resolvedProviderModel: text("resolved_provider_model"),
    // 来自响应 system_fingerprint（单独字段；不是模型版本）。
    providerFingerprint: text("provider_fingerprint"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    inputHash: text("input_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    responseHash: text("response_hash"),
    draftSchemaVersion: integer("draft_schema_version").notNull().default(1),
    status: text("status").notNull().default("drafting"),
    simplifiedChineseMeaning: text("simplified_chinese_meaning"),
    learningHint: text("learning_hint"),
    validationMetadata: jsonb("validation_metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    safeErrorSummary: text("safe_error_summary"),
  },
  (t) => [
    // 同一输入不重复草稿：同 commit row + provider + model alias + template + input_hash。
    uniqueIndex("enrichment_drafts_input_unique").on(
      t.importBatchCommitRowId,
      t.provider,
      t.configuredModelAlias,
      t.promptTemplateVersion,
      t.inputHash,
    ),
    // 一个 operation 至多产出一个草稿意图（部分唯一索引：仅非空 operation_id 互斥）。
    uniqueIndex("enrichment_drafts_operation_unique")
      .on(t.operationId)
      .where(sql`${t.operationId} IS NOT NULL`),
    index("enrichment_drafts_lexical_status_idx").on(t.lexicalEntryId, t.status),
    index("enrichment_drafts_commit_row_idx").on(t.importBatchCommitRowId),
    index("enrichment_drafts_status_created_idx").on(t.status, t.createdAt),
  ],
);
