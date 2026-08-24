import { describe, expect, it } from "vitest";
import { AI_MODELS, findModel, isModelCompatibleWithTask, listEnabledModels } from "@/app/lib/ai/models";

// CI-safe: pure function/data, no network/DB. Proves the server-controlled
// model allowlist (Part 7-8) and task/model compatibility gate (Part 47).

describe("AI_MODELS -- the allowlist itself", () => {
  it("only contains model identifiers actually used in this codebase (Phase A inspection)", () => {
    const ids = AI_MODELS.map((m) => m.modelId).sort();
    expect(ids).toEqual(["gemini-3.5-flash-lite", "gemini-3.6-flash"]);
  });

  it("every listed model is Gemini -- no unsupported provider is ever offered", () => {
    expect(AI_MODELS.every((m) => m.provider === "gemini")).toBe(true);
  });
});

describe("findModel / listEnabledModels", () => {
  it("finds an allowlisted model", () => {
    expect(findModel("gemini", "gemini-3.6-flash")).not.toBeNull();
  });

  it("returns null for an arbitrary, non-allowlisted model string -- Admin cannot type a free-text model", () => {
    expect(findModel("gemini", "gemini-9000-ultra")).toBeNull();
  });

  it("returns null for a provider with no adapter at all", () => {
    expect(findModel("openai", "gpt-4o")).toBeNull();
  });

  it("listEnabledModels never returns a disabled model", () => {
    expect(listEnabledModels().every((m) => m.enabled)).toBe(true);
  });
});

describe("isModelCompatibleWithTask", () => {
  it("both current allowlisted models satisfy INVOICE_EXTRACTION (structured output + document support)", () => {
    expect(isModelCompatibleWithTask("gemini", "gemini-3.6-flash", "INVOICE_EXTRACTION")).toBe(true);
    expect(isModelCompatibleWithTask("gemini", "gemini-3.5-flash-lite", "INVOICE_EXTRACTION")).toBe(true);
  });

  it("both current allowlisted models satisfy ITEM_CLASSIFICATION (structured output only)", () => {
    expect(isModelCompatibleWithTask("gemini", "gemini-3.6-flash", "ITEM_CLASSIFICATION")).toBe(true);
    expect(isModelCompatibleWithTask("gemini", "gemini-3.5-flash-lite", "ITEM_CLASSIFICATION")).toBe(true);
  });

  it("rejects a model that isn't on the allowlist at all, regardless of task", () => {
    expect(isModelCompatibleWithTask("gemini", "gemini-9000-ultra", "ITEM_CLASSIFICATION")).toBe(false);
  });

  it("rejects an unsupported provider outright", () => {
    expect(isModelCompatibleWithTask("openai", "gpt-4o", "INVOICE_EXTRACTION")).toBe(false);
  });
});
