// Ticket 08 发布资格展示的纯逻辑（无副作用，可单测）。
// 只消费服务端 validate 返回的 blockingErrors；不在前端自行为资格下结论。
// 敏感字段绝不进入此层（只看 code/path/message，从不看 provider/prompt/hash/路径）。

export interface BlockingReason {
  code: string;
  message: string;
  path: string;
}

export interface BlockedItem {
  itemId: string;
  reasons: BlockingReason[];
}

/** 从 validate 结果把 `item.*` 阻断原因聚合到每个 course_item_id。 */
export function groupItemBlockers(issues: BlockingReason[]): Map<string, BlockingReason[]> {
  const map = new Map<string, BlockingReason[]>();
  for (const issue of issues) {
    if (!issue.path.startsWith("item.")) continue;
    const itemId = issue.path.split(".")[1];
    if (!itemId) continue;
    const list = map.get(itemId) ?? [];
    list.push({ code: issue.code, message: issue.message, path: issue.path });
    map.set(itemId, list);
  }
  return map;
}

export type PublicationStateCategory =
  "eligible" | "provenanceIncomplete" | "manualActionUnresolved" | "rejected" | "otherBlocked";

export interface CategorizedItem {
  id: string;
  reason: string;
}

export interface PublicationStateSummary {
  provenanceIncomplete: CategorizedItem[];
  manualActionUnresolved: CategorizedItem[];
  rejected: CategorizedItem[];
  otherBlocked: CategorizedItem[];
  eligibleCount: number;
  blockedCount: number;
}

/**
 * 把词项状态归类为面向管理员的安全展示态（fail-closed）。
 * 只依据服务端阻断 code 归类；绝不打开对 content 的访问。
 */
export function categorizeBlockers(
  blockedItems: BlockedItem[],
  totalItems: number,
): PublicationStateSummary {
  const provenanceIncomplete: CategorizedItem[] = [];
  const manualActionUnresolved: CategorizedItem[] = [];
  const rejected: CategorizedItem[] = [];
  const otherBlocked: CategorizedItem[] = [];
  for (const it of blockedItems) {
    const codes = it.reasons.map((r) => r.code);
    const first = it.reasons[0]?.message ?? "";
    // reject 优先：reject 是终态，即便 code 含 REVIEW 也不能归入 provenance。
    if (codes.some((c) => /REJECT/i.test(c))) {
      rejected.push({ id: it.itemId, reason: first });
    } else if (codes.some((c) => /REVIEW|PROVENANCE|LICENSE|ATTRIBUTION|REVISION|SOURCE/.test(c))) {
      provenanceIncomplete.push({ id: it.itemId, reason: first });
    } else if (codes.some((c) => /MANUAL|BUDGET|AMBIGUOUS/.test(c))) {
      manualActionUnresolved.push({ id: it.itemId, reason: first });
    } else {
      otherBlocked.push({ id: it.itemId, reason: first });
    }
  }
  const eligibleCount = Math.max(0, totalItems - blockedItems.length);
  return {
    provenanceIncomplete,
    manualActionUnresolved,
    rejected,
    otherBlocked,
    eligibleCount,
    blockedCount: blockedItems.length,
  };
}

const ITEM_PATH_RE = /^item\.[^.]+\.[^.]+$/;

/** 判定一个 validate path 是否指向词项（item.<id>.<field>）。 */
export function isItemBlockPath(path: string): boolean {
  return ITEM_PATH_RE.test(path);
}
