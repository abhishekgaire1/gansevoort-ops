import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceExtractionResult } from "@/app/lib/ai/tasks/invoiceExtraction/types";

// CI-safe: no network, no AI call. Covers the application-level 20MB
// upload limit (app/actions/aiInvoiceExtraction.ts) -- independent of, and
// not relying on, next.config.ts's serverActions.bodySizeLimit transport
// setting, which isn't something a vitest unit test can exercise anyway.

// vi.mock(...) factories are hoisted above regular top-level declarations,
// so the mock fn referenced inside must itself be created via vi.hoisted.
const { runInvoiceExtractionMock } = vi.hoisted(() => ({ runInvoiceExtractionMock: vi.fn() }));

vi.mock("@/app/lib/ai/tasks/invoiceExtraction/runInvoiceExtraction", () => ({
  runInvoiceExtraction: runInvoiceExtractionMock,
}));

vi.mock("@/app/lib/ai/providers/gemini", async (importOriginal) => {
  // Spy, not stub: keeps the REAL extractGeminiDebugMetadata (exactly what
  // the serialization-boundary tests below need to exercise) while only
  // replacing GeminiProvider so no real SDK client is constructed.
  const actual = await importOriginal<typeof import("@/app/lib/ai/providers/gemini")>();
  return {
    ...actual,
    // A plain `function`, not an arrow function -- the action constructs
    // this with `new`.
    GeminiProvider: vi.fn().mockImplementation(function GeminiProviderMock() {
      return {};
    }),
  };
});

import { extractInvoiceFromUpload } from "@/app/actions/aiInvoiceExtraction";

const TWENTY_MB = 20 * 1024 * 1024;

const FAKE_RESULT: InvoiceExtractionResult = {
  normalized: {
    documentType: null,
    vendorName: null,
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
    amountDue: null,
    currency: null,
    lines: [],
    warnings: [],
  },
  issues: [],
  raw: null,
  model: "gemini-3.5-flash-lite",
  provider: "gemini",
};

/** A buffer of exactly `size` bytes, starting with a real %PDF- signature
 * so it passes magic-byte validation regardless of size. */
function pdfBytesOfSize(size: number): Buffer {
  const header = Buffer.from("%PDF-1.4\n");
  const buffer = Buffer.alloc(size);
  header.copy(buffer);
  return buffer;
}

function formDataWithFile(bytes: Buffer, filename = "invoice.pdf", type = "application/pdf"): FormData {
  const formData = new FormData();
  // Buffer isn't directly assignable to BlobPart (ArrayBufferLike vs.
  // ArrayBuffer generic mismatch) -- a plain Uint8Array copy sidesteps it.
  formData.set("file", new File([new Uint8Array(bytes)], filename, { type }));
  return formData;
}

let originalApiKey: string | undefined;

beforeEach(() => {
  runInvoiceExtractionMock.mockReset();
  runInvoiceExtractionMock.mockResolvedValue(FAKE_RESULT);
  originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  process.env.GEMINI_API_KEY = originalApiKey;
});

describe("extractInvoiceFromUpload -- 20MB application-level file-size limit", () => {
  it("rejects a file one byte over 20MB with a controlled file_too_large error, without attempting extraction", async () => {
    const formData = formDataWithFile(pdfBytesOfSize(TWENTY_MB + 1));

    const result = await extractInvoiceFromUpload(formData);

    expect(result).toEqual({ ok: false, reason: "file_too_large", message: "Invoice files must be 20 MB or smaller." });
    expect(runInvoiceExtractionMock).not.toHaveBeenCalled();
  });

  it("rejects a file comfortably over 20MB", async () => {
    const formData = formDataWithFile(pdfBytesOfSize(25 * 1024 * 1024));

    const result = await extractInvoiceFromUpload(formData);

    expect(result).toMatchObject({ ok: false, reason: "file_too_large" });
    expect(runInvoiceExtractionMock).not.toHaveBeenCalled();
  });

  it("does not reject a file exactly at the 20MB boundary for size", async () => {
    const formData = formDataWithFile(pdfBytesOfSize(TWENTY_MB));

    const result = await extractInvoiceFromUpload(formData);

    expect(result.ok).toBe(true);
    expect(runInvoiceExtractionMock).toHaveBeenCalledTimes(1);
  });

  it("does not reject a small file for size (e.g. a typical phone photo just over 1MB, which previously failed at the transport layer)", async () => {
    const formData = formDataWithFile(pdfBytesOfSize(1.5 * 1024 * 1024));

    const result = await extractInvoiceFromUpload(formData);

    expect(result.ok).toBe(true);
  });
});

// Stand-ins for the Gemini SDK's non-plain response shapes -- a real
// GenerateContentResponse and its nested GenerateContentResponseUsageMetadata
// are class instances (see app/lib/ai/providers/gemini.ts's comment); a
// class instance built here reproduces the same "not a plain object"
// problem without depending on the real @google/genai types.
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
}
class FakeCandidate {
  content = { parts: [{ text: "..." }] };
}

const RICH_RAW_RESPONSE = {
  sdkHttpResponse: new FakeSdkHttpResponse(),
  candidates: [new FakeCandidate()],
  modelVersion: "gemini-3.5-flash-lite-001",
  responseId: "resp-abc123",
  usageMetadata: new FakeUsageMetadata(),
};

/** Recursively asserts every object in `value` is a plain object, a plain
 * array, or a primitive/null -- i.e. exactly what React's Server Action
 * boundary requires ("Only plain objects, and a few built-ins... Classes
 * or null prototypes are not supported"). */
function assertPlainSerializable(value: unknown, path = "root"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainSerializable(item, `${path}[${index}]`));
    return;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} is not a plain object (prototype: ${(prototype as { constructor?: { name?: string } })?.constructor?.name ?? String(prototype)})`);
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    assertPlainSerializable(nested, `${path}.${key}`);
  }
}

describe("extractInvoiceFromUpload -- client DTO serialization boundary", () => {
  it("never returns the raw Gemini SDK response, its sdkHttpResponse handle, or its candidates array", async () => {
    runInvoiceExtractionMock.mockResolvedValue({ ...FAKE_RESULT, raw: RICH_RAW_RESPONSE });

    const formData = formDataWithFile(pdfBytesOfSize(1024));
    const result = await extractInvoiceFromUpload(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result).not.toHaveProperty("raw");
    expect(result.result).not.toHaveProperty("rawResponse");
    expect(result.result).not.toHaveProperty("sdkHttpResponse");
    expect(result.result).not.toHaveProperty("candidates");
    expect(Object.keys(result.result).sort()).toEqual(["debugMetadata", "issues", "model", "normalized", "provider"]);
  });

  it("maps only scalar usageMetadata/responseId/modelVersion fields into debugMetadata -- no class instances anywhere in the returned DTO", async () => {
    runInvoiceExtractionMock.mockResolvedValue({ ...FAKE_RESULT, raw: RICH_RAW_RESPONSE });

    const formData = formDataWithFile(pdfBytesOfSize(1024));
    const result = await extractInvoiceFromUpload(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.debugMetadata).toEqual({
      responseId: "resp-abc123",
      modelVersion: "gemini-3.5-flash-lite-001",
      usageMetadata: {
        promptTokenCount: 42,
        candidatesTokenCount: 7,
        totalTokenCount: 49,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
        toolUsePromptTokenCount: 0,
      },
    });

    // The whole returned DTO -- not just debugMetadata -- must be plain,
    // and must round-trip through JSON without special handling.
    assertPlainSerializable(result.result);
    expect(() => JSON.stringify(result.result)).not.toThrow();
  });

  it("returns a plain-serializable DTO even when the raw response has no usageMetadata at all", async () => {
    runInvoiceExtractionMock.mockResolvedValue({ ...FAKE_RESULT, raw: { responseId: "r1", modelVersion: "m1" } });

    const formData = formDataWithFile(pdfBytesOfSize(1024));
    const result = await extractInvoiceFromUpload(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.debugMetadata).toEqual({ responseId: "r1", modelVersion: "m1", usageMetadata: null });
    assertPlainSerializable(result.result);
  });
});

describe("extractInvoiceFromUpload -- other upload validation, unaffected by the size-limit fix", () => {
  it("rejects when no file is present", async () => {
    const result = await extractInvoiceFromUpload(new FormData());
    expect(result).toEqual({ ok: false, reason: "invalid_file_type", message: "No file was uploaded." });
  });

  it("rejects an empty (zero-byte) file", async () => {
    const formData = formDataWithFile(Buffer.alloc(0));
    const result = await extractInvoiceFromUpload(formData);
    expect(result).toEqual({ ok: false, reason: "invalid_file_type", message: "The uploaded file is empty." });
  });

  it("rejects a file under the size limit whose content doesn't match an accepted MIME signature", async () => {
    const formData = formDataWithFile(Buffer.from("not a real pdf/jpeg/png"), "fake.pdf", "application/pdf");
    const result = await extractInvoiceFromUpload(formData);
    expect(result).toMatchObject({ ok: false, reason: "invalid_file_type" });
    expect(runInvoiceExtractionMock).not.toHaveBeenCalled();
  });
});
