// 导入文件纯规则（阶段 6 工单 01）：无副作用、可确定性单测。
//
// 安全要点：
//   - 原文件名只作元数据，绝不参与真实路径构造 → rejectPathTraversal。
//   - 允许格式由配置声明（IMPORT_ALLOWED_FORMATS）；扩展名不区分大小写。
//   - 字节上限由配置声明；空文件拒绝。
//   - storage_key 必须是服务端生成、不可由客户端猜测的值；用随机字节 → base64url。
//   - SHA-256 由服务端流式计算（见 API 层）；这里只校验其规范形状（64 位十六进制）。
import { randomBytes } from "node:crypto";

/** 支持/拒绝的 MIME 类型：与允许格式对应（开发默认不信任浏览器声明）。 */
export const FORMAT_MIME: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const IMPORT_FORMATS = Object.keys(FORMAT_MIME);

/** 客户端可声明的格式（工单 02：含 xlsx）。 */
export const UPLOADABLE_FORMATS = ["txt", "csv", "json", "xlsx"] as const;
export type UploadableFormat = (typeof UPLOADABLE_FORMATS)[number];

export interface ImportFormatCheck {
  ok: boolean;
  format?: string;
  error?: string;
}

/** 从原文件名解析扩展名（小写、无点）。`undefined` 表示无扩展名。 */
export function extensionOf(filename: string): string | undefined {
  const base = filename.trim();
  if (base.length === 0) return undefined;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 校验原文件名：必须非空、不含路径分隔符 / 反斜杠 / 控制字符 / 前导点，
 * 且扩展名在允许格式内（默认允许 txt/csv/json）。不区分大小写。
 */
export function validateImportFilename(
  filename: string,
  allowedFormats: readonly string[] = UPLOADABLE_FORMATS,
): ImportFormatCheck {
  const trimmed = filename.trim();
  if (trimmed.length === 0) return { ok: false, error: "文件名不能为空" };
  if (trimmed.length > 255) return { ok: false, error: "文件名过长" };
  const hasControl = Array.from(trimmed).some(
    (c) => c.codePointAt(0) !== undefined && (c.codePointAt(0)! < 32 || c.codePointAt(0)! === 127),
  );
  if (hasControl) return { ok: false, error: "文件名包含不可见控制字符" };
  // 拒绝路径穿越：任何斜杠/反斜杠都不允许；NUL 等控制字符已由上方 hasControl 拒绝。
  if (/[/\\]/.test(trimmed)) return { ok: false, error: "文件名不能包含路径分隔符" };
  if (trimmed.startsWith(".")) return { ok: false, error: "文件名不能以点开头" };
  const ext = extensionOf(trimmed);
  if (ext === undefined) return { ok: false, error: "文件名缺少扩展名" };
  const allowed = allowedFormats.map((f) => f.toLowerCase());
  if (!allowed.includes(ext)) {
    return { ok: false, error: `不支持的文件格式：${ext}` };
  }
  return { ok: true, format: ext };
}

/** 字节大小规则：必须为正且不超过上限。 */
export function validateImportSize(byteSize: number, maxBytes: number): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) errors.push("文件不能为空");
  if (byteSize > maxBytes) errors.push(`文件不能超过 ${maxBytes} 字节`);
  return errors;
}

/**
 * 生成服务端存储键：不透明、不可由客户端推断、不含路径分隔符。
 * 形如 `<purpose>-<random-base64url>`；purpose 只能来自允许枚举。
 */
export function generateStorageKey(purpose: string): string {
  const safePurpose =
    purpose
      .trim()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 32) || "file";
  const random = randomBytes(18).toString("base64url");
  return `${safePurpose}-${random}`;
}

/** 校验存储键形状：仅 base64url 字符集（大小写字母/数字/连字符/下划线），无路径分隔符。 */
export function validateStorageKey(key: string): string[] {
  const errors: string[] = [];
  if (key.length === 0 || key.length > 128) errors.push("存储键长度非法");
  // generateStorageKey 用 randomBytes().base64url 生成，含大写字母 _ 与 -。
  if (!/^[A-Za-z0-9_-]+$/.test(key)) errors.push("存储键包含非法字符");
  if (/[/\\]/.test(key)) errors.push("存储键不能包含路径分隔符");
  return errors;
}

/** 校验 SHA-256 十六进制形状：恰好 64 位小写十六进制。 */
export function validateSha256Hex(hex: string): string[] {
  return /^[0-9a-f]{64}$/.test(hex) ? [] : ["SHA-256 必须是 64 位小写十六进制"];
}

/** 由嗅探 MIME 推断允许格式（若可推断）；null 表示无法推断。 */
export function formatFromSniffedMime(sniffedMime: string): string | undefined {
  const mime = sniffedMime.toLowerCase().trim();
  for (const [fmt, expected] of Object.entries(FORMAT_MIME)) {
    if (mime === expected) return fmt;
  }
  // 纯文本回退：text/* 家族按 text/plain 处理（仅用于展示，不用于路径/权限）。
  if (mime.startsWith("text/")) return "txt";
  return undefined;
}

/**
 * 基于内容的格式类别嗅探（绝不信任 multipart 的 mimetype）。
 *
 * 内容类别而不是精确格式：普通 UTF-8 文本无法在实践中与 CSV 可靠区分——
 * 既可以是合法 TXT，也可以是合法 CSV。因此：
 *   - `utf8`: 字节构成合法 UTF-8 文本（可被 TXT 或 CSV 接受）。
 *   - `json`: 首非空白字符为 { 或 [ 且整体可解析为 JSON（只能由 JSON 扩展名/MIME 接受）。
 *   - `xlsx`: ZIP 归档（PK\x03\x04 魔数）；工单 02 用于合法 XLSX（拒绝非 ZIP 的二进制文件）。
 *   - `binary`: 不是合法 UTF-8 也不是 ZIP 归档（拒绝）。
 */
export type ContentClass = "utf8" | "json" | "xlsx";

export interface SniffResult {
  /** 内容类别：utf8（TXT/CSV 均可）或 json。 */
  content: ContentClass;
  /** 与内容类别对应的最合适 MIME。 */
  sniffedMime: string;
}

export type SniffOutcome = { ok: true; result: SniffResult } | { ok: false; error: string };

export function sniffFileContent(content: Buffer): SniffOutcome {
  if (content.length === 0) return { ok: false, error: "文件为空" };
  // XLSX 归档（PK\x03\x04 ZIP 魔数）：由工单 02 解析器独立验证 OOXML 结构。
  if (
    content.length >= 4 &&
    content[0] === 0x50 &&
    content[1] === 0x4b &&
    content[2] === 0x03 &&
    content[3] === 0x04
  ) {
    return { ok: true, result: { content: "xlsx", sniffedMime: FORMAT_MIME.xlsx! } };
  }
  // 合法 UTF-8：round-trip 后字节一致，否则是二进制/非 UTF-8。
  const decoded = content.toString("utf8");
  const roundTrip = Buffer.from(decoded, "utf8");
  if (!roundTrip.equals(content))
    return { ok: false, error: "文件不是有效的 UTF-8 文本或 ZIP 归档" };
  const first = decoded.trimStart().charAt(0);
  if (first === "{" || first === "[") {
    try {
      JSON.parse(decoded);
    } catch {
      return { ok: false, error: "声明 JSON 但内容不是有效 JSON" };
    }
    return { ok: true, result: { content: "json", sniffedMime: FORMAT_MIME.json! } };
  }
  return { ok: true, result: { content: "utf8", sniffedMime: FORMAT_MIME.txt! } };
}

/**
 * 内容的嗅探类别是否与文件扩展名声明的格式兼容。
 * - json 内容只允许 .json；utf8 内容允许 .txt 或 .csv（无法只靠内容区分两者）。
 * - xlsx 内容允许 .xlsx。
 */
export function contentClassAllowedForExtension(
  content: ContentClass,
  declaredFormat: string,
): boolean {
  const fmt = declaredFormat.toLowerCase();
  if (fmt === "json") return content === "json";
  if (fmt === "txt" || fmt === "csv") return content === "utf8";
  if (fmt === "xlsx") return content === "xlsx";
  return false;
}

/**
 * 声明的 MIME 与嗅探结果是否一致（严格白名单）：
 * 只允许 text/plain、text/csv、application/json、
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet。
 * - text/plain 与 text/csv 与 utf8 内容一致；
 * - application/json 仅与 json 内容一致；
 * - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet 仅与 xlsx 内容一致；
 * - text/html、text/javascript、image/*、application/pdf、application/octet-stream 等一律拒绝。
 */
export function declaredMimeConsistent(declaredMime: string, sniffedMime: string): boolean {
  const decl = normalizeMediaType(declaredMime);
  if (!decl) return false;
  const sniff = sniffedMime.toLowerCase().trim();
  if (decl === "text/plain" || decl === "text/csv") {
    return sniff === FORMAT_MIME.txt || sniff === FORMAT_MIME.csv;
  }
  if (decl === "application/json") return sniff === FORMAT_MIME.json;
  if (decl === FORMAT_MIME.xlsx) return sniff === FORMAT_MIME.xlsx;
  return false;
}

/**
 * 规范化 media type：
 * - 转小写；
 * - trim；
 * - 去除 `; charset=...` 等参数（只保留 type/subtype）。
 * 返回 undefined 表示空/无法解析。
 */
export function normalizeMediaType(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withoutParams = trimmed.split(";")[0]?.trim().toLowerCase();
  if (!withoutParams) return undefined;
  return withoutParams;
}

/** 严格允许的 media type 白名单。 */
export const ALLOWED_MEDIA_TYPES = [
  "text/plain",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** 判断某个 raw Content-Type 是否落在严格白名单内（先规范化再比对）。 */
export function isAllowedMediaType(raw: string): boolean {
  const normalized = normalizeMediaType(raw);
  if (!normalized) return false;
  return (ALLOWED_MEDIA_TYPES as readonly string[]).includes(normalized);
}
