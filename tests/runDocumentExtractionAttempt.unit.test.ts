import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// CI-safe: no network, no database -- fakes the Supabase query builder
// chain (same spirit as tests/stations.unit.test.ts's createFakeSupabase,
// generalized into a Proxy since this module chains .update()/.eq()/
// .select()/.maybeSingle()/.single() in several different combinations
// across three separate `.from(...)` calls).

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { runInvoiceExtractionMock } = vi.hoisted(() => ({ runInvoiceExtractionMock: vi.fn() }));
vi.mock("@/app/lib/ai/tasks/invoiceExtraction/runInvoiceExtraction", () => ({ runInvoiceExtraction: runInvoiceExtractionMock }));

vi.mock("@/app/lib/ai/providers/gemini", async (importOriginal) => {
  // Spy, not stub: keeps the REAL sanitizeGeminiRawResponse (what the
  // SUCCEEDED-path test below exercises) while only replacing GeminiProvider
  // so no real SDK client is constructed. Same pattern as
  // tests/aiInvoiceExtractionAction.unit.test.ts.
  const actual = await importOriginal<typeof import("@/app/lib/ai/providers/gemini")>();
  return {
    ...actual,
    GeminiProvider: vi.fn().mockImplementation(function GeminiProviderMock() {
      return {};
    }),
  };
});

import { runDocumentExtractionAttempt } from "@/app/lib/documents/runDocumentExtractionAttempt";
import { AIProviderError } from "@/app/lib/ai/provider";

interface FakeResult {
  data: unknown;
  error: unknown;
}

function createChainable(result: FakeResult, updates: { table: string; payload: unknown }[], table: string): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (value: FakeResult) => void, reject?: (reason: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === "update") {
        return (payload: unknown) => {
          updates.push({ table, payload });
          return proxy;
        };
      }
      // .eq/.select/.maybeSingle/.single/.order/.limit/etc all just
      // continue the same chain, ultimately resolving to `result`.
      return () => proxy;
    },
  };
  const proxy: unknown = new Proxy(() => {}, handler);
  return proxy;
}

function buildFakeServiceClient(opts: { claimResult: FakeResult; documentResult?: FakeResult; downloadResult?: FakeResult }) {
  const updates: { table: string; payload: unknown }[] = [];
  let documentExtractionsCallCount = 0;

  const from = vi.fn((table: string) => {
    if (table === "document_extractions") {
      documentExtractionsCallCount += 1;
      const result: FakeResult = documentExtractionsCallCount === 1 ? opts.claimResult : { data: null, error: null };
      return createChainable(result, updates, table);
    }
    if (table === "documents") {
      return createChainable(opts.documentResult ?? { data: null, error: { message: "not found" } }, updates, table);
    }
    throw new Error(`unexpected table ${table}`);
  });

  const download = vi.fn().mockResolvedValue(opts.downloadResult ?? { data: null, error: { message: "not found" } });
  const storageFrom = vi.fn(() => ({ download }));

  return {
    client: { from, storage: { from: storageFrom } } as unknown as SupabaseClient,
    from,
    download,
    updates,
  };
}

function latestDocumentExtractionsUpdate(updates: { table: string; payload: unknown }[]) {
  const matches = updates.filter((entry) => entry.table === "document_extractions");
  return matches[matches.length - 1]?.payload as Record<string, unknown> | undefined;
}

beforeEach(() => {
  getServiceRoleClientMock.mockReset();
  runInvoiceExtractionMock.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe("runDocumentExtractionAttempt -- atomic claim", () => {
  it("does nothing when the claim finds no PENDING row (lost the race, already terminal, or missing)", async () => {
    const fake = buildFakeServiceClient({ claimResult: { data: null, error: null } });
    getServiceRoleClientMock.mockReturnValue(fake.client);

    await runDocumentExtractionAttempt("attempt-1");

    expect(fake.download).not.toHaveBeenCalled();
    expect(runInvoiceExtractionMock).not.toHaveBeenCalled();
    // Only the claim's own conditional UPDATE was attempted -- no
    // downstream document/extraction work happened.
    expect(fake.updates).toHaveLength(1);
  });

  it("also does nothing when the claim query itself errors", async () => {
    const fake = buildFakeServiceClient({ claimResult: { data: null, error: { message: "boom" } } });
    getServiceRoleClientMock.mockReturnValue(fake.client);

    await runDocumentExtractionAttempt("attempt-1");

    expect(fake.download).not.toHaveBeenCalled();
    expect(runInvoiceExtractionMock).not.toHaveBeenCalled();
  });
});

describe("runDocumentExtractionAttempt -- successful run", () => {
  it("downloads the document, runs extraction with the attempt's own model, and marks the attempt SUCCEEDED with sanitized provider metadata", async () => {
    const fake = buildFakeServiceClient({
      claimResult: {
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", model: "gemini-3.6-flash" },
        error: null,
      },
      documentResult: { data: { storage_path: "org/org-1/documents/doc-1/original.pdf" }, error: null },
      downloadResult: { data: { arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4\n").buffer }, error: null },
    });
    getServiceRoleClientMock.mockReturnValue(fake.client);

    runInvoiceExtractionMock.mockResolvedValue({
      normalized: {
        documentType: null,
        vendorName: "Acme",
        vendorAddress: null,
        vendorPhone: null,
        invoiceNumber: null,
        invoiceDate: null,
        deliveryDate: null,
        purchaseOrderNumber: null,
        subtotal: null,
        tax: null,
        fees: null,
        total: null,
        currency: null,
        lines: [],
        warnings: [],
      },
      issues: [],
      raw: { responseId: "resp-1", modelVersion: "gemini-3.6-flash-001", usageMetadata: { promptTokenCount: 1 } },
      model: "gemini-3.6-flash",
      provider: "gemini",
    });

    await runDocumentExtractionAttempt("attempt-1");

    expect(fake.download).toHaveBeenCalledWith("org/org-1/documents/doc-1/original.pdf");
    expect(runInvoiceExtractionMock).toHaveBeenCalledTimes(1);
    expect(runInvoiceExtractionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mimeType: "application/pdf" }),
      "gemini-3.6-flash"
    );

    const finalUpdate = latestDocumentExtractionsUpdate(fake.updates);
    expect(finalUpdate).toBeDefined();
    expect(finalUpdate?.status).toBe("SUCCEEDED");
    expect((finalUpdate?.provider_metadata as { responseId: string | null }).responseId).toBe("resp-1");
    expect((finalUpdate?.normalized_extraction as { vendorName: string | null }).vendorName).toBe("Acme");
  });
});

describe("runDocumentExtractionAttempt -- failed run", () => {
  it("marks the attempt FAILED with the provider's error code when extraction throws an AIProviderError", async () => {
    const fake = buildFakeServiceClient({
      claimResult: {
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", model: "gemini-3.6-flash" },
        error: null,
      },
      documentResult: { data: { storage_path: "org/org-1/documents/doc-1/original.pdf" }, error: null },
      downloadResult: { data: { arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4\n").buffer }, error: null },
    });
    getServiceRoleClientMock.mockReturnValue(fake.client);

    runInvoiceExtractionMock.mockRejectedValue(new AIProviderError("PROVIDER_REQUEST_FAILED", "Gemini request failed: boom"));

    await runDocumentExtractionAttempt("attempt-1");

    const finalUpdate = latestDocumentExtractionsUpdate(fake.updates);
    expect(finalUpdate).toBeDefined();
    expect(finalUpdate?.status).toBe("FAILED");
    expect(finalUpdate?.error_code).toBe("PROVIDER_REQUEST_FAILED");
    // The raw internal message is retained server-side for debugging --
    // never sanitized away at this layer (that happens at display time via
    // safeExtractionErrorMessage).
    expect(finalUpdate?.error_message).toContain("Gemini request failed");
  });

  it("marks the attempt FAILED with an UNKNOWN code for a non-AIProviderError failure (e.g. document/download errors)", async () => {
    const fake = buildFakeServiceClient({
      claimResult: {
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", model: "gemini-3.6-flash" },
        error: null,
      },
      documentResult: { data: null, error: { message: "not found" } },
    });
    getServiceRoleClientMock.mockReturnValue(fake.client);

    await runDocumentExtractionAttempt("attempt-1");

    expect(runInvoiceExtractionMock).not.toHaveBeenCalled();
    const finalUpdate = latestDocumentExtractionsUpdate(fake.updates);
    expect(finalUpdate?.status).toBe("FAILED");
    expect(finalUpdate?.error_code).toBe("UNKNOWN");
  });
});
