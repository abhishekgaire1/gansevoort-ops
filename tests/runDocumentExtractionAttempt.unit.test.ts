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

interface FakeDocumentPage {
  out_page_number: number;
  out_storage_path: string;
  out_content_type: string;
}

function buildFakeServiceClient(opts: {
  claimResult: FakeResult;
  /** Defaults to a single page-1 row -- the overwhelming common case and
   * the only case every pre-100127 document/test needs. Pass more entries
   * to exercise the multi-page download path. */
  documentPages?: FakeDocumentPage[];
  listDocumentPagesError?: { message: string };
  downloadResult?: FakeResult;
  /** Keyed by storage_path -- lets a multi-page test return a distinct
   * download result per page. Falls back to `downloadResult` for any path
   * not present here. */
  downloadResultsByPath?: Record<string, FakeResult>;
}) {
  const updates: { table: string; payload: unknown }[] = [];
  let documentExtractionsCallCount = 0;

  const from = vi.fn((table: string) => {
    if (table === "document_extractions") {
      documentExtractionsCallCount += 1;
      const result: FakeResult = documentExtractionsCallCount === 1 ? opts.claimResult : { data: null, error: null };
      return createChainable(result, updates, table);
    }
    throw new Error(`unexpected table ${table}`);
  });

  const download = vi.fn((path: string) => {
    const byPath = opts.downloadResultsByPath?.[path];
    return Promise.resolve(byPath ?? opts.downloadResult ?? { data: null, error: { message: "not found" } });
  });
  const storageFrom = vi.fn(() => ({ download }));

  const defaultPages: FakeDocumentPage[] = [{ out_page_number: 1, out_storage_path: "org/org-1/documents/doc-1/original.pdf", out_content_type: "application/pdf" }];

  // AI Configuration + Usage/Cost Tracking milestone: executeAITask's
  // best-effort usage write also goes through .rpc() -- branch on the RPC
  // name so list_document_pages (this module's own multi-page lookup) and
  // the usage-write RPC never share one fixed response.
  const rpc = vi.fn((fnName: string) => {
    if (fnName === "list_document_pages") {
      if (opts.listDocumentPagesError) {
        return Promise.resolve({ data: null, error: opts.listDocumentPagesError });
      }
      return Promise.resolve({ data: opts.documentPages ?? defaultPages, error: null });
    }
    return Promise.resolve({ data: [{ out_event_id: "usage-event-1" }], error: null });
  });

  return {
    client: { from, storage: { from: storageFrom }, rpc } as unknown as SupabaseClient,
    from,
    download,
    rpc,
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
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", provider: "gemini", model: "gemini-3.6-flash" },
        error: null,
      },
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
      { files: [expect.objectContaining({ mimeType: "application/pdf" })] },
      "gemini-3.6-flash"
    );

    const finalUpdate = latestDocumentExtractionsUpdate(fake.updates);
    expect(finalUpdate).toBeDefined();
    expect(finalUpdate?.status).toBe("SUCCEEDED");
    expect((finalUpdate?.provider_metadata as { responseId: string | null }).responseId).toBe("resp-1");
    expect((finalUpdate?.normalized_extraction as { vendorName: string | null }).vendorName).toBe("Acme");
  });
});

describe("runDocumentExtractionAttempt -- multi-page capture (100127)", () => {
  it("downloads every page in order and passes all of them as one multi-file extraction call -- never one call per page", async () => {
    const fake = buildFakeServiceClient({
      claimResult: {
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", provider: "gemini", model: "gemini-3.6-flash" },
        error: null,
      },
      documentPages: [
        { out_page_number: 1, out_storage_path: "org/org-1/documents/doc-1/page-1.jpg", out_content_type: "image/jpeg" },
        { out_page_number: 2, out_storage_path: "org/org-1/documents/doc-1/page-2.jpg", out_content_type: "image/jpeg" },
        { out_page_number: 3, out_storage_path: "org/org-1/documents/doc-1/page-3.jpg", out_content_type: "image/jpeg" },
      ],
      downloadResultsByPath: {
        // Real JPEG magic bytes (0xFF 0xD8 0xFF) as raw bytes -- TextEncoder
        // would UTF-8-re-encode \xFF into two different bytes, which is not
        // what sniffMimeType checks for.
        "org/org-1/documents/doc-1/page-1.jpg": { data: { arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 1]).buffer }, error: null },
        "org/org-1/documents/doc-1/page-2.jpg": { data: { arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 2]).buffer }, error: null },
        "org/org-1/documents/doc-1/page-3.jpg": { data: { arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 3]).buffer }, error: null },
      },
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
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });

    await runDocumentExtractionAttempt("attempt-1");

    expect(fake.download).toHaveBeenCalledTimes(3);
    expect(fake.download).toHaveBeenNthCalledWith(1, "org/org-1/documents/doc-1/page-1.jpg");
    expect(fake.download).toHaveBeenNthCalledWith(2, "org/org-1/documents/doc-1/page-2.jpg");
    expect(fake.download).toHaveBeenNthCalledWith(3, "org/org-1/documents/doc-1/page-3.jpg");

    // Exactly ONE extraction call, carrying all 3 pages as separate files
    // in page order -- never 3 separate per-page extraction calls (which
    // would risk double-counting header fields/totals across pages).
    expect(runInvoiceExtractionMock).toHaveBeenCalledTimes(1);
    const [, extractInput] = runInvoiceExtractionMock.mock.calls[0] as [unknown, { files: { mimeType: string }[] }];
    expect(extractInput.files).toHaveLength(3);
    expect(extractInput.files.every((f) => f.mimeType === "image/jpeg")).toBe(true);
  });

  it("a single-page document (the pre-100127 default) still passes exactly one file -- unchanged behavior", async () => {
    const fake = buildFakeServiceClient({
      claimResult: {
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", provider: "gemini", model: "gemini-3.6-flash" },
        error: null,
      },
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
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });

    await runDocumentExtractionAttempt("attempt-1");

    expect(fake.download).toHaveBeenCalledTimes(1);
    const [, extractInput] = runInvoiceExtractionMock.mock.calls[0] as [unknown, { files: unknown[] }];
    expect(extractInput.files).toHaveLength(1);
  });
});

describe("runDocumentExtractionAttempt -- failed run", () => {
  it("marks the attempt FAILED with the provider's error code when extraction throws an AIProviderError", async () => {
    const fake = buildFakeServiceClient({
      claimResult: {
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", provider: "gemini", model: "gemini-3.6-flash" },
        error: null,
      },
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
        data: { id: "attempt-1", organization_id: "org-1", document_id: "doc-1", provider: "gemini", model: "gemini-3.6-flash" },
        error: null,
      },
      documentPages: [],
    });
    getServiceRoleClientMock.mockReturnValue(fake.client);

    await runDocumentExtractionAttempt("attempt-1");

    expect(runInvoiceExtractionMock).not.toHaveBeenCalled();
    const finalUpdate = latestDocumentExtractionsUpdate(fake.updates);
    expect(finalUpdate?.status).toBe("FAILED");
    expect(finalUpdate?.error_code).toBe("UNKNOWN");
  });
});
