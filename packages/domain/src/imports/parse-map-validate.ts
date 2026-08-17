// 四格式解析、映射验证与逐行校验的纯领域规则（阶段 6 工单 02）。
//
// 本文件只含无副作用、可确定性单测的纯规则：格式映射规则、JSON 允许形状、
// 行诊断（文件内重复/系统已有词条/非法拼写/超限/空值）、映射 schema 校验、
// 安全摘要与 stale 判定。真实文件读取与词典查询放在 API 层，这里不触网、不读盘。
//
// 设计要点：
//   - 复用词条拼写规则（normalizeSpelling / validateCanonicalSpelling），不实现第二套
//     规范化；非法英语拼写即复用其错误消息。
//   - 原始行值绝不直接写入错误消息；一律用安全摘要（受长度限制）。
//   - 文件内重复给出可定位 disposition（重复的行 ordinal）。
//   - 系统已有词条是显式可见 disposition，不静默成功、不创建词条（本票不创建）。
import { validateCanonicalSpelling } from "../lexicon/spelling.js";

// ---- 格式映射规则 ----

/**
 * 哪些格式需要管理员确认英文拼写字段。
 * TXT 固定「一行一个词」，无需映射；CSV/XLSX/JSON 需映射。
 */
export function formatRequiresMapping(format: string): boolean {
  return format !== "txt";
}

export const MAPPABLE_FORMATS = new Set(["csv", "xlsx", "json"]);

/** 该格式是否需要工作表选择。只有 XLSX 需要。 */
export function formatRequiresSheet(format: string): boolean {
  return format === "xlsx";
}

// ---- 安全摘要 ----

/**
 * 原始输入值的脱敏/安全摘要：受长度限制、压缩空白、可安全用于表格展示与审计。
 * 绝不把超过上限的整段原始值直接用于错误消息。
 */
export function safeValueSummary(value: string, maxSummaryLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length <= maxSummaryLength) return collapsed;
  return `${collapsed.slice(0, maxSummaryLength - 1)}…`;
}

// ---- JSON 形状规则 ----

/** 检测某个值是否为对象数组（第二条允许形状）中的对象元素。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验 JSON 顶层形状是否符合两种允许形状：
 *   1. 字符串数组：["abandon", "ability"]
 *   2. 对象数组：[{ word, note? }, ...]，统一为 `note` 字段。
 *
 * 规则（按工单）：
 *   - 顶层只能是数组；顶层对象 / 嵌套对象 / 深层数组 / null 行 / 混合类型一律拒绝。
 *   - 对象数组只接受元素键白名单（word/note），元素键必须是字符串、不嵌套对象。
 *   - 返回可选的发现字段（供映射确认），以及提取的原始字符串项。
 */
export type JsonShapeOutcome =
  | { ok: true; kind: "string-array"; discoveredFields: string[] }
  | { ok: true; kind: "object-array"; discoveredFields: string[] }
  | { ok: false; error: string };

const JSON_OBJECT_FIELD_SET = new Set(["word", "note"]);

/**
 * 校验解析后的 JSON 值形状。`parsed` 必须已是 JSON.parse 的结果数组。
 * `rowLimit` 限制数组长度；嵌套深度在解析前用 jsonDepthWithinLimit 单独校验。
 */
export function validateJsonDocument(parsed: unknown, rowLimit: number): JsonShapeOutcome {
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "JSON 顶层必须是数组" };
  }
  if (parsed.length > rowLimit) {
    return { ok: false, error: `JSON 行数超过上限 ${rowLimit}` };
  }

  const item = parsed[0];
  const isStringArray = typeof item === "string";
  const isObjectArray = isRecord(item);

  if (isStringArray) {
    for (const entry of parsed) {
      if (typeof entry !== "string") {
        return { ok: false, error: "JSON 字符串数组只允许字符串元素，不允许混合类型" };
      }
    }
    return { ok: true, kind: "string-array", discoveredFields: [] };
  }

  if (isObjectArray) {
    // 只允许 word/note 两个键，且值必须是字符串；不允许嵌套对象/数组/null。
    const discovered = new Set<string>();
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        return { ok: false, error: "JSON 对象数组不允许混合字符串与对象，也不允许 null/数组元素" };
      }
      for (const key of Object.keys(entry)) {
        if (!JSON_OBJECT_FIELD_SET.has(key)) {
          return { ok: false, error: `JSON 对象数组包含不支持的字段：${key}` };
        }
        const value = entry[key];
        if (typeof value !== "string") {
          return { ok: false, error: `JSON 对象数组字段 ${key} 必须是字符串` };
        }
        discovered.add(key);
      }
    }
    return { ok: true, kind: "object-array", discoveredFields: [...discovered] };
  }

  return { ok: false, error: "JSON 顶层数组元素必须是字符串或包含 word 字段的对象" };
}

/**
 * 计算解析后 JSON 树的最大嵌套深度（数组/对象层数），用于执行 IMPORT_MAX_JSON_DEPTH。
 * 深度 > maxDepth 时返回 false。纯函数，遍历树但不分配拷贝。
 */
export function jsonDepthWithinLimit(value: unknown, maxDepth: number): boolean {
  if (maxDepth < 1) return false;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > maxDepth) return false;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (typeof node === "object" && node !== null) {
      for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}

// ---- 表头 / 字段去重与稳定标识 ----

/**
 * 从 CSV/XLSX 表头行生成稳定的、不歧义的字段标识列表。
 * 重名列必须获得可区分的后缀（如 `name`、`name (2)`），不能只靠显示名称。
 * 返回与输入列一一对应的字段标识数组。
 */
export function stableFieldIdentifiers(headers: (string | null | undefined)[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, idx) => {
    const base = (h ?? "").toString().trim();
    const display = base.length > 0 ? base : `(第 ${idx + 1} 列)`;
    const count = seen.get(display) ?? 0;
    seen.set(display, count + 1);
    return count === 0 ? display : `${display} (${count + 1})`;
  });
}

/** 去掉行首 BOM (U+FEFF)。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---- 行诊断 / 校验 ----

export type ImportRowIssue =
  | "empty"
  | "invalid_spelling"
  | "unparsable"
  | "over_field_limit"
  | "over_row_limit"
  | "ambiguous_entry";

/**
 * 逐行诊断的核心纯规则：给定规范化拼写与上下文，返回该行的最终判定。
 * 复用 validateCanonicalSpelling 判定非法英语拼写。
 */
export type RowDisposition = "candidate" | "duplicate_in_file" | "existing_entry" | "invalid";

/**
 * 对单条拼写做拼写级校验（空值/非法拼写），返回错误码列表。
 * 不读词条库、不判定文件内重复。
 */
export function classifySpellingIssues(rawValue: string, maxCellLength: number): ImportRowIssue[] {
  const treated = rawValue.trim();
  if (treated.length === 0) return ["empty"];
  if (treated.length > maxCellLength) return ["over_field_limit"];
  const spellingErrors = validateCanonicalSpelling(treated);
  if (spellingErrors.length > 0) return ["invalid_spelling"];
  return [];
}

/**
 * 计算某行的最终状态判定。
 * 优先级：invalid（拼写/超限/空）> duplicate_in_file > existing_entry > candidate。
 * duplicateOfOrdinal 与 matchingEntryId 仅在其对应 disposition 下提供。
 */
export function resolveRowDisposition(options: {
  issues: ImportRowIssue[];
  duplicateOfOrdinal?: number;
  matchingEntryId?: string;
}): RowDisposition {
  if (options.issues.includes("invalid_spelling") || options.issues.includes("empty")) {
    return "invalid";
  }
  if (options.issues.includes("over_field_limit") || options.issues.includes("over_row_limit")) {
    return "invalid";
  }
  // 歧义：同一 normalized_spelling 存在多个 active 词条 → fail closed（决不做任意选取）。
  if (options.issues.includes("ambiguous_entry")) return "invalid";
  if (options.duplicateOfOrdinal !== undefined) return "duplicate_in_file";
  if (options.matchingEntryId !== undefined) return "existing_entry";
  return "candidate";
}

// ---- 映射 schema 校验 ----

export interface ImportMapping {
  /** 英文拼写来源字段标识。TXT 固定为 undefined（无需映射）。 */
  spellingField?: string;
  /** XLSX 选择的工作表标识。 */
  sheet?: string;
}

/**
 * 校验管理员提交的映射是否对给定格式合法。
 * - txt：禁止提供 spellingField/sheet。
 * - csv/json：必须提供 spellingField，禁止 sheet。
 * - xlsx：必须同时提供 sheet 与 spellingField。
 * 返回字符串错误码列表（供结构化 422）。
 */
export function validateFormatMapping(
  format: string,
  mapping: ImportMapping,
): { code: string; message: string }[] {
  const errors: { code: string; message: string }[] = [];
  if (format === "txt") {
    if (mapping.spellingField !== undefined)
      errors.push({ code: "mapping_not_allowed", message: "TXT 不需要字段映射" });
    if (mapping.sheet !== undefined)
      errors.push({ code: "mapping_not_allowed", message: "TXT 不支持工作表选择" });
    return errors;
  }
  if (format === "xlsx") {
    if (!mapping.sheet) errors.push({ code: "sheet_required", message: "XLSX 必须选择工作表" });
    if (!mapping.spellingField)
      errors.push({ code: "spelling_field_required", message: "必须选择英文拼写字段" });
    return errors;
  }
  // csv / json
  if (mapping.sheet !== undefined)
    errors.push({ code: "mapping_not_allowed", message: `${format} 不支持工作表选择` });
  if (!mapping.spellingField)
    errors.push({ code: "spelling_field_required", message: "必须选择英文拼写字段" });
  return errors;
}

// ---- stale / 映射版本判定 ----

/**
 * 判断某批次的校验结果是否仍「有效」。
 * 说明：本函数是纯规则；真实状态来源是批次当前 mappingVersion 与行事实的最大
 * mappingVersion 的比较，由 API 层读取后调用本函数归类。
 */
export type StaleCategory = "current" | "stale";

export function classifyStale(rowVersion: number, batchVersion: number): StaleCategory {
  return rowVersion === batchVersion ? "current" : "stale";
}

/** 幂等的相同映射是否不应递增版本：比较结构相等。 */
export function mappingEquals(a: ImportMapping | undefined, b: ImportMapping | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.sheet === b.sheet && (a.spellingField ?? null) === (b.spellingField ?? null);
}
