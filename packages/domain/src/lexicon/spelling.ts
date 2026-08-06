// 词条拼写规范：输入校验与查询规范化（纯领域规则，无副作用）。
// 规范化只辅助查询/去重，不改变展示拼写；不无条件按小写合并同形异义词。

export const CANONICAL_SPELLING_MAX = 128;
export const PRONUNCIATION_MAX = 100;
export const SENSE_MEANING_MAX = 500;
export const SENSE_EXAMPLE_MAX = 500;
export const MAX_SENSES = 20;
export const SOURCE_NOTE_MAX = 500;

export const PART_OF_SPEECH_VALUES = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "pronoun",
  "preposition",
  "conjunction",
  "interjection",
  "determiner",
  "article",
  "numeral",
  "particle",
  "phrase",
  "abbreviation",
  "prefix",
  "suffix",
] as const;
export type PartOfSpeech = (typeof PART_OF_SPEECH_VALUES)[number];

/** 查询规范化：外层 trim、压缩内部空白、Unicode NFKC、小写。 */
export function normalizeSpelling(input: string): string {
  return input.trim().replace(/\s+/g, " ").normalize("NFKC").toLowerCase();
}

export function validateCanonicalSpelling(input: string): string[] {
  const errors: string[] = [];
  const trimmed = input.trim();
  if (trimmed.length === 0) errors.push("拼写不能为空");
  if (trimmed.length > CANONICAL_SPELLING_MAX) {
    errors.push(`拼写不能超过 ${CANONICAL_SPELLING_MAX} 个字符`);
  }
  if (!/[A-Za-z]/.test(trimmed)) errors.push("拼写必须包含至少一个英文字母");
  // 控制字符会破坏可读性/审计摘要，一律拒绝（码点检查，避免 no-control-regex）。
  const hasControl = Array.from(trimmed).some(
    (c) => c.codePointAt(0) !== undefined && (c.codePointAt(0)! < 32 || c.codePointAt(0)! === 127),
  );
  if (hasControl) errors.push("拼写包含不可见控制字符");
  return errors;
}

export function validatePartOfSpeech(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return PART_OF_SPEECH_VALUES.includes(value.trim() as PartOfSpeech)
    ? []
    : [`词性不合法：${value.trim()}`];
}

export function validatePronunciation(value: string | undefined): string[] {
  if (value === undefined) return [];
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  return trimmed.length <= PRONUNCIATION_MAX
    ? []
    : [`发音标注不能超过 ${PRONUNCIATION_MAX} 个字符`];
}

export interface SenseInput {
  meaning: string;
  example?: string;
}

export function validateSenses(senses: SenseInput[] | undefined): string[] {
  if (senses === undefined || senses.length === 0) return [];
  const errors: string[] = [];
  if (senses.length > MAX_SENSES) errors.push(`释义最多 ${MAX_SENSES} 条`);
  senses.forEach((sense, i) => {
    const meaning = sense.meaning?.trim() ?? "";
    if (meaning.length === 0) errors.push(`第 ${i + 1} 条释义不能为空`);
    if (meaning.length > SENSE_MEANING_MAX) errors.push(`第 ${i + 1} 条释义过长`);
    if (sense.example !== undefined && sense.example.length > SENSE_EXAMPLE_MAX) {
      errors.push(`第 ${i + 1} 条例句过长`);
    }
  });
  return errors;
}

export function validateSourceNote(note: string | undefined): string[] {
  if (note === undefined) return [];
  const trimmed = note.trim();
  if (trimmed.length === 0) return [];
  return trimmed.length <= SOURCE_NOTE_MAX ? [] : [`来源说明不能超过 ${SOURCE_NOTE_MAX} 个字符`];
}
