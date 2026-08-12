// 四格式解析器（阶段 6 工单 02，服务端只读已保存原件）。
//
// 安全边界（按工单）：
//   - 解析对象永远来自服务端存储路径（stored_files.storage_key）；绝不接受浏览器
//     重新上传的内容来"校验"。
//   - 所有输入受配置约束：字节上限（01 上传时已限）、行数上限、单元格长度上限、
//     JSON 嵌套深度、XLSX 工作表数/有效单元格数。
//   - 公式、宏、外部链接、嵌入对象一律不执行：CSV 只是文本；JSON 只取字符串；
//     XLSX 用只读值解析（不评估公式），并拒绝旧版二进制/宏变体。
//   - ZIP bomb、损坏 XLSX、无法解码文本、行数超限 → 明确、可读、脱敏错误。
//   - 磁盘路径只用于服务端读取，绝不写入任何 API 响应。
//
// 数据流（一次读取、两阶段）：
//   - parse(storageKey)：读取已保存原件，返回发现结构（工作表 + 可用字段），
//     供管理端确认映射。
//   - extractRows(storageKey, format, mapping)：按管理员确认的 sheet + spellingField
//     重新读取同一份原件，返回逐行原始拼写候选。
import { Inject, Injectable } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as csvParse } from "csv-parse/sync";
import readXlsxFile from "read-excel-file/node";
import type { Pool } from "pg";
import { POOL } from "../../../auth/database.provider.js";
import type { AppConfig } from "@motro/config";
import { APP_CONFIG } from "./tokens.js";
import {
  stableFieldIdentifiers,
  stripBom,
  validateJsonDocument,
  jsonDepthWithinLimit,
  type ImportMapping,
  type ImportRowIssue,
  classifySpellingIssues,
} from "@motro/domain";

/** 解析过程中发现的、供管理员确认映射的表单结构。 */
export interface DiscoveredOption {
  /** 稳定、不歧义的字段标识（管理端保存到映射的 spellingField）。 */
  fieldId: string;
  /** 展示名。 */
  label: string;
}

/** 定义某工作表下可用字段提取所需的元数据。 */
export interface SheetFieldSet {
  /** 工作表内所有字段的稳定标识（与 headerIds 索引对应）。 */
  fieldIds: string[];
  /** 表头展示名。 */
  labels: string[];
}

/** parse() 返回的发现结构。 */
export interface ParsedDocument {
  /** 可选工作表（XLSX；其他格式为空）。 */
  sheets: DiscoveredOption[];
  /** 可选字段（CSV/JSON 对象数组/XLSX 第一张表）。TXT 与 JSON 字符串数组为空。 */
  fields: DiscoveredOption[];
  /** XLSX 各工作表各自的字段集（供按工作表确认字段）。 */
  sheetFields?: Record<string, SheetFieldSet>;
}

export interface ExtractResult {
  rows: { rawSpelling: string }[];
  rowIssues: ImportRowIssue[][];
  ignoredBlankCount: number;
}

/** 解析器返回的结构化、可读、脱敏错误。code 供接口映射为 OpenAPI 可生成的错误。 */
export class ImportParseError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_CSV"
      | "INVALID_JSON"
      | "INVALID_XLSX"
      | "XLS_NOT_SUPPORTED"
      | "FILE_NOT_SUPPORTED"
      | "INVALID_ZIP"
      | "TOO_MANY_ROWS"
      | "TOO_MANY_CELLS"
      | "TOO_MANY_SHEETS"
      | "CELL_TOO_LONG"
      | "JSON_TOO_DEEP"
      | "UNDECODABLE_TEXT"
      | "FORMULA_BLOCKED"
      | "ZIP_TOO_MANY_ENTRIES"
      | "ZIP_TOO_LARGE_UNCOMPRESSED"
      | "ZIP_EXPANSION_TOO_HIGH"
      | "ZIP_MALFORMED"
      | "XLSX_MACRO_BLOCKED"
      | "XLSX_STRUCTURE_INVALID",
    public readonly details?: string[],
  ) {
    super(message);
    this.name = "ImportParseError";
  }
}

@Injectable()
export class ImportParser {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // 保留 POOL token 以与模块装配的 DI 一致性对齐；本解析器自身不直接使用连接。
    void this.pool;
  }

  /** 解析已保存原件并返回发现结构（工作表/字段），供管理端确认映射。 */
  async parse(storageKey: string, format: string): Promise<ParsedDocument> {
    const buffer = this.readStored(storageKey);
    if (format === "txt" || format === "csv" || format === "json") {
      return this.parseDiscoveryText(buffer, format);
    }
    if (format === "xlsx") {
      return this.parseDiscoveryXlsx(buffer);
    }
    throw new ImportParseError(`不支持的格式：${format}`, "FILE_NOT_SUPPORTED");
  }

  /** 按映射从已保存原件提取逐行原始拼写候选。 */
  async extractRows(
    storageKey: string,
    format: string,
    mapping: ImportMapping,
  ): Promise<ExtractResult> {
    const buffer = this.readStored(storageKey);

    if (format === "txt") {
      const { lines, blankCount } = this.parseTxtLines(buffer);
      return this.toExtractResult(
        lines.map((s) => ({ rawSpelling: s })),
        blankCount,
      );
    }

    if (format === "csv") {
      const grid = this.parseCsvGrid(buffer);
      const col = grid.headerIds.indexOf(mapping.spellingField ?? "");
      if (col < 0)
        throw new ImportParseError("选定的英文拼写字段在 CSV 表头中不存在", "INVALID_CSV");
      const rows = grid.rows.map((r) => ({ rawSpelling: r[col] ?? "" }));
      return this.toExtractResult(rows);
    }

    if (format === "json") {
      const kind = this.assertJson(buffer).kind;
      if (kind === "string") {
        const strings = this.parseJsonStringArray(buffer);
        return this.toExtractResult(strings.map((s) => ({ rawSpelling: s })));
      }
      // 对象数组。
      const records = this.parseJsonObjectArray(buffer);
      const field = mapping.spellingField ?? "word";
      if (!this.recordsHave(records, field)) {
        throw new ImportParseError("选定的英文拼写字段在 JSON 记录中不存在", "INVALID_JSON");
      }
      return this.toExtractResult(records.map((r) => ({ rawSpelling: r[field] ?? "" })));
    }

    if (format === "xlsx") {
      const workbook = await this.parseXlsxWorkbook(buffer);
      const sheetName = mapping.sheet ?? Object.keys(workbook)[0]!;
      const sheet = workbook[sheetName];
      if (!sheet) throw new ImportParseError("选定的工作表不存在", "INVALID_XLSX");
      const col = sheet.fieldIds.indexOf(mapping.spellingField ?? "");
      if (col < 0) {
        throw new ImportParseError("选定的英文拼写字段在该工作表中不存在", "INVALID_XLSX");
      }
      const rows = sheet.rows.map((r) => ({ rawSpelling: r[col] ?? "" }));
      return this.toExtractResult(rows);
    }

    throw new ImportParseError(`不支持的格式：${format}`, "FILE_NOT_SUPPORTED");
  }

  // ---- 发现 ----

  private parseDiscoveryText(buffer: Buffer, format: string): ParsedDocument {
    if (format === "txt") {
      return { sheets: [], fields: [] };
    }
    if (format === "csv") {
      const grid = this.parseCsvGrid(buffer);
      return {
        sheets: [],
        fields: grid.headerIds.map((fieldId, i) => ({
          fieldId,
          label: grid.headers[i]!.trim() !== "" ? grid.headers[i]! : `列 ${i + 1}`,
        })),
      };
    }
    // JSON
    const kind = this.assertJson(buffer).kind;
    if (kind === "string") {
      return { sheets: [], fields: [] };
    }
    const records = this.parseJsonObjectArray(buffer);
    const keys = new Set<string>();
    for (const r of records) for (const k of Object.keys(r)) keys.add(k);
    return {
      sheets: [],
      fields: [...keys].map((fieldId) => ({ fieldId, label: fieldId })),
    };
  }

  private async parseDiscoveryXlsx(buffer: Buffer): Promise<ParsedDocument> {
    const workbook = await this.parseXlsxWorkbook(buffer);
    const sheets = Object.keys(workbook).map((fieldId) => ({ fieldId, label: fieldId }));
    // 每个工作表各自的字段集需在渲染表格时才按当前选定工作表懒加载；这里返回第一张表字段。
    const first = Object.keys(workbook)[0];
    const sheetFields: Record<string, SheetFieldSet> = {};
    for (const name of Object.keys(workbook)) {
      const s = workbook[name]!;
      sheetFields[name] = {
        fieldIds: s.fieldIds,
        labels: s.headers,
      };
    }
    const fields: DiscoveredOption[] = first
      ? workbook[first]!.fieldIds.map((fieldId, i) => ({
          fieldId,
          label:
            workbook[first]!.headers[i]!.trim() !== ""
              ? workbook[first]!.headers[i]!
              : `列 ${i + 1}`,
        }))
      : [];
    return { sheets, fields, sheetFields };
  }

  // ---- 提取辅助 ----

  private toExtractResult(rows: { rawSpelling: string }[], blankOverride?: number): ExtractResult {
    const maxCellLength = this.config.import.maxCellLength;
    let ignoredBlankCount = blankOverride ?? 0;
    const kept: { rawSpelling: string }[] = [];
    const rowIssues: ImportRowIssue[][] = [];
    for (const r of rows) {
      if (r.rawSpelling.trim().length === 0) {
        if (blankOverride === undefined) ignoredBlankCount++;
        continue;
      }
      kept.push(r);
      rowIssues.push(classifySpellingIssues(r.rawSpelling, maxCellLength));
    }
    return { rows: kept, rowIssues, ignoredBlankCount };
  }

  private readStored(storageKey: string): Buffer {
    const path = resolve(process.cwd(), this.config.import.fileRootDir, storageKey);
    try {
      return readFileSync(path);
    } catch (err) {
      throw new ImportParseError("无法读取已保存的原始文件", "FILE_NOT_SUPPORTED", [
        err instanceof Error ? err.message : "读取失败",
      ]);
    }
  }

  private parseTxtLines(buffer: Buffer): { lines: string[]; blankCount: number } {
    const decoded = buffer.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(buffer)) {
      throw new ImportParseError("文件含有无法按 UTF-8 解码的字节", "UNDECODABLE_TEXT");
    }
    const text = stripBom(decoded);
    const cfg = this.config.import;
    const lines: string[] = [];
    let blankCount = 0;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        blankCount++;
        continue;
      }
      if (trimmed.length > cfg.maxCellLength) {
        throw new ImportParseError(`单词长度超过上限 ${cfg.maxCellLength}`, "CELL_TOO_LONG");
      }
      lines.push(trimmed);
    }
    if (lines.length > cfg.maxRows) {
      throw new ImportParseError(`行数超过上限 ${cfg.maxRows}`, "TOO_MANY_ROWS");
    }
    return { lines, blankCount };
  }

  private parseCsvGrid(buffer: Buffer): {
    headers: string[];
    headerIds: string[];
    rows: string[][];
  } {
    const text = stripBom(buffer.toString("utf8"));
    let parsed: (string | null)[][];
    try {
      parsed = csvParse(text, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
      }) as unknown as (string | null)[][];
    } catch (err) {
      throw new ImportParseError("CSV 解析失败：引号/换行/逗号不完整", "INVALID_CSV", [
        err instanceof Error ? err.message.slice(0, 120) : "解析失败",
      ]);
    }
    if (parsed.length === 0) return { headers: [], headerIds: [], rows: [] };
    const headers = parsed[0]!.map((c) => (c == null ? "" : String(c)));
    const headerIds = stableFieldIdentifiers(headers);
    if (parsed.length - 1 > this.config.import.maxRows) {
      throw new ImportParseError(
        `CSV 数据行数超过上限 ${this.config.import.maxRows}`,
        "TOO_MANY_ROWS",
      );
    }
    const rows = parsed.slice(1).map((r) => r.map((c) => (c == null ? "" : String(c))));
    for (const row of rows) {
      for (const cell of row) {
        if (cell.length > this.config.import.maxCellLength) {
          throw new ImportParseError(
            `CSV 单元格超过长度上限 ${this.config.import.maxCellLength}`,
            "CELL_TOO_LONG",
          );
        }
      }
    }
    return { headers, headerIds, rows };
  }

  private parseJsonStringArray(buffer: Buffer): string[] {
    const { parsed } = this.assertJson(buffer);
    const strings = parsed as string[];
    for (const s of strings) {
      if (s.length > this.config.import.maxCellLength) {
        throw new ImportParseError(
          `JSON 元素超过长度上限 ${this.config.import.maxCellLength}`,
          "CELL_TOO_LONG",
        );
      }
    }
    return strings;
  }

  private parseJsonObjectArray(buffer: Buffer): Record<string, string>[] {
    const { parsed } = this.assertJson(buffer);
    return (parsed as Record<string, unknown>[]).map((rec) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = String(v);
      return out;
    });
  }

  private recordsHave(records: Record<string, string>[], field: string): boolean {
    return records.length === 0 || Object.prototype.hasOwnProperty.call(records[0]!, field);
  }

  private async parseXlsxWorkbook(
    buffer: Buffer,
  ): Promise<Record<string, { headers: string[]; fieldIds: string[]; rows: string[][] }>> {
    // P1-1：展开 ZIP 之前做有界预检，保护 4 GB 家庭服务器。
    this.preflightXlsxArchive(buffer);

    let sheets: { sheet: string; data: unknown[][] }[];
    try {
      const parsed = (await readXlsxFile(buffer)) as unknown as {
        sheet: string;
        data: unknown[][];
      }[];
      sheets = parsed;
    } catch (err) {
      const code = this.classifyXlsxError(err);
      throw new ImportParseError(this.xlsxErrorMessage(code), code);
    }
    if (sheets.length === 0) throw new ImportParseError("工作簿不含任何工作表", "INVALID_XLSX");
    if (sheets.length > this.config.import.maxSheets) {
      throw new ImportParseError(
        `工作表数量超过上限 ${this.config.import.maxSheets}`,
        "TOO_MANY_SHEETS",
      );
    }
    let cellCount = 0;
    for (const s of sheets) for (const row of s.data) cellCount += row.length;
    if (cellCount > this.config.import.maxCells) {
      throw new ImportParseError(
        `有效单元格数量超过上限 ${this.config.import.maxCells}`,
        "TOO_MANY_CELLS",
      );
    }

    const out: Record<string, { headers: string[]; fieldIds: string[]; rows: string[][] }> = {};
    for (const s of sheets) {
      const name = s.sheet.trim() !== "" ? s.sheet : `工作表 ${sheets.indexOf(s) + 1}`;
      const stringRows = s.data.map((r) => r.map((c) => this.cellToString(c)));
      // 单元格长度上限：任一非表头单元格超限 → 该工作表数据无效但整工作簿仍可发现；
      // 这里在提取阶段由 classifySpellingIssues 处理，此处只做整体护栏（超长单元格阻断）。
      for (let ri = 0; ri < stringRows.length; ri++) {
        for (const cell of stringRows[ri]!) {
          if (ri > 0 && cell.length > this.config.import.maxCellLength) {
            throw new ImportParseError(
              `单元格超过长度上限 ${this.config.import.maxCellLength}`,
              "CELL_TOO_LONG",
            );
          }
        }
      }
      const headers = stringRows[0] ?? [];
      const headerIds = stableFieldIdentifiers(headers);
      const rows = stringRows.slice(1);
      if (rows.length > this.config.import.maxRows) {
        throw new ImportParseError(
          `工作表行数超过上限 ${this.config.import.maxRows}`,
          "TOO_MANY_ROWS",
        );
      }
      out[name] = { headers, fieldIds: headerIds, rows };
    }
    return out;
  }

  private cellToString(cell: unknown): string {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "boolean") return cell ? "true" : "false";
    return String(cell);
  }

  /**
   * P1-1：在把 XLSX 交给展开/解析器之前的窄带 ZIP 预检。
   * 只读取 ZIP 的 End-of-Central-Directory（EOCD）+ 中央目录条目，不展开任何条目，
   * 用于在耗尽内存/CPU 之前拒绝：
   *   - 非 ZIP / 损坏 EOCD；
   *   - 条目数超限；
   *   - 声明未压缩总大小超限；
   *   - 压缩膨胀比过高（ZIP bomb）；
   *   - 宏启用变体（.xlsm/vbaProject）。
   * 不实现通用归档子系统；本逻辑私有于 XLSX 解析。
   */
  private preflightXlsxArchive(buffer: Buffer): void {
    const cfg = this.config.import;
    if (buffer.length < 22) {
      throw new ImportParseError("XLSX 文件不完整或不是有效的 ZIP 归档", "INVALID_ZIP");
    }
    // 允许在文件末尾加数字签名（Zip64 EOCD 之后的签名），向前扫描 EOCD 签名 0x06054b50。
    let eocd = -1;
    const minEocd = 22;
    for (let i = buffer.length - minEocd; i >= 0; i--) {
      if (
        buffer[i] === 0x50 &&
        buffer[i + 1] === 0x4b &&
        buffer[i + 2] === 0x05 &&
        buffer[i + 3] === 0x06
      ) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new ImportParseError("XLSX 文件损坏或不是有效的 ZIP 归档", "INVALID_ZIP");
    }
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const dirSize = buffer.readUInt32LE(eocd + 12);
    const dirOffset = buffer.readUInt32LE(eocd + 16);

    if (entryCount > cfg.maxZipEntries) {
      throw new ImportParseError(
        `XLSX 内含条目数量超过上限 ${cfg.maxZipEntries}`,
        "ZIP_TOO_MANY_ENTRIES",
      );
    }

    // 校验中央目录边界，避免越界读取。
    if (dirOffset < 0 || dirOffset + dirSize > buffer.length) {
      throw new ImportParseError("XLSX 文件损坏或不是有效的 ZIP 归档", "ZIP_MALFORMED");
    }

    // 遍历中央目录条目，聚合声明未压缩大小与压缩膨胀比，并收集条目名供 OOXML 结构校验。
    let totalUncompressed = 0;
    let pos = dirOffset;
    const entryNames: string[] = [];
    // 安全扫描边界：最多遍历 entryCount 次，防止伪造目录导致死循环。
    for (let n = 0; n < entryCount; n++) {
      if (pos + 46 > buffer.length) {
        throw new ImportParseError("XLSX 文件损坏或不是有效的 ZIP 归档", "ZIP_MALFORMED");
      }
      if (
        buffer[pos] !== 0x50 ||
        buffer[pos + 1] !== 0x4b ||
        buffer[pos + 2] !== 0x01 ||
        buffer[pos + 3] !== 0x02
      ) {
        throw new ImportParseError("XLSX 文件损坏或不是有效的 ZIP 归档", "ZIP_MALFORMED");
      }
      const compressed = buffer.readUInt32LE(pos + 20);
      const uncompressed = buffer.readUInt32LE(pos + 24);
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);
      const nameStart = pos + 46;
      if (nameStart + nameLen > buffer.length) {
        throw new ImportParseError("XLSX 文件损坏或不是有效的 ZIP 归档", "ZIP_MALFORMED");
      }
      const name = buffer.toString("utf8", nameStart, nameStart + nameLen);
      entryNames.push(name);

      // 拒绝宏启用变体：vbaProject 结构。
      if (/^xl\/vbaProject\.bin$/i.test(name)) {
        throw new ImportParseError(
          "不支持宏启用的工作簿（.xlsm/vbaProject）",
          "XLSX_MACRO_BLOCKED",
        );
      }

      totalUncompressed += uncompressed;

      // 压缩膨胀比防护：压缩比过高（解压后远大于压缩后+文件本身）。
      const expansion = uncompressed / Math.max(1, compressed);
      if (expansion > cfg.maxZipExpansionRatio) {
        throw new ImportParseError(`XLSX 压缩膨胀比过高（疑似压缩炸弹）`, "ZIP_EXPANSION_TOO_HIGH");
      }

      pos = nameStart + nameLen + extraLen + commentLen;
    }

    if (totalUncompressed > cfg.maxZipUncompressedBytes) {
      throw new ImportParseError(
        `XLSX 解压后总大小超过上限 ${cfg.maxZipUncompressedBytes} 字节`,
        "ZIP_TOO_LARGE_UNCOMPRESSED",
      );
    }

    // P1-A：OOXML 必要结构校验。一个合法的 .xlsx 必须包含这些包部件：
    //   - [Content_Types].xml（包内容类型清单）
    //   - _rels/.rels（包级关系）
    //   - xl/workbook.xml（工作簿主体）
    // 缺任一即不是 OOXML 电子表格，直接拒绝，避免任意 ZIP 归档进入高层解析器。
    const requiredParts = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"];
    const nameSet = new Set(entryNames.map((s) => s.replace(/^\/+/, "")));
    const missing = requiredParts.filter((p) => !nameSet.has(p));
    if (missing.length > 0) {
      throw new ImportParseError(
        "文件不是有效的 XLSX 工作簿（缺少 OOXML 必要结构）",
        "XLSX_STRUCTURE_INVALID",
      );
    }
  }

  private classifyXlsxError(err: unknown): ImportParseError["code"] {
    const message = err instanceof Error ? err.message : String(err);
    if (/\.xls\b|legacy|binary|OLE2|XLS_FILE_NOT_SUPPORTED/i.test(message))
      return "XLS_NOT_SUPPORTED";
    if (/ZIP|invalid zip|INVALID_ZIP/i.test(message)) return "INVALID_ZIP";
    if (/not.*supported|FILE_NOT_SUPPORTED/i.test(message)) return "FILE_NOT_SUPPORTED";
    if (/empty|NO_DATA/i.test(message)) return "INVALID_XLSX";
    return "INVALID_XLSX";
  }

  private xlsxErrorMessage(code: ImportParseError["code"]): string {
    switch (code) {
      case "XLS_NOT_SUPPORTED":
        return "不支持旧版 .xls 文件；请另存为 .xlsx 后重试";
      case "INVALID_ZIP":
        return "XLSX 文件损坏或不是有效的 ZIP 归档";
      case "FILE_NOT_SUPPORTED":
        return "文件不是有效的 XLSX 工作簿";
      case "TOO_MANY_SHEETS":
        return "工作表数量超出限制";
      case "TOO_MANY_CELLS":
        return "有效单元格数量超出限制（疑似压缩炸弹）";
      default:
        return "XLSX 解析失败";
    }
  }

  private assertJson(buffer: Buffer): { parsed: unknown; kind: "string" | "object" } {
    const text = stripBom(buffer.toString("utf8"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ImportParseError("JSON 无法解析（语法错误）", "INVALID_JSON");
    }
    if (!jsonDepthWithinLimit(parsed, this.config.import.maxJsonDepth)) {
      throw new ImportParseError(
        `JSON 嵌套深度超过上限 ${this.config.import.maxJsonDepth}`,
        "JSON_TOO_DEEP",
      );
    }
    const shape = validateJsonDocument(parsed, this.config.import.maxRows);
    if (!shape.ok) throw new ImportParseError(shape.error, "INVALID_JSON");
    return { parsed, kind: shape.kind === "string-array" ? "string" : "object" };
  }
}
