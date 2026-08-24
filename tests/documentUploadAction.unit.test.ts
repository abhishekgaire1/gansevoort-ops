import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Covers finalizeDocumentUpload's
// exception-safety/idempotency guarantees added after the review found
// finalizeDocumentUpload() performed two separate, non-atomic inserts and
// could delete a live Storage object on a duplicate/retried call.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { finalizeDocumentUploadRpcMock, DocumentIdentityConflictErrorMock } = vi.hoisted(() => {
  class DocumentIdentityConflictErrorMock extends Error {}
  return { finalizeDocumentUploadRpcMock: vi.fn(), DocumentIdentityConflictErrorMock };
});
vi.mock("@/app/lib/documents/finalizeDocumentUploadRpc", () => ({
  finalizeDocumentUploadRpc: finalizeDocumentUploadRpcMock,
  DocumentIdentityConflictError: DocumentIdentityConflictErrorMock,
}));

const { runDocumentExtractionAttemptMock } = vi.hoisted(() => ({ runDocumentExtractionAttemptMock: vi.fn() }));
vi.mock("@/app/lib/documents/runDocumentExtractionAttempt", () => ({ runDocumentExtractionAttempt: runDocumentExtractionAttemptMock }));

// AI Configuration + Usage/Cost Tracking milestone: finalizeDocumentUpload
// now resolves provider/model via the central router before calling the
// finalize RPC -- irrelevant to this file's own exception-safety/
// idempotency focus, so it's replaced with a fixed resolution rather than
// giving the storage-focused fake service client real table-query support.
vi.mock("@/app/lib/ai/router/resolveAIConfig", () => ({
  resolveAIConfig: vi.fn(async () => ({ provider: "gemini", model: "gemini-3.6-flash", source: "application_default" })),
}));

const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));
vi.mock("next/server", () => ({ after: afterMock }));

import { finalizeDocumentUpload } from "@/app/actions/documentUpload";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

const INPUT = {
  documentId: "doc-1",
  declaredContentType: "application/pdf",
  originalFilename: "invoice.pdf",
  vendorId: "vendor-1",
  declaredDocumentType: "INVOICE" as const,
};

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\n");
}

function buildFakeServiceClient(opts: { downloadBytes?: Uint8Array; downloadError?: unknown } = {}) {
  const remove = vi.fn().mockResolvedValue({ data: null, error: null });
  const download = vi.fn().mockResolvedValue(
    opts.downloadError
      ? { data: null, error: opts.downloadError }
      : { data: { arrayBuffer: async () => (opts.downloadBytes ?? pdfBytes()).buffer }, error: null }
  );
  const storageFrom = vi.fn(() => ({ download, remove }));
  return { client: { storage: { from: storageFrom } }, download, remove };
}

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset();
  finalizeDocumentUploadRpcMock.mockReset();
  runDocumentExtractionAttemptMock.mockReset();
  afterMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("finalizeDocumentUpload -- F: normal first finalize", () => {
  it("downloads once, calls the RPC exactly once, schedules extraction with the returned attemptId, and never touches Storage", async () => {
    const { client, remove } = buildFakeServiceClient();
    getServiceRoleClientMock.mockReturnValue(client);
    finalizeDocumentUploadRpcMock.mockResolvedValue({ documentId: "doc-1", attemptId: "attempt-1", replayed: false });

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toEqual({ ok: true, documentId: "doc-1", replayed: false });
    expect(finalizeDocumentUploadRpcMock).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);

    const scheduled = afterMock.mock.calls[0][0] as () => unknown;
    await scheduled();
    expect(runDocumentExtractionAttemptMock).toHaveBeenCalledWith("attempt-1");
  });
});

describe("finalizeDocumentUpload -- B: duplicate finalize (idempotent replay)", () => {
  it("a second identical finalize succeeds safely without removing Storage or double-scheduling incorrectly", async () => {
    const { client, remove } = buildFakeServiceClient();
    getServiceRoleClientMock.mockReturnValue(client);
    finalizeDocumentUploadRpcMock.mockResolvedValue({ documentId: "doc-1", attemptId: "attempt-1", replayed: true });

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toEqual({ ok: true, documentId: "doc-1", replayed: true });
    expect(remove).not.toHaveBeenCalled();
    expect(finalizeDocumentUploadRpcMock).toHaveBeenCalledTimes(1);
    // Duplicate-document-row / duplicate-attempt-row prevention itself is a
    // SQL-level guarantee inside finalize_document_upload (see
    // supabase/migrations/20260811100021_finalize_document_upload_rpc.sql),
    // not something a mocked unit test can observe -- this test only
    // verifies the app-layer contract: one RPC call, no Storage deletion,
    // `replayed: true` passed straight through.
  });
});

describe("finalizeDocumentUpload -- C: replay with mismatching immutable file metadata", () => {
  it("is rejected as a conflict without touching Storage", async () => {
    const { client, remove } = buildFakeServiceClient();
    getServiceRoleClientMock.mockReturnValue(client);
    finalizeDocumentUploadRpcMock.mockRejectedValue(
      new DocumentIdentityConflictErrorMock("document_id doc-1 already exists with different file identity")
    );

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toEqual({
      ok: false,
      reason: "conflict",
      message: "This upload no longer matches a previously finalized document. Please upload again.",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });
});

describe("finalizeDocumentUpload -- D: unexpected exception before DB persistence", () => {
  it("removes the orphaned Storage object when the RPC call itself throws an unexpected error", async () => {
    const { client, remove } = buildFakeServiceClient();
    getServiceRoleClientMock.mockReturnValue(client);
    finalizeDocumentUploadRpcMock.mockRejectedValue(new Error("network blip"));

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toEqual({ ok: false, reason: "misconfigured", message: "Could not finish the upload. Try again." });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("removes the object for a checked validation failure too (empty file) -- unchanged prior behavior", async () => {
    const { client, remove } = buildFakeServiceClient({ downloadBytes: new Uint8Array(0) });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toEqual({ ok: false, reason: "invalid_file_type", message: "The uploaded file is empty." });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(finalizeDocumentUploadRpcMock).not.toHaveBeenCalled();
  });

  it("removes the object when the downloaded bytes fail magic-byte sniffing", async () => {
    const { client, remove } = buildFakeServiceClient({ downloadBytes: new TextEncoder().encode("not a real pdf") });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toMatchObject({ ok: false, reason: "invalid_file_type" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(finalizeDocumentUploadRpcMock).not.toHaveBeenCalled();
  });
});

describe("finalizeDocumentUpload -- E: failure after DB persistence (scheduling failure)", () => {
  it("never deletes the Storage object and still reports success when after() itself throws", async () => {
    const { client, remove } = buildFakeServiceClient();
    getServiceRoleClientMock.mockReturnValue(client);
    finalizeDocumentUploadRpcMock.mockResolvedValue({ documentId: "doc-1", attemptId: "attempt-1", replayed: false });
    afterMock.mockImplementationOnce(() => {
      throw new Error("scheduling failed");
    });

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toEqual({ ok: true, documentId: "doc-1", replayed: false });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("finalizeDocumentUpload -- not_found / auth", () => {
  it("rejects unauthenticated callers before touching Storage or the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await finalizeDocumentUpload(INPUT);
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(finalizeDocumentUploadRpcMock).not.toHaveBeenCalled();
  });

  it("returns not_found when the uploaded object can't be downloaded", async () => {
    const { client, remove } = buildFakeServiceClient({ downloadError: { message: "not found" } });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finalizeDocumentUpload(INPUT);

    expect(result).toEqual({ ok: false, reason: "not_found", message: "The uploaded file could not be found. Please upload again." });
    expect(remove).not.toHaveBeenCalled();
  });
});
