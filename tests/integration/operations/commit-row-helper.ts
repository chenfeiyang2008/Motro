// 阶段 6 工单 04 复核（P1-4）共享测试助手：构造真实 import_batch_commit_rows 行。
//
// 0029 把 application_operations.target_id 外键到 import_batch_commit_rows(id)，
// 因此所有测试/夹具在创建 operation 前必须先创建真实的 commit row（不得用随机 UUID 绕过）。
// 本助手通过完整 FK 链（stored_files → import_batches → import_rows →
// import_batch_commits → import_batch_commit_rows）构造最小合法 commit row。
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";

/** 生成合法的随机制造 UUID（8-4-4-4-12）。 */
export function freshTarget(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface CreatedCommitRow {
  /** import_batch_commit_rows.id —— 用作 operation.target_id。 */
  commitRowId: string;
  batchId: string;
  commitId: string;
  importRowId: string;
}

/**
 * 构造一个最小合法 commit row（完整 FK 链），返回其 id。
 * 可选 normalizedSpelling（默认随机词）与 lexicalEntryId（默认新建词条）。
 */
export async function createCommitRow(
  pool: Pool,
  opts: { userId: string; normalizedSpelling?: string } = { userId: "" },
): Promise<CreatedCommitRow> {
  const spelling = opts.normalizedSpelling ?? `probe-${freshTarget().slice(0, 8)}`;
  // 1) stored_files
  const fileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO stored_files
         (storage_key, original_filename, declared_mime, sniffed_mime, byte_size, sha256_hex,
          uploaded_by, purpose, format)
       VALUES ($1, $2, 'text/plain', 'text/plain', 4, $3, $4, 'original_import', 'txt')
       RETURNING id`,
      [
        `test://${spelling}`,
        `${spelling}.txt`,
        createHash("sha256").update(spelling).digest("hex"),
        opts.userId,
      ],
    )
  ).rows[0]!.id;
  // 2) import_batches
  const batchId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batches (file_id, uploaded_by, format, source_declaration)
       VALUES ($1, $2, 'txt', $3) RETURNING id`,
      [fileId, opts.userId, `source: ${spelling}`],
    )
  ).rows[0]!.id;
  // 3) import_rows
  const importRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_rows (batch_id, ordinal, mapping_version, raw_summary, normalized_spelling, status)
       VALUES ($1, 1, 1, $2, $2, 'candidate') RETURNING id`,
      [batchId, spelling],
    )
  ).rows[0]!.id;
  // 4) import_batch_commits
  const commitId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commits
         (batch_id, committed_by, mapping_version, semantic_hash, status)
       VALUES ($1, $2, 1, $3, 'completed') RETURNING id`,
      [batchId, opts.userId, createHash("sha256").update(spelling).digest("hex")],
    )
  ).rows[0]!.id;
  // 5) lexical_entries（为 commit row 的 CHECK 满足 created_entry_id 或 associated_entry_id）
  const entryId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
       VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
      [spelling],
    )
  ).rows[0]!.id;
  // 5b) lexical_sources（0021 起 import_batch_commit_rows.lexical_source_id 为 NOT NULL）
  const sourceId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_sources (lexical_entry_id, source_type, content_hash, created_by)
       VALUES ($1, 'import', $2, $3) RETURNING id`,
      [entryId, createHash("sha256").update(spelling).digest("hex"), opts.userId],
    )
  ).rows[0]!.id;
  // 6) import_batch_commit_rows（created_entry_id 满足 CHECK，lexical_source_id 非空，
  //     lexical_entry_id = canonical 词条 = created_entry_id，来源属于同一词条）。
  const commitRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commit_rows
         (commit_id, import_row_id, ordinal, normalized_spelling, created_entry_id, lexical_entry_id, lexical_source_id)
       VALUES ($1, $2, 1, $3, $4, $4, $5) RETURNING id`,
      [commitId, importRowId, spelling, entryId, sourceId],
    )
  ).rows[0]!.id;
  return { commitRowId, batchId, commitId, importRowId };
}
