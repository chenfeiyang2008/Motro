// 导入文件与批次 schema（阶段 6 工单 01 + 工单 02）。
// 与 db/migrations/0016_import_files_and_batches.sql、0017_import_file_dedupe_and_constraints.sql、
// 0018_import_rows_parse_validate.sql 保持一致。
// storage_key 是不透明服务端存储键；original_filename 仅作元数据展示，绝不参与路径构造。
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./platform-identity.js";
import { lexicalEntries } from "./lexicon.js";

export const storedFiles = pgTable(
  "stored_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    declaredMime: text("declared_mime").notNull(),
    sniffedMime: text("sniffed_mime").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256Hex: text("sha256_hex").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    status: text("status").notNull().default("stored"),
    format: text("format").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stored_files_uploaded_by_idx").on(t.uploadedBy),
    index("stored_files_created_at_idx").on(t.createdAt),
    uniqueIndex("stored_files_storage_key_unique").on(t.storageKey),
    // 0017：同上传人 + 同内容去重（不再全局 sha 唯一，避免不同管理员同原件误拒）。
    uniqueIndex("stored_files_uploader_sha256_unique").on(t.uploadedBy, t.sha256Hex),
  ],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => storedFiles.id, { onDelete: "restrict" }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    format: text("format").notNull(),
    sourceDeclaration: text("source_declaration").notNull(),
    status: text("status").notNull().default("uploaded"),
    version: integer("version").notNull().default(1),
    // 0018：映射/校验扩展字段。
    mappingVersion: integer("mapping_version").notNull().default(1),
    currentMapping: jsonb("current_mapping"),
    selectedSheet: text("selected_sheet"),
    validationStatus: text("validation_status").notNull().default("not_validated"),
    validationSummary: jsonb("validation_summary"),
    validationInputSha256: text("validation_input_sha256"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("import_batches_uploaded_by_idx").on(t.uploadedBy),
    index("import_batches_status_idx").on(t.status),
    index("import_batches_created_at_idx").on(t.createdAt),
    uniqueIndex("import_batches_file_id_unique").on(t.fileId),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    mappingVersion: integer("mapping_version").notNull(),
    rawSummary: text("raw_summary").notNull(),
    normalizedSpelling: text("normalized_spelling"),
    status: text("status").notNull(),
    errors: jsonb("errors").notNull().default([]),
    duplicateOfOrdinal: integer("duplicate_of_ordinal"),
    lexicalEntryId: uuid("lexical_entry_id").references(() => lexicalEntries.id, {
      onDelete: "set null",
    }),
    enrichmentDraftId: uuid("enrichment_draft_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 0019：同一 (batch, mapping_version) 内一行一个 ordinal；历史版本可并存。
    uniqueIndex("import_rows_batch_mv_ordinal_unique").on(t.batchId, t.mappingVersion, t.ordinal),
    index("import_rows_batch_id_idx").on(t.batchId),
    index("import_rows_batch_status_idx").on(t.batchId, t.status),
    index("import_rows_created_at_idx").on(t.createdAt),
    index("import_rows_mapping_version_idx").on(t.batchId, t.mappingVersion),
  ],
);
