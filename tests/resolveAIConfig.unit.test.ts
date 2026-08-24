import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database -- fakes supabase.from() directly.
// Proves the AI Configuration milestone's precedence chain (Part 11-12):
// task override -> organization default -> application default.

vi.mock("@/app/lib/ai/config", () => ({ resolveGeminiModel: () => "gemini-3.6-flash" }));

import { resolveAIConfig, resolveAIApplicationDefault } from "@/app/lib/ai/router/resolveAIConfig";

function fakeClient(opts: { taskOverride?: { provider: string; model: string } | null; orgDefault?: { provider: string; model: string } | null }) {
  const from = vi.fn((table: string) => {
    if (table === "organization_ai_task_settings") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.taskOverride ? { provider: opts.taskOverride.provider, model: opts.taskOverride.model } : null }),
            }),
          }),
        }),
      };
    }
    if (table === "organization_ai_settings") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: opts.orgDefault ? { default_provider: opts.orgDefault.provider, default_model: opts.orgDefault.model } : null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { from };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveAIConfig -- precedence", () => {
  it("1. a task override, when present, always wins", async () => {
    const client = fakeClient({ taskOverride: { provider: "gemini", model: "gemini-3.5-flash-lite" }, orgDefault: { provider: "gemini", model: "gemini-3.6-flash" } });
    const result = await resolveAIConfig(client as never, "org-1", "INVOICE_EXTRACTION");
    expect(result).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite", source: "task_override" });
  });

  it("2. no task override -> falls back to the organization default", async () => {
    const client = fakeClient({ taskOverride: null, orgDefault: { provider: "gemini", model: "gemini-3.6-flash" } });
    const result = await resolveAIConfig(client as never, "org-1", "INVOICE_EXTRACTION");
    expect(result).toEqual({ provider: "gemini", model: "gemini-3.6-flash", source: "organization_default" });
  });

  it("3. neither task override nor organization default -> falls back to the safe application default", async () => {
    const client = fakeClient({ taskOverride: null, orgDefault: null });
    const result = await resolveAIConfig(client as never, "org-1", "ITEM_CLASSIFICATION");
    expect(result).toEqual({ provider: "gemini", model: "gemini-3.6-flash", source: "application_default" });
  });

  it("resolveAIApplicationDefault matches the env-driven default directly", () => {
    expect(resolveAIApplicationDefault()).toEqual({ provider: "gemini", model: "gemini-3.6-flash", source: "application_default" });
  });
});
