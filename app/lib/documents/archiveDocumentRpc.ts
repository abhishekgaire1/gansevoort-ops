import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";

/**
 * Typed wrapper around archive_document -- "Remove Upload" for a document
 * that never became a real purchase_document (or whose only
 * purchase_document has itself been discarded). Uploader-only. Reuses the
 * shared app-defined SQLSTATE mapping (GA006 "not the preparer" / GA002
 * "wrong state") even though this concerns a `documents` row, not a
 * `purchase_documents` one -- both codes mean the same general thing here
 * ("not the owner" / "not archivable right now"). `documents` is fully
 * append-only, so this never mutates it -- it inserts one row into the
 * separate document_archives table. Never touches storage -- the original
 * object is retained.
 */

export interface ArchiveDocumentInput {
  documentId: string;
  organizationId: string;
  appUserId: string;
  reason?: string | null;
}

export interface ArchiveDocumentResult {
  documentId: string;
  archivedAt: string;
}

interface ArchiveDocumentRow {
  out_document_id: string;
  out_archived_at: string;
}

export async function archiveDocumentRpc(supabase: SupabaseClient, input: ArchiveDocumentInput): Promise<ArchiveDocumentResult> {
  const { data, error } = await supabase.rpc("archive_document", {
    p_document_id: input.documentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_reason: input.reason ?? null,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as ArchiveDocumentRow | undefined;
  if (!row) {
    throw new Error("archive_document returned no result row");
  }

  return { documentId: row.out_document_id, archivedAt: row.out_archived_at };
}
