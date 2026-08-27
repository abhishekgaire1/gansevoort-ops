import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDocumentPageRpc, DocumentPageIdentityConflictError } from "@/app/lib/documents/addDocumentPageRpc";
import { listDocumentPagesRpc } from "@/app/lib/documents/listDocumentPagesRpc";

// CI-safe: no network, no database -- fakes supabase.rpc() directly, same
// spirit as tests/finalizeDocumentUploadRpc.unit.test.ts.

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const ADD_PAGE_INPUT = {
  organizationId: "org-1",
  documentId: "doc-1",
  appUserId: "user-1",
  pageNumber: 2,
  storagePath: "org/org-1/documents/doc-1/page-2.jpg",
  contentType: "image/jpeg",
  byteSize: 2048,
  fileSha256: "b".repeat(64),
};

describe("addDocumentPageRpc", () => {
  it("calls add_document_page with snake_case parameters", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_page_id: "page-2", out_replayed: false }], error: null });

    await addDocumentPageRpc(client, ADD_PAGE_INPUT);

    expect(rpc).toHaveBeenCalledWith("add_document_page", {
      p_organization_id: "org-1",
      p_document_id: "doc-1",
      p_app_user_id: "user-1",
      p_page_number: 2,
      p_storage_path: "org/org-1/documents/doc-1/page-2.jpg",
      p_content_type: "image/jpeg",
      p_byte_size: 2048,
      p_file_sha256: "b".repeat(64),
    });
  });

  it("maps the returned row to camelCase, including the replayed flag", async () => {
    const { client } = fakeSupabase({ data: [{ out_page_id: "page-2", out_replayed: true }], error: null });
    const result = await addDocumentPageRpc(client, ADD_PAGE_INPUT);
    expect(result).toEqual({ pageId: "page-2", replayed: true });
  });

  it("throws DocumentPageIdentityConflictError for the app-defined GA070 conflict SQLSTATE", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA070", message: "document doc-1 page 2 already exists with different file identity" } });
    await expect(addDocumentPageRpc(client, ADD_PAGE_INPUT)).rejects.toBeInstanceOf(DocumentPageIdentityConflictError);
  });

  it("surfaces a plain Error carrying the RPC's own message for the GA069 sequence/limit SQLSTATE", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA069", message: "document doc-1 page 2 must be added in sequence (next expected page: 1)" } });
    await expect(addDocumentPageRpc(client, ADD_PAGE_INPUT)).rejects.toThrow(/next expected page: 1/);
  });

  it("throws a generic error for an unrecognized failure", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "23505", message: "internal detail" } });
    await expect(addDocumentPageRpc(client, ADD_PAGE_INPUT)).rejects.toThrow(/add_document_page failed/);
  });
});

describe("listDocumentPagesRpc", () => {
  it("calls list_document_pages with organization/document scoping and maps rows to camelCase, in order", async () => {
    const { client, rpc } = fakeSupabase({
      data: [
        { out_page_number: 1, out_storage_path: "org/org-1/documents/doc-1/original.pdf", out_content_type: "application/pdf" },
        { out_page_number: 2, out_storage_path: "org/org-1/documents/doc-1/page-2.jpg", out_content_type: "image/jpeg" },
      ],
      error: null,
    });

    const pages = await listDocumentPagesRpc(client, "org-1", "doc-1");

    expect(rpc).toHaveBeenCalledWith("list_document_pages", { p_organization_id: "org-1", p_document_id: "doc-1" });
    expect(pages).toEqual([
      { pageNumber: 1, storagePath: "org/org-1/documents/doc-1/original.pdf", contentType: "application/pdf" },
      { pageNumber: 2, storagePath: "org/org-1/documents/doc-1/page-2.jpg", contentType: "image/jpeg" },
    ]);
  });

  it("existing single-page records render as exactly one page (Page 1) -- the pre-100127 default", async () => {
    const { client } = fakeSupabase({
      data: [{ out_page_number: 1, out_storage_path: "org/org-1/documents/doc-1/original.pdf", out_content_type: "application/pdf" }],
      error: null,
    });

    const pages = await listDocumentPagesRpc(client, "org-1", "doc-1");

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({ pageNumber: 1, storagePath: "org/org-1/documents/doc-1/original.pdf", contentType: "application/pdf" });
  });

  it("throws on an RPC error rather than silently returning an empty list", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "boom" } });
    await expect(listDocumentPagesRpc(client, "org-1", "doc-1")).rejects.toThrow(/list_document_pages failed/);
  });
});
