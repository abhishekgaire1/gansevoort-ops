import { describe, expect, it } from "vitest";
import { sanitizeGeminiRawResponse } from "@/app/lib/ai/providers/gemini";

// Stand-ins for the Gemini SDK's non-plain response shapes, mirroring
// tests/aiInvoiceExtractionAction.unit.test.ts's RICH_RAW_RESPONSE fixture
// -- this function is the broader, DB-persisted counterpart to
// extractGeminiDebugMetadata, so it needs the same "never trust a class
// instance" guarantee, over a wider field set.
class FakeSdkHttpResponse {
  status = 200;
}
class FakeUsageMetadata {
  promptTokenCount = 42;
  candidatesTokenCount = 7;
  totalTokenCount = 49;
  cachedContentTokenCount = 0;
  thoughtsTokenCount = 0;
  toolUsePromptTokenCount = 0;
  promptTokensDetails = [{ modality: "TEXT", tokenCount: 42 }];
}
class FakeCandidate {
  content = { parts: [{ text: "..." }] };
  finishReason = "STOP";
  safetyRatings = [{ category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" }];
}

const RICH_RAW_RESPONSE = {
  sdkHttpResponse: new FakeSdkHttpResponse(),
  candidates: [new FakeCandidate()],
  modelVersion: "gemini-3.6-flash-001",
  responseId: "resp-abc123",
  usageMetadata: new FakeUsageMetadata(),
  text: '{"vendorName":"Acme"}',
};

describe("sanitizeGeminiRawResponse", () => {
  it("returns null for null/non-object input", () => {
    expect(sanitizeGeminiRawResponse(null)).toBeNull();
    expect(sanitizeGeminiRawResponse(undefined)).toBeNull();
    expect(sanitizeGeminiRawResponse("not an object")).toBeNull();
  });

  it("picks only the allow-listed scalar fields and drops sdkHttpResponse entirely", () => {
    const sanitized = sanitizeGeminiRawResponse(RICH_RAW_RESPONSE);
    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toHaveProperty("sdkHttpResponse");
    expect(sanitized?.responseId).toBe("resp-abc123");
    expect(sanitized?.modelVersion).toBe("gemini-3.6-flash-001");
    expect(sanitized?.responseText).toBe('{"vendorName":"Acme"}');
  });

  it("captures the full usageMetadata, including modality-detail breakdowns", () => {
    const sanitized = sanitizeGeminiRawResponse(RICH_RAW_RESPONSE);
    expect(sanitized?.usageMetadata).toEqual({
      promptTokenCount: 42,
      candidatesTokenCount: 7,
      totalTokenCount: 49,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: 0,
      toolUsePromptTokenCount: 0,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 42 }],
      candidatesTokensDetails: null,
    });
  });

  it("captures per-candidate finishReason and a safety-ratings summary, dropping the content parts", () => {
    const sanitized = sanitizeGeminiRawResponse(RICH_RAW_RESPONSE);
    expect(sanitized?.candidates).toEqual([
      { finishReason: "STOP", safetyRatings: [{ category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" }] },
    ]);
    expect(sanitized?.candidates?.[0]).not.toHaveProperty("content");
  });

  it("the entire sanitized result is plain-serializable (round-trips through JSON with no special handling)", () => {
    const sanitized = sanitizeGeminiRawResponse(RICH_RAW_RESPONSE);
    expect(() => JSON.stringify(sanitized)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(sanitized));
    expect(roundTripped).toEqual(sanitized);
  });

  it("degrades gracefully when usageMetadata/candidates are absent", () => {
    expect(sanitizeGeminiRawResponse({ responseId: "r1", modelVersion: "m1" })).toEqual({
      responseId: "r1",
      modelVersion: "m1",
      responseText: null,
      usageMetadata: null,
      candidates: null,
    });
  });
});
