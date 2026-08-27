import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Typed wrapper around the list_document_pages RPC (see
 * supabase/migrations/20260811100127_multi_page_documents.sql) -- the
 * ordered, organization-scoped read of every page a document has (always
 * at least page 1, whether from the automatic finalize_document_upload
 * trigger or the 100127 backfill of every pre-existing document).
 */

export interface DocumentPageSummary {
  pageNumber: number;
  storagePath: string;
  contentType: string;
}

interface ListDocumentPagesRow {
  out_page_number: number;
  out_storage_path: string;
  out_content_type: string;
}

export async function listDocumentPagesRpc(supabase: SupabaseClient, organizationId: string, documentId: string): Promise<DocumentPageSummary[]> {
  const { data, error } = await supabase.rpc("list_document_pages", {
    p_organization_id: organizationId,
    p_document_id: documentId,
  });

  if (error) {
    throw new Error(`list_document_pages failed: ${error.message}`);
  }

  return ((data ?? []) as ListDocumentPagesRow[]).map((row) => ({
    pageNumber: row.out_page_number,
    storagePath: row.out_storage_path,
    contentType: row.out_content_type,
  }));
}
