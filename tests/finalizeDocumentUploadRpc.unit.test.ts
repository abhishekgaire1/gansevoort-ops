import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { finalizeDocumentUploadRpc, DocumentIdentityConflictError } from "@/app/lib/documents/finalizeDocumentUploadRpc";

// CI-safe: no network, no database -- fakes supabase.rpc() directly, same
// spirit as tests/stations.unit.test.ts's createFakeSupabase.

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const INPUT = {
  documentId: "doc-1",
  organizationId: "org-1",
  uploadedByAppUserId: "user-1",
  storagePath: "org/org-1/documents/doc-1/original.pdf",
  originalFilename: "invoice.pdf",
  contentType: "application/pdf",
  byteSize: 1024,
  fileSha256: "a".repeat(64),
  provider: "gemini",
  model: "gemini-3.6-flash",
};

describe("finalizeDocumentUploadRpc", () => {
  it("calls the finalize_document_upload RPC exactly once, with snake_case parameters -- one round trip for both rows", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ document_id: "doc-1", attempt_id: "attempt-1", replayed: false }], error: null });

    await finalizeDocumentUploadRpc(client, INPUT);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("finalize_document_upload", {
      p_document_id: "doc-1",
      p_organization_id: "org-1",
      p_uploaded_by_app_user_id: "user-1",
      p_storage_path: "org/org-1/documents/doc-1/original.pdf",
      p_original_filename: "invoice.pdf",
      p_content_type: "application/pdf",
      p_byte_size: 1024,
      p_file_sha256: "a".repeat(64),
      p_provider: "gemini",
      p_model: "gemini-3.6-flash",
    });
  });

  it("maps the returned row (array form) to camelCase, including attemptId and replayed", async () => {
    const { client } = fakeSupabase({ data: [{ document_id: "doc-1", attempt_id: "attempt-1", replayed: true }], error: null });
    const result = await finalizeDocumentUploadRpc(client, INPUT);
    expect(result).toEqual({ documentId: "doc-1", attemptId: "attempt-1", replayed: true });
  });

  it("throws DocumentIdentityConflictError for the app-defined GA001 conflict SQLSTATE", async () => {
    const { client } = fakeSupabase({
      data: null,
      error: { code: "GA001", message: "document_id doc-1 already exists with different file identity" },
    });
    await expect(finalizeDocumentUploadRpc(client, INPUT)).rejects.toBeInstanceOf(DocumentIdentityConflictError);
  });

  it("throws a generic Error (not DocumentIdentityConflictError) for any other RPC error code", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "23503", message: "boom" } });
    const failure = finalizeDocumentUploadRpc(client, INPUT);
    await expect(failure).rejects.toThrow(/finalize_document_upload failed/);
    await expect(failure).rejects.not.toBeInstanceOf(DocumentIdentityConflictError);
  });

  it("throws when the RPC returns no result row", async () => {
    const { client } = fakeSupabase({ data: [], error: null });
    await expect(finalizeDocumentUploadRpc(client, INPUT)).rejects.toThrow(/returned no result row/);
  });
});
