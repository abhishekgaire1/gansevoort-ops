import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// CI-safe: the @google/genai SDK is fully mocked -- no network call, no
// API key needed, no cost. Covers "provider failures produce a controlled
// typed failure" and "malformed Gemini output fails closed."

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  // A plain `function`, not an arrow function -- arrow functions can't be
  // invoked with `new`, which is exactly how GeminiProvider constructs
  // this client.
  GoogleGenAI: vi.fn().mockImplementation(function GoogleGenAIMock() {
    return { models: { generateContent: generateContentMock } };
  }),
}));

import { GeminiProvider } from "@/app/lib/ai/providers/gemini";
import { AIProviderError } from "@/app/lib/ai/provider";

const TestSchema = z.object({ foo: z.string().nullable() });

beforeEach(() => {
  generateContentMock.mockReset();
});

describe("GeminiProvider.generateStructuredOutput", () => {
  it("returns typed data on a well-formed, schema-conforming response", async () => {
    generateContentMock.mockResolvedValue({ text: JSON.stringify({ foo: "bar" }) });

    const provider = new GeminiProvider("test-key");
    const result = await provider.generateStructuredOutput({
      systemInstructions: "test",
      schema: TestSchema,
      parts: [{ type: "text", text: "hello" }],
    });

    expect(result.data).toEqual({ foo: "bar" });
    expect(result.provider).toBe("gemini");
  });

  it("throws a controlled AIProviderError (PROVIDER_REQUEST_FAILED), not a raw exception, when the SDK call rejects", async () => {
    generateContentMock.mockRejectedValue(new Error("network timeout"));

    const provider = new GeminiProvider("test-key");
    const call = provider.generateStructuredOutput({
      systemInstructions: "test",
      schema: TestSchema,
      parts: [{ type: "text", text: "hello" }],
    });

    await expect(call).rejects.toBeInstanceOf(AIProviderError);
    await expect(call).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
  });

  it("fails closed with EMPTY_RESPONSE when the SDK returns no text", async () => {
    generateContentMock.mockResolvedValue({ text: undefined });

    const provider = new GeminiProvider("test-key");
    const call = provider.generateStructuredOutput({
      systemInstructions: "test",
      schema: TestSchema,
      parts: [{ type: "text", text: "hello" }],
    });

    await expect(call).rejects.toMatchObject({ code: "EMPTY_RESPONSE" });
  });

  it("fails closed with INVALID_JSON when the response text is not valid JSON", async () => {
    generateContentMock.mockResolvedValue({ text: "not json at all {{{" });

    const provider = new GeminiProvider("test-key");
    const call = provider.generateStructuredOutput({
      systemInstructions: "test",
      schema: TestSchema,
      parts: [{ type: "text", text: "hello" }],
    });

    await expect(call).rejects.toMatchObject({ code: "INVALID_JSON" });
  });

  it("fails closed with SCHEMA_VALIDATION_FAILED when the response is valid JSON but doesn't match the schema -- never silently coerced", async () => {
    generateContentMock.mockResolvedValue({ text: JSON.stringify({ foo: 12345 /* should be string | null */ }) });

    const provider = new GeminiProvider("test-key");
    const call = provider.generateStructuredOutput({
      systemInstructions: "test",
      schema: TestSchema,
      parts: [{ type: "text", text: "hello" }],
    });

    await expect(call).rejects.toBeInstanceOf(AIProviderError);
    await expect(call).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("passes an explicit model override through to the SDK call instead of the configured default", async () => {
    generateContentMock.mockResolvedValue({ text: JSON.stringify({ foo: null }) });

    const provider = new GeminiProvider("test-key");
    await provider.generateStructuredOutput({
      systemInstructions: "test",
      schema: TestSchema,
      parts: [{ type: "text", text: "hello" }],
      model: "gemini-3.6-flash",
    });

    expect(generateContentMock).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-3.6-flash" }));
  });
});
