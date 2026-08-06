// 课程草稿校验（纯函数）：输入草稿快照与可选当前发布简表，输出阻断错误、警告与差异摘要。
// blocking 决定是否可发布；warning 只提示注意，不绕过 blocking。
// content_review_reference 的有效性由服务端解析后以 contentReviewValid 传入，本函数不查询数据库。
import { createHash } from "node:crypto";
import type {
  DiffSummary,
  ValidationIssue,
  ValidationResult,
  ValidateDraftInput,
} from "./types.js";

export function validateCourseDraft(input: ValidateDraftInput): ValidationResult {
  const blockingErrors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (input.title.trim().length === 0) {
    blockingErrors.push({
      code: "COURSE_TITLE_EMPTY",
      path: "course.title",
      message: "课程标题不能为空",
      severity: "error",
    });
  }

  if (input.units.length === 0) {
    blockingErrors.push({
      code: "COURSE_NO_UNITS",
      path: "course",
      message: "课程至少需要一个单元",
      severity: "error",
    });
  }

  const unitPositions = input.units.map((u) => u.position).sort((a, b) => a - b);
  for (let i = 0; i < unitPositions.length; i++) {
    if (unitPositions[i] !== i + 1) {
      blockingErrors.push({
        code: "UNIT_ORDER_INVALID",
        path: "course.units",
        message: "单元顺序必须连续且唯一",
        severity: "error",
      });
      break;
    }
  }

  for (const unit of input.units) {
    if (unit.description.trim().length === 0) {
      warnings.push({
        code: "UNIT_DESCRIPTION_EMPTY",
        path: `unit.${unit.id}.description`,
        message: "单元缺少描述（可发布，建议补充）",
        severity: "warning",
      });
    }
    if (unit.items.length === 0) {
      blockingErrors.push({
        code: "UNIT_NO_ITEMS",
        path: `unit.${unit.id}`,
        message: "每个单元至少需要一个课程词项",
        severity: "error",
      });
    }
    const itemPositions = unit.items.map((i) => i.position).sort((a, b) => a - b);
    for (let i = 0; i < itemPositions.length; i++) {
      if (itemPositions[i] !== i + 1) {
        blockingErrors.push({
          code: "ITEM_ORDER_INVALID",
          path: `unit.${unit.id}.items`,
          message: "词项顺序必须连续且唯一",
          severity: "error",
        });
        break;
      }
    }
    for (const item of unit.items) {
      if (item.meaning.trim().length === 0) {
        blockingErrors.push({
          code: "ITEM_MEANING_EMPTY",
          path: `item.${item.id}.meaning`,
          message: "课程词项中文释义不能为空",
          severity: "error",
        });
      }
      if (!item.lexicalEntryExists) {
        blockingErrors.push({
          code: "ITEM_LEXICAL_ENTRY_MISSING",
          path: `item.${item.id}.lexicalEntryId`,
          message: "课程词项引用的词条不存在",
          severity: "error",
        });
      }
      if (!item.contentReviewValid) {
        blockingErrors.push({
          code: "ITEM_CONTENT_REVIEW_INVALID",
          path: `item.${item.id}.contentReviewReference`,
          message: "课程词项缺少有效的人工内容依据",
          severity: "error",
        });
      }
    }
  }

  const diffSummary = buildDiffSummary(input);
  if (input.currentRelease && diffSummary.kind === "changed") {
    const changed =
      diffSummary.addedUnits > 0 ||
      diffSummary.removedUnits > 0 ||
      diffSummary.addedItems > 0 ||
      diffSummary.removedItems > 0;
    if (changed) {
      warnings.push({
        code: "CONTENT_COUNT_CHANGED",
        path: "course",
        message: "课程内容数量相对当前发布版本有变化",
        severity: "warning",
      });
    }
  }

  return {
    draftVersion: input.draftVersion,
    isPublishable: blockingErrors.length === 0,
    blockingErrors,
    warnings,
    diffSummary,
    contentHash: computeContentHash(input),
  };
}

function buildDiffSummary(input: ValidateDraftInput): DiffSummary {
  const totalUnits = input.units.length;
  const totalItems = input.units.reduce((n, u) => n + u.items.length, 0);
  if (!input.currentRelease) {
    return {
      kind: "initial",
      addedUnits: totalUnits,
      removedUnits: 0,
      addedItems: totalItems,
      removedItems: 0,
      changedItems: 0,
      totalUnits,
      totalItems,
    };
  }
  const cr = input.currentRelease;
  return {
    kind: "changed",
    addedUnits: Math.max(0, totalUnits - cr.unitCount),
    removedUnits: Math.max(0, cr.unitCount - totalUnits),
    addedItems: Math.max(0, totalItems - cr.itemCount),
    removedItems: Math.max(0, cr.itemCount - totalItems),
    changedItems: Math.min(totalItems, cr.itemCount),
    totalUnits,
    totalItems,
  };
}

/** 草稿内容规范化序列化的 SHA-256；不包含服务端解析的临时标志（词条存在性/审计有效性）。 */
export function computeContentHash(input: ValidateDraftInput): string {
  const canonical = JSON.stringify({
    draftVersion: input.draftVersion,
    title: input.title,
    units: input.units.map((u) => ({
      id: u.id,
      position: u.position,
      title: u.title,
      description: u.description,
      items: u.items.map((i) => ({
        id: i.id,
        position: i.position,
        meaning: i.meaning,
        hint: i.hint,
        lexicalEntryId: i.lexicalEntryId,
      })),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
