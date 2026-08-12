import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Typed wrapper around the finalize_document_upload RPC (see
 * supabase/migrations/20260811100021_finalize_document_upload_rpc.sql),
 * which inserts the documents row and its first document_extractions row
 * inside ONE Postgres transaction. Mirrors app/lib/inventory/withdrawal.ts's
 * pattern: accepts an already-authenticated SupabaseClient rather than
 * constructing its own, keeping this module directly testable.
 */

export interface FinalizeDocumentUploadRpcInput {
  documentId: string;
  organizationId: string;
  uploadedByAppUserId: string;
  storagePath: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  fileSha256: string;
  provider: string;
  model: string;
}

export interface FinalizeDocumentUploadRpcResult {
  documentId: string;
  attemptId: string;
  replayed: boolean;
}

const DOCUMENT_IDENTITY_CONFLICT_SQLSTATE = "GA001";

/**
 * Thrown when documentId already refers to a document whose immutable
 * identity fields (organization_id, storage_path, file_sha256, byte_size,
 * content_type) don't match this finalize call. The RPC has NOT modified
 * or deleted anything in this case -- the caller must leave the existing
 * document row and its Storage object completely untouched.
 */
export class DocumentIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentIdentityConflictError";
  }
}

interface FinalizeDocumentUploadRow {
  document_id: string;
  attempt_id: string;
  replayed: boolean;
}

export async function finalizeDocumentUploadRpc(
  supabase: SupabaseClient,
  input: FinalizeDocumentUploadRpcInput
): Promise<FinalizeDocumentUploadRpcResult> {
  const { data, error } = await supabase.rpc("finalize_document_upload", {
    p_document_id: input.documentId,
    p_organization_id: input.organizationId,
    p_uploaded_by_app_user_id: input.uploadedByAppUserId,
    p_storage_path: input.storagePath,
    p_original_filename: input.originalFilename,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
    p_file_sha256: input.fileSha256,
    p_provider: input.provider,
    p_model: input.model,
  });

  if (error) {
    if (error.code === DOCUMENT_IDENTITY_CONFLICT_SQLSTATE) {
      throw new DocumentIdentityConflictError(error.message);
    }
    throw new Error(`finalize_document_upload failed: ${error.message}`);
  }

  // supabase-js returns a single-row RETURNS TABLE result as a one-element array.
  const row = (Array.isArray(data) ? data[0] : data) as FinalizeDocumentUploadRow | undefined;
  if (!row) {
    throw new Error("finalize_document_upload returned no result row");
  }

  return { documentId: row.document_id, attemptId: row.attempt_id, replayed: row.replayed };
}
