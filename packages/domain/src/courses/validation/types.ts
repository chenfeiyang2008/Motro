// 课程草稿校验：纯领域类型与结果形状（无副作用、无数据库）。
// path 可定位到课程、unit ID 或 course item ID，供 OpenAPI/自动化测试/未来客户端复用。

export type Severity = "error" | "warning";

export interface ValidationIssue {
  /** 稳定错误码，如 COURSE_TITLE_EMPTY、UNIT_NO_ITEMS、ITEM_MEANING_EMPTY。 */
  code: string;
  /** 定位：course、course.title、unit.<unitId>、item.<itemId>.meaning 等。 */
  path: string;
  message: string;
  severity: Severity;
}

export interface ItemSnapshot {
  id: string;
  position: number;
  meaning: string;
  hint: string | null;
  lexicalEntryId: string;
  /** 词条引用是否仍存在（服务端解析后传入）。 */
  lexicalEntryExists: boolean;
  contentReviewReference: string;
  /** content_review_reference 是否指向有效审计事件（服务端解析后传入）。 */
  contentReviewValid: boolean;
}

export interface UnitSnapshot {
  id: string;
  position: number;
  title: string;
  description: string;
  items: ItemSnapshot[];
}

/** 当前发布版本的简表；缺省表示首次发布（initial）。 */
export interface CurrentReleaseSummary {
  unitCount: number;
  itemCount: number;
}

export interface ValidateDraftInput {
  draftVersion: number;
  title: string;
  units: UnitSnapshot[];
  currentRelease?: CurrentReleaseSummary;
}

export interface DiffSummary {
  kind: "initial" | "changed";
  addedUnits: number;
  removedUnits: number;
  addedItems: number;
  removedItems: number;
  changedItems: number;
  totalUnits: number;
  totalItems: number;
}

export interface ValidationResult {
  draftVersion: number;
  isPublishable: boolean;
  blockingErrors: ValidationIssue[];
  warnings: ValidationIssue[];
  diffSummary: DiffSummary;
  /** 草稿内容规范化序列化的 SHA-256；任一草稿写入都会使哈希变化。 */
  contentHash: string;
}
