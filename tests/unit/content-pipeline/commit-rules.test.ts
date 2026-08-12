// 阶段 6 工单 03：提交有效行与错误报告的纯规则单元测试。
// 覆盖：可提交判定（eligibility）、提交摘要推导、CSV 安全转义、公式注入中和、
// 安全报告文件名、幂等语义哈希的稳定身份比较。
import { describe, expect, it } from "vitest";
import {
  isRowCommittable,
  buildCommitSummary,
  commitSemanticHash,
  neutralizeCsvFormula,
  escapeCsvField,
  errorReportCsvLine,
  ERROR_REPORT_CSV_HEADER,
  ERROR_REPORT_CSV_LINE_SEPARATOR,
  safeReportFilename,
} from "@motro/domain";

describe("可提交判定（eligibility）", () => {
  const base = {
    status: "candidate",
    normalizedSpelling: "abandon",
    rowMappingVersion: 2,
    batchMappingVersion: 2,
    alreadyCommitted: false,
  };

  it("满足全部条件的行可提交", () => {
    expect(isRowCommittable(base)).toBe("committable");
  });

  it("existing_entry 行（关联既有词条）可提交（P1-2）", () => {
    expect(isRowCommittable({ ...base, status: "existing_entry" })).toBe("committable");
  });

  it("不可提交状态（invalid / duplicate_in_file / stale）不可提交", () => {
    for (const status of ["invalid", "duplicate_in_file", "stale"]) {
      expect(isRowCommittable({ ...base, status })).toBe("not_eligible");
    }
  });

  it("空/空白规范化拼写不可提交", () => {
    expect(isRowCommittable({ ...base, normalizedSpelling: "" })).toBe("not_eligible");
    expect(isRowCommittable({ ...base, normalizedSpelling: "   " })).toBe("not_eligible");
    expect(isRowCommittable({ ...base, normalizedSpelling: null })).toBe("not_eligible");
    expect(isRowCommittable({ ...base, normalizedSpelling: undefined })).toBe("not_eligible");
  });

  it("行映射版本落后于批次当前版本（stale）不可提交", () => {
    expect(isRowCommittable({ ...base, rowMappingVersion: 1, batchMappingVersion: 2 })).toBe(
      "not_eligible",
    );
  });

  it("已提交过的行不可再次提交", () => {
    expect(isRowCommittable({ ...base, alreadyCommitted: true })).toBe("not_eligible");
  });
});

describe("提交摘要推导", () => {
  it("非重放时正确回显各项计数", () => {
    const s = buildCommitSummary({
      createdEntryCount: 3,
      associatedExistingEntryCount: 2,
      skippedCountByDisposition: { invalid: 1, duplicate_in_file: 1 },
      committedRowCount: 5,
      isIdempotentReplay: false,
    });
    expect(s.createdEntryCount).toBe(3);
    expect(s.associatedExistingEntryCount).toBe(2);
    expect(s.skippedCountByDisposition).toEqual({ invalid: 1, duplicate_in_file: 1 });
    expect(s.committedRowCount).toBe(5);
    expect(s.isIdempotentReplay).toBe(false);
  });

  it("P2-1 不变量：committedRowCount == created + associated（跳过行不计入）", () => {
    const s = buildCommitSummary({
      createdEntryCount: 2,
      associatedExistingEntryCount: 3,
      skippedCountByDisposition: { invalid: 7, duplicate_in_file: 1 },
      committedRowCount: 5,
      isIdempotentReplay: false,
    });
    expect(s.committedRowCount).toBe(s.createdEntryCount + s.associatedExistingEntryCount);
    // 跳过行独立于 committed 计数（本例跳过 8 行 ≠ committed 5）。
    const skippedSum = Object.values(s.skippedCountByDisposition).reduce((a, b) => a + b, 0);
    expect(skippedSum).toBe(8);
    expect(s.committedRowCount).not.toBe(skippedSum);
  });

  it("跳过计数是副本，不共享可变引用", () => {
    const src = { invalid: 1 };
    const s = buildCommitSummary({
      createdEntryCount: 0,
      associatedExistingEntryCount: 0,
      skippedCountByDisposition: src,
      committedRowCount: 0,
      isIdempotentReplay: true,
    });
    src.invalid = 99;
    expect(s.skippedCountByDisposition.invalid).toBe(1);
  });
});

describe("CSV 安全转义（RFC 4180）", () => {
  it("普通值原样返回", () => {
    expect(escapeCsvField("abandon")).toBe("abandon");
  });

  it("含逗号/引号/换行的值被双引号包裹，内嵌引号翻倍", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    expect(escapeCsvField("a\nb")).toBe('"a\nb"');
    expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("空串保持为空（不包裹）", () => {
    expect(escapeCsvField("")).toBe("");
  });
});

describe("电子表格公式注入中和", () => {
  it("以 = + - @ 开头的值前置单引号", () => {
    expect(neutralizeCsvFormula("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutralizeCsvFormula("+cmd")).toBe("'+cmd");
    expect(neutralizeCsvFormula("-cmd")).toBe("'-cmd");
    expect(neutralizeCsvFormula("@cmd")).toBe("'@cmd");
  });

  it("前置空白后再判定危险前缀", () => {
    expect(neutralizeCsvFormula("  =SUM(A1)")).toBe("'  =SUM(A1)");
  });

  it("无危险前缀的值原样保留", () => {
    expect(neutralizeCsvFormula("abandon")).toBe("abandon");
    expect(neutralizeCsvFormula("3.14")).toBe("3.14");
  });

  it("空串保持为空", () => {
    expect(neutralizeCsvFormula("")).toBe("");
  });
});

describe("错误报告 CSV 行", () => {
  it("表头字段顺序正确", () => {
    expect(ERROR_REPORT_CSV_HEADER).toBe(
      "ordinal,rawSummary,status,errorCodes,duplicateOfOrdinal,mappingVersion",
    );
  });

  it("构造普通行并中和 rawSummary 与 errorCodes 中的公式前缀", () => {
    const line = errorReportCsvLine({
      ordinal: 3,
      rawSummary: "=HYPERLINK(...)",
      status: "invalid",
      errorCodes: ["invalid_spelling"],
      duplicateOfOrdinal: null,
      mappingVersion: 2,
    });
    expect(line).toBe("3,'=HYPERLINK(...),invalid,invalid_spelling,,2");
  });

  it("多错误码以竖线连接，重复 ordinal 输出数字", () => {
    const line = errorReportCsvLine({
      ordinal: 7,
      rawSummary: "apple",
      status: "duplicate_in_file",
      errorCodes: ["duplicate_in_file"],
      duplicateOfOrdinal: 2,
      mappingVersion: 1,
    });
    expect(line).toBe("7,apple,duplicate_in_file,duplicate_in_file,2,1");
  });

  it("含逗号/引号的 rawSummary 被转义并中和", () => {
    const line = errorReportCsvLine({
      ordinal: 1,
      rawSummary: '=a,"b"',
      status: "invalid",
      errorCodes: [],
      duplicateOfOrdinal: null,
      mappingVersion: 1,
    });
    // 先中和公式前缀（' 前置），再按 RFC 4180 转义（外层引号 + 内嵌引号翻倍）。
    expect(line).toBe('1,"\'=a,""b""",invalid,,,1');
  });

  it("行分隔符为 LF", () => {
    expect(ERROR_REPORT_CSV_LINE_SEPARATOR).toBe("\n");
  });
});

describe("幂等语义哈希（稳定身份比较）", () => {
  it("相同输入产生相同哈希", () => {
    const a = commitSemanticHash({ batchId: "b1", mappingVersion: 2, validationInputSha256: "h" });
    const b = commitSemanticHash({ batchId: "b1", mappingVersion: 2, validationInputSha256: "h" });
    expect(a).toBe(b);
  });

  it("不同 mappingVersion 或校验输入哈希产生不同哈希", () => {
    const base = { batchId: "b1", validationInputSha256: "h" };
    expect(commitSemanticHash({ ...base, mappingVersion: 1 })).not.toBe(
      commitSemanticHash({ ...base, mappingVersion: 2 }),
    );
    expect(
      commitSemanticHash({ ...base, mappingVersion: 1, validationInputSha256: "h2" }),
    ).not.toBe(commitSemanticHash({ ...base, mappingVersion: 1, validationInputSha256: "h" }));
  });

  it("不同批次产生不同哈希", () => {
    expect(
      commitSemanticHash({ batchId: "b1", mappingVersion: 1, validationInputSha256: "h" }),
    ).not.toBe(
      commitSemanticHash({ batchId: "b2", mappingVersion: 1, validationInputSha256: "h" }),
    );
  });
});

describe("安全报告文件名", () => {
  it("仅含字母数字与连字符，绝不包含用户输入", () => {
    const name = safeReportFilename("11111111-2222-3333-4444-555555555555", "2026-08-12T10-00-00Z");
    expect(name).toMatch(/^motro-import-error-report-[a-zA-Z0-9-]+-[a-zA-Z0-9-]+\.csv$/);
  });

  it("剥离任意非法字符（不含路径分隔符或点）", () => {
    const name = safeReportFilename("../../etc/passwd", "2026-08-12T10-00-00Z");
    expect(name).not.toMatch(/\//);
    expect(name).not.toMatch(/\.\./);
    expect(name).toMatch(/^motro-import-error-report-[a-zA-Z0-9-]+-[a-zA-Z0-9-]+\.csv$/);
  });
});
