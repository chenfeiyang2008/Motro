// 阶段 6 工单 03：提交有效行与错误报告的纯领域规则。
//
// 本文件只含无副作用、可确定性单测的纯规则：
//   - 行级可提交判定（eligibility）：批次已校验、非 stale、行状态 candidate、
//     非空规范化拼写、尚未提交；映射/校验身份比较；
//   - 提交结果摘要（created / associated / skipped）的推导；
//   - 错误报告 CSV 的安全转义（RFC 4180 引号/换行）与电子表格公式注入中和；
//   - 服务端生成的报告文件名（不含用户输入路径）。
// 真实数据库事务与幂等 claim 放在 API 层，这里不触网、不读盘。
import { createHash } from "node:crypto";

// ---- 可提交判定 ----

export type RowCommitDisposition = "committable" | "not_eligible";

/**
 * 判断某批次行是否在提交时成为候选（进入提交尝试）。
 * 行必须同时满足：
 *   - 行状态恰为 candidate（新建候选）或 existing_entry（关联既有词条）；
 *   - 有非空规范化拼写；
 *   - 行事实映射版本 == 批次当前映射版本（非 stale）；
 *   - 该行尚未被提交（无不可变提交事实）。
 * invalid / duplicate_in_file / stale / 缺拼写 / 已提交行一律 not_eligible。
 *
 * 返回 committable 仅表示「进入提交尝试」，不保证最终创建：并发下若 candidate 拼写
 * 已被系统创建，调用方必须确定性关联既有词条，绝不能重复创建。
 */
export function isRowCommittable(options: {
  status: string;
  normalizedSpelling: string | null | undefined;
  rowMappingVersion: number;
  batchMappingVersion: number;
  alreadyCommitted: boolean;
}): RowCommitDisposition {
  if (options.alreadyCommitted) return "not_eligible";
  if (options.status !== "candidate" && options.status !== "existing_entry") return "not_eligible";
  const spelling = options.normalizedSpelling?.trim();
  if (!spelling || spelling.length === 0) return "not_eligible";
  if (options.rowMappingVersion !== options.batchMappingVersion) return "not_eligible";
  return "committable";
}

// ---- 提交结果摘要推导 ----

export interface CommitSummaryInputs {
  /** 本轮实际新建的词条数（candidate 行创建）。 */
  createdEntryCount: number;
  /** 本轮关联既有系统词条的数量：既有 existing_entry 行 + candidate 并发竞态关联。 */
  associatedExistingEntryCount: number;
  /** 按 disposition 分组的「跳过」行数：invalid / duplicate_in_file / stale（不含已提交行）。 */
  skippedCountByDisposition: Record<string, number>;
  /** 本轮实际写入提交事实的行数 == created + associated（跳过行不计入）。 */
  committedRowCount: number;
  /** 是否为幂等重放。 */
  isIdempotentReplay: boolean;
}

/**
 * 由逐行提交结果推导出面向管理员的提交摘要。
 * 不变量：committedRowCount == createdEntryCount + associatedExistingEntryCount（非重放时）；
 * 跳过行只计入 skippedCountByDisposition，不进入 committedRowCount。
 * 重放时返回原始结果，不做任何重新计数。
 */
export function buildCommitSummary(inputs: CommitSummaryInputs): {
  createdEntryCount: number;
  associatedExistingEntryCount: number;
  skippedCountByDisposition: Record<string, number>;
  committedRowCount: number;
  isIdempotentReplay: boolean;
} {
  return {
    createdEntryCount: inputs.createdEntryCount,
    associatedExistingEntryCount: inputs.associatedExistingEntryCount,
    skippedCountByDisposition: { ...inputs.skippedCountByDisposition },
    committedRowCount: inputs.committedRowCount,
    isIdempotentReplay: inputs.isIdempotentReplay,
  };
}

// ---- 映射/校验身份比较（幂等语义） ----

/**
 * 提交请求的语义哈希：绑定批次、当前映射版本与校验输入哈希。
 * 同一语义的重放必须产生完全一致的哈希；任何语义差异都会改变哈希，
 * 从而使同 Idempotency-Key 不同语义得到 409（与现有 validate/upload 幂等一致）。
 *
 * 设计要点：哈希只依赖「提交后也不变的稳定事实」——
 *   - batchId 唯一标识批次；
 *   - mappingVersion 唯一确定该批的校验行快照（同批同版本必同文件）；
 *   - validationInputSha256 是校验输入的不可变冻结哈希（尽力而为的身份绑定）。
 * 绝不含可提交行的 ID 集合：提交后这些行不再可提交，若纳入哈希会使幂等重放
 * 重算出不同哈希而误报 409。
 */
export function commitSemanticHash(options: {
  batchId: string;
  mappingVersion: number;
  validationInputSha256: string;
}): string {
  const canonical = JSON.stringify([
    "import:commit",
    options.batchId,
    options.mappingVersion,
    options.validationInputSha256,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---- 错误报告 CSV 安全 ----

const CSV_FORMULA_PREFIXES = ["=", "+", "-", "@"];

/**
 * 中和电子表格公式注入：值以 `=`、`+`、`-` 或 `@` 开头时，前置 `'`（单引号），
 * 使 Excel/Google Sheets 将其视为文本而非公式。仅对危险前缀做中和，
 * 其余字符原样保留（避免破坏用户数据的可读性）。
 */
export function neutralizeCsvFormula(value: string): string {
  const first = value.trimStart()[0];
  if (first !== undefined && CSV_FORMULA_PREFIXES.includes(first)) {
    return `'${value}`;
  }
  return value;
}

/**
 * RFC 4180 安全转义：字段含逗号、双引号、CR 或 LF 时用双引号包裹，
 * 字段内的双引号翻倍。空字段保持为空。
 */
export function escapeCsvField(value: string): string {
  if (value === "") return value;
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 单条错误报告记录 → 安全 CSV 行（无表头）。
 * 每个字段依次：ordinal / rawSummary / status / errorCodes / duplicateOfOrdinal / mappingVersion。
 *
 * 安全顺序：先中和公式前缀（避免被 CSV 引号「藏进」字段内部，Excel 仍视为公式），
 * 再按 RFC 4180 转义（引号/逗号/换行）。
 */
export function errorReportCsvLine(input: {
  ordinal: number;
  rawSummary: string;
  status: string;
  errorCodes: string[];
  duplicateOfOrdinal: number | null;
  mappingVersion: number;
}): string {
  const safe = (v: string) => escapeCsvField(neutralizeCsvFormula(v));
  const fields = [
    String(input.ordinal),
    safe(input.rawSummary),
    safe(input.status),
    safe(input.errorCodes.join("|")),
    input.duplicateOfOrdinal === null ? "" : String(input.duplicateOfOrdinal),
    String(input.mappingVersion),
  ];
  return fields.join(",");
}

/** 错误报告 CSV 表头。 */
export const ERROR_REPORT_CSV_HEADER =
  "ordinal,rawSummary,status,errorCodes,duplicateOfOrdinal,mappingVersion";

/** CSV 行必须为 LF 分隔（Excel 兼容；字段内已转义 CR）。 */
export const ERROR_REPORT_CSV_LINE_SEPARATOR = "\n";

// ---- 安全报告文件名 ----

/**
 * 服务端生成的安全报告文件名：只含字母数字与连字符，绝不使用用户输入的原文件名
 * 或任何路径。时间由调用方传入（避免本模块依赖时钟）。
 */
export function safeReportFilename(batchId: string, stamp: string): string {
  const cleanId = batchId.replace(/[^a-zA-Z0-9-]/g, "");
  const cleanStamp = stamp.replace(/[^a-zA-Z0-9-]/g, "");
  return `motro-import-error-report-${cleanId}-${cleanStamp}.csv`;
}
