import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around initialize_purchase_document_draft (see
 * supabase/migrations/20260811100026_purchase_document_draft_rpcs.sql).
 * Preparer-only -- throws NotPreparerError if the caller isn't the source
 * document's uploader. Idempotent: if a purchase_document already exists
 * for this document, returns it as-is (created:false) without touching it.
 */

export interface InitializePurchaseDocumentDraftInput {
  documentId: string;
  organizationId: string;
  appUserId: string;
}

export interface InitializePurchaseDocumentDraftResult {
  purchaseDocumentId: string;
  status: PurchaseDocumentStatus;
  created: boolean;
}

interface InitializePurchaseDocumentDraftRow {
  out_purchase_document_id: string;
  out_status: PurchaseDocumentStatus;
  out_created: boolean;
}

export async function initializePurchaseDocumentDraftRpc(
  supabase: SupabaseClient,
  input: InitializePurchaseDocumentDraftInput
): Promise<InitializePurchaseDocumentDraftResult> {
  const { data, error } = await supabase.rpc("initialize_purchase_document_draft", {
    p_document_id: input.documentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as InitializePurchaseDocumentDraftRow | undefined;
  if (!row) {
    throw new Error("initialize_purchase_document_draft returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, status: row.out_status, created: row.out_created };
}
