import { describe, expect, it } from "vitest";
import { normalizeProviderUsage, UNKNOWN_USAGE } from "@/app/lib/ai/router/normalizeUsage";

// CI-safe: pure function, no network/DB.

describe("normalizeProviderUsage", () => {
  it("extracts Gemini's usageMetadata into the common shape", () => {
    const raw = {
      usageMetadata: {
        promptTokenCount: 250,
        candidatesTokenCount: 80,
        totalTokenCount: 330,
        cachedContentTokenCount: 10,
        thoughtsTokenCount: 5,
      },
    };
    expect(normalizeProviderUsage("gemini", raw)).toEqual({
      inputTokens: 250,
      outputTokens: 80,
      totalTokens: 330,
      cachedInputTokens: 10,
      thoughtsTokens: 5,
    });
  });

  it("returns all-null (never zero) when Gemini's response carries no usageMetadata", () => {
    expect(normalizeProviderUsage("gemini", {})).toEqual(UNKNOWN_USAGE);
    expect(normalizeProviderUsage("gemini", null)).toEqual(UNKNOWN_USAGE);
  });

  it("returns all-null for a provider with no normalizer implemented", () => {
    expect(normalizeProviderUsage("openai", { usageMetadata: { promptTokenCount: 10 } })).toEqual(UNKNOWN_USAGE);
  });
});
