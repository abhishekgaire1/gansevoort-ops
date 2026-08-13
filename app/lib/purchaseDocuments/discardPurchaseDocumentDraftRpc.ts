import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around discard_purchase_document_draft. Preparer-only,
 * requires status='DRAFT' -- a READY_FOR_VERIFICATION submission must be
 * withdrawn first (see withdrawPurchaseDocumentSubmissionRpc), and a
 * VERIFIED record can never be discarded at all. The RPC itself requires a
 * non-blank reason when discarding an amendment (revision_number > 1);
 * reason is optional for an original, never-submitted draft.
 */

export interface DiscardPurchaseDocumentDraftInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  reason?: string | null;
}

export interface DiscardPurchaseDocumentDraftResult {
  purchaseDocumentId: string;
  status: PurchaseDocumentStatus;
  version: number;
}

interface DiscardPurchaseDocumentDraftRow {
  out_purchase_document_id: string;
  out_status: PurchaseDocumentStatus;
  out_version: number;
}

export async function discardPurchaseDocumentDraftRpc(
  supabase: SupabaseClient,
  input: DiscardPurchaseDocumentDraftInput
): Promise<DiscardPurchaseDocumentDraftResult> {
  const { data, error } = await supabase.rpc("discard_purchase_document_draft", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason ?? null,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as DiscardPurchaseDocumentDraftRow | undefined;
  if (!row) {
    throw new Error("discard_purchase_document_draft returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, status: row.out_status, version: row.out_version };
}
