// 审核工作台纯逻辑（Ticket 18）：无副作用、无 React、可直接单测。
// 只消费 @motro/api-client 生成类型和字符串常量；不读取 provider/prompt/内部路径。

import type { ReviewDraftDetail, ReviewDraftListItem } from "./api";

/** 审核决定类型 → 用户可见标签（繁简中文统一）。 */
export function reviewDecisionLabel(decisionType: string): string {
  switch (decisionType) {
    case "accept":
      return "接受";
    case "accept_with_edits":
      return "修改后接受";
    case "reject":
      return "驳回";
    default:
      return decisionType;
  }
}

/** 草稿状态 → 用户可见标签。 */
export function reviewStatusLabel(status: string): string {
  switch (status) {
    case "draft_ready":
      return "待审核";
    case "manual_action":
      return "待处理";
    default:
      return status;
  }
}

/** 审核草稿状态 → 状态徽章 class 名（对应 globals.css 的 token）。 */
export function reviewStatusBadgeClass(status: string): string {
  switch (status) {
    case "draft_ready":
      return "review-badge--pending";
    case "manual_action":
      return "review-badge--manual";
    default:
      return "review-badge--unknown";
  }
}

/** 判定一个草稿是否可以被审核员进行 accept/accept_with_edits/reject 决策。 */
export function canReviewDraft(draft: ReviewDraftListItem): boolean {
  // 有效审核投影的两个分支：draft_ready 带含义，或 可解除 manual_action 已处理。
  // 列表端的 status 已经是投影后的状态（detail 时 manual_action 以 draft_ready 语义展示）。
  return draft.status === "draft_ready";
}

/** 审核决定操作按钮标签。 */
export function reviewActionLabel(action: "accept" | "accept_with_edits" | "reject"): string {
  switch (action) {
    case "accept":
      return "接受";
    case "accept_with_edits":
      return "修改后接受";
    case "reject":
      return "驳回";
  }
}

/**
 * 生成审核意图级幂等键（首次提交时调用；重试复用同一键）。
 * 与用户管理/操作重试的模式一致：意图键在内存中管理。
 */
export function generateReviewIntentKey(): string {
  return (
    globalThis.crypto?.randomUUID?.().toString() ??
    `review-${Math.random().toString(36).slice(2)}-${Date.now()}`
  );
}

/** 手动处理错误码 → 面向管理员的简短解释。 */
export function manualActionExplanation(errorCode: string | null): string {
  if (!errorCode) return "需要人工处理";
  if (errorCode === "DRAFT_BUDGET_EXCEEDED")
    return "该草稿对应的每日生成预算已耗尽，需要管理员确认是否继续处理";
  if (errorCode === "WIKI_AMBIGUOUS")
    return "Wiktionary 返回了多个候选，需要管理员确认哪一个对应当前词条";
  return `需要人工处理（原因：${errorCode}）`;
}

/** 来源 URL 截断显示（仅截断超长 URL，不丢失协议/域名）。 */
export function truncateSourceUrl(url: string, maxLen = 48): string {
  if (url.length <= maxLen) return url;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const prefix = `${parsed.protocol}//${parsed.host}`;
    if (prefix.length >= maxLen - 3) return prefix.slice(0, maxLen - 3) + "…";
    const remaining = maxLen - prefix.length - 3;
    return prefix + (path.length > remaining ? path.slice(0, remaining) + "…" : path);
  } catch {
    return url.slice(0, maxLen - 1) + "…";
  }
}

/**
 * 判定一个审核草稿详情是否必须以「接受并修改（accept_with_edits）」提供真实中文含义。
 *
 * 可补全 manual_action 草稿在有效审核投影中以 draft_ready 语义展示，但物理含义为 NULL
 * （服务端绝不改写不可变草稿）。对该类草稿直接 accept 无效（serves 422
 * 「须以 accept_with_edits 提供真实中文含义」）。fail-closed：含义为空即判定为需要含义。
 */
export function requiresRealMeaning(detail: ReviewDraftDetail): boolean {
  return (detail.simplifiedChineseMeaning ?? "").trim() === "";
}

/** 审核工作台渲染决策动作集合（fail-closed）。 */
export function reviewActionSet(detail: ReviewDraftDetail): {
  canAccept: boolean;
  canAcceptWithEdits: boolean;
  canReject: boolean;
  forceMeaning: boolean;
} {
  const forceMeaning = requiresRealMeaning(detail);
  // 所有进入有效审核投影的草稿都可做出决策；含义为空时不能 plain accept，必须给真实含义。
  return {
    canAccept: !forceMeaning,
    canAcceptWithEdits: true,
    canReject: true,
    forceMeaning,
  };
}
