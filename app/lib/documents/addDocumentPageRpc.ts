import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Typed wrapper around the add_document_page RPC (see
 * supabase/migrations/20260811100127_multi_page_documents.sql), which
 * appends page 2+ to an already-finalized document (finalize_document_
 * upload already creates page 1 automatically via a trigger -- this RPC is
 * never used for page 1). Mirrors finalizeDocumentUploadRpc.ts's own
 * pattern: accepts an already-authenticated SupabaseClient, keeping this
 * module directly testable.
 */

export interface AddDocumentPageRpcInput {
  organizationId: string;
  documentId: string;
  appUserId: string;
  pageNumber: number;
  storagePath: string;
  contentType: string;
  byteSize: number;
  fileSha256: string;
}

export interface AddDocumentPageRpcResult {
  pageId: string;
  replayed: boolean;
}

const DOCUMENT_PAGE_SEQUENCE_OR_LIMIT_SQLSTATE = "GA069";
const DOCUMENT_PAGE_IDENTITY_CONFLICT_SQLSTATE = "GA070";

/**
 * Thrown when a page already exists at this (documentId, pageNumber) but
 * with different file identity (storage_path/content_type/byte_size/
 * file_sha256) than this call supplies -- mirrors DocumentIdentityConflictError
 * (GA001) for the single-page finalize path. The RPC has NOT modified
 * anything in this case.
 */
export class DocumentPageIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentPageIdentityConflictError";
  }
}

interface AddDocumentPageRow {
  out_page_id: string;
  out_replayed: boolean;
}

export async function addDocumentPageRpc(supabase: SupabaseClient, input: AddDocumentPageRpcInput): Promise<AddDocumentPageRpcResult> {
  const { data, error } = await supabase.rpc("add_document_page", {
    p_organization_id: input.organizationId,
    p_document_id: input.documentId,
    p_app_user_id: input.appUserId,
    p_page_number: input.pageNumber,
    p_storage_path: input.storagePath,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
    p_file_sha256: input.fileSha256,
  });

  if (error) {
    if (error.code === DOCUMENT_PAGE_IDENTITY_CONFLICT_SQLSTATE) {
      throw new DocumentPageIdentityConflictError(error.message);
    }
    if (error.code === DOCUMENT_PAGE_SEQUENCE_OR_LIMIT_SQLSTATE) {
      throw new Error(`add_document_page rejected page ${input.pageNumber}: ${error.message}`);
    }
    throw new Error(`add_document_page failed: ${error.message}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as AddDocumentPageRow | undefined;
  if (!row) {
    throw new Error("add_document_page returned no result row");
  }

  return { pageId: row.out_page_id, replayed: row.out_replayed };
}
