import { describe, expect, it } from "vitest";
import { MOTIVATION_COPY_CATEGORIES, validateMotivationCopy } from "@motro/domain";

describe("home motivation copy rules", () => {
  it("accepts bounded plain text in every category", () => {
    for (const category of MOTIVATION_COPY_CATEGORIES) {
      const result = validateMotivationCopy({
        text: "来学两个单词先。",
        category,
        attribution: "Motro",
      });
      expect(result.ok).toBe(true);
    }
  });
  it("trims valid input and rejects unsafe or oversized content", () => {
    expect(
      validateMotivationCopy({ text: "  先学一点。 ", category: "encouragement" }).value?.text,
    ).toBe("先学一点。");
    expect(validateMotivationCopy({ text: "<b>学习</b>", category: "encouragement" }).ok).toBe(
      false,
    );
    expect(
      validateMotivationCopy({ text: "看 https://example.com", category: "encouragement" }).ok,
    ).toBe(false);
    expect(validateMotivationCopy({ text: "x".repeat(181), category: "encouragement" }).ok).toBe(
      false,
    );
    expect(validateMotivationCopy({ text: "学习", category: "unknown" }).ok).toBe(false);
  });
});
