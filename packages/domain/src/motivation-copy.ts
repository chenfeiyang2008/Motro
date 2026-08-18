export const MOTIVATION_COPY_CATEGORIES = [
  "poetry_pun",
  "english_joke",
  "learning_wit",
  "encouragement",
] as const;

export type MotivationCopyCategory = (typeof MOTIVATION_COPY_CATEGORIES)[number];

export interface MotivationCopyInput {
  text: string;
  category: string;
  attribution?: string | null;
}

export interface MotivationCopyValidation {
  ok: boolean;
  value?: { text: string; category: MotivationCopyCategory; attribution: string | null };
  error?: string;
}

// Intentional plain-text safety guard: reject ASCII control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HTML_OR_URL = /<[^>]*>|(?:https?:\/\/|www\.)\S+/i;

export function validateMotivationCopy(input: MotivationCopyInput): MotivationCopyValidation {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, error: "激励文案不能为空" };
  if (text.length > 180) return { ok: false, error: "激励文案不能超过 180 个字符" };
  if (CONTROL_CHARS.test(text) || HTML_OR_URL.test(text)) {
    return { ok: false, error: "激励文案只能包含纯文本" };
  }
  if (!MOTIVATION_COPY_CATEGORIES.includes(input.category as MotivationCopyCategory)) {
    return { ok: false, error: "激励文案分类无效" };
  }
  const attribution = input.attribution?.trim() ?? null;
  if (attribution !== null) {
    if (attribution.length === 0) return { ok: false, error: "出处不能为空" };
    if (attribution.length > 80) return { ok: false, error: "出处不能超过 80 个字符" };
    if (CONTROL_CHARS.test(attribution) || HTML_OR_URL.test(attribution)) {
      return { ok: false, error: "出处只能包含纯文本" };
    }
  }
  return {
    ok: true,
    value: { text, category: input.category as MotivationCopyCategory, attribution },
  };
}
