import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database, no real provider calls -- fakes the
// provider adapter and the usage-recording RPC directly. Proves the AI
// Configuration + Usage/Cost Tracking milestone's central execution
// wrapper (Part 20): timing, usage normalization, best-effort durable
// usage write, and that a usage-write failure never swallows a valid
// business result (Part 59).

const { AIProviderUnavailableErrorMock, instantiateProviderMock } = vi.hoisted(() => {
  class AIProviderUnavailableErrorMock extends Error {
    providerKey: string;
    constructor(providerKey: string) {
      super(`AI provider "${providerKey}" is not configured on this environment.`);
      this.name = "AIProviderUnavailableError";
      this.providerKey = providerKey;
    }
  }
  return { AIProviderUnavailableErrorMock, instantiateProviderMock: vi.fn() };
});
vi.mock("@/app/lib/ai/router/providerRegistry", () => ({
  instantiateProvider: instantiateProviderMock,
  AIProviderUnavailableError: AIProviderUnavailableErrorMock,
}));

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: () => ({ rpc: rpcMock }) }));

import { executeAITask } from "@/app/lib/ai/router/executeAITask";
import { AIProviderError } from "@/app/lib/ai/provider";

const FAKE_PROVIDER = { name: "gemini" } as never;

beforeEach(() => {
  instantiateProviderMock.mockReset().mockReturnValue(FAKE_PROVIDER);
  rpcMock.mockReset().mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("executeAITask -- success path", () => {
  it("returns the business result and records a SUCCESS usage event with normalized usage", async () => {
    const rawResponse = {
      responseId: "r-1",
      modelVersion: "gemini-3.6-flash-001",
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140, cachedContentTokenCount: null, thoughtsTokenCount: null },
    };

    const data = await executeAITask({
      organizationId: "org-1",
      task: "INVOICE_EXTRACTION",
      provider: "gemini",
      model: "gemini-3.6-flash",
      requestKey: "attempt-1",
      sourceType: "document_extraction",
      sourceId: "attempt-1",
      actorAppUserId: "user-1",
      run: async (_provider, model) => ({ data: { ok: true, model }, raw: rawResponse, model, provider: "gemini" }),
    });

    expect(data).toEqual({ ok: true, model: "gemini-3.6-flash" });
    expect(rpcMock).toHaveBeenCalledWith(
      "record_ai_usage_event",
      expect.objectContaining({
        p_organization_id: "org-1",
        p_task_key: "INVOICE_EXTRACTION",
        p_provider: "gemini",
        p_model: "gemini-3.6-flash",
        p_status: "SUCCESS",
        p_input_tokens: 100,
        p_output_tokens: 40,
        p_total_tokens: 140,
        p_cached_input_tokens: null,
        p_thoughts_tokens: null,
        p_error_code: null,
        p_source_type: "document_extraction",
        p_source_id: "attempt-1",
        p_actor_app_user_id: "user-1",
        p_request_key: "attempt-1",
      })
    );
  });

  it("normalizes to all-null usage (never zero) when the raw response carries no usageMetadata", async () => {
    await executeAITask({
      organizationId: "org-1",
      task: "ITEM_CLASSIFICATION",
      provider: "gemini",
      model: "gemini-3.6-flash",
      requestKey: "claim-1",
      run: async (provider, model) => ({ data: {}, raw: {}, model, provider: "gemini" }),
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "record_ai_usage_event",
      expect.objectContaining({ p_input_tokens: null, p_output_tokens: null, p_total_tokens: null, p_cached_input_tokens: null, p_thoughts_tokens: null })
    );
  });
});

describe("executeAITask -- failure path", () => {
  it("records a FAILED usage event with the provider error's code, then rethrows the ORIGINAL error", async () => {
    await expect(
      executeAITask({
        organizationId: "org-1",
        task: "INVOICE_EXTRACTION",
        provider: "gemini",
        model: "gemini-3.6-flash",
        requestKey: "attempt-2",
        run: async () => {
          throw new AIProviderError("PROVIDER_REQUEST_FAILED", "Gemini request failed: timeout");
        },
      })
    ).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });

    expect(rpcMock).toHaveBeenCalledWith(
      "record_ai_usage_event",
      expect.objectContaining({ p_status: "FAILED", p_error_code: "PROVIDER_REQUEST_FAILED", p_input_tokens: null, p_output_tokens: null })
    );
  });

  it("a usage-write RPC failure never swallows a successful business result", async () => {
    rpcMock.mockResolvedValue({ error: { message: "db unavailable" } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const data = await executeAITask({
      organizationId: "org-1",
      task: "INVOICE_EXTRACTION",
      provider: "gemini",
      model: "gemini-3.6-flash",
      requestKey: "attempt-3",
      run: async (provider, model) => ({ data: { extracted: true }, raw: {}, model, provider: "gemini" }),
    });

    expect(data).toEqual({ extracted: true });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("when the provider is not configured, no usage event is recorded at all -- there was no real attempt", async () => {
    instantiateProviderMock.mockImplementation(() => {
      throw new AIProviderUnavailableErrorMock("gemini");
    });

    await expect(
      executeAITask({
        organizationId: "org-1",
        task: "INVOICE_EXTRACTION",
        provider: "gemini",
        model: "gemini-3.6-flash",
        requestKey: "attempt-4",
        run: async (provider, model) => ({ data: {}, raw: {}, model, provider: "gemini" }),
      })
    ).rejects.toThrow(/not configured/);

    expect(rpcMock).not.toHaveBeenCalled();
  });
});
