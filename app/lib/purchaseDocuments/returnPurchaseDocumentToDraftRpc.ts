import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around return_purchase_document_to_draft. Non-preparer-only
 * -- same segregation-of-duties check as verify, so only someone eligible
 * to verify may bounce a submission back to DRAFT.
 */

export interface ReturnPurchaseDocumentToDraftInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  reason?: string | null;
}

export interface ReturnPurchaseDocumentToDraftResult {
  purchaseDocumentId: string;
  status: PurchaseDocumentStatus;
  version: number;
}

interface ReturnPurchaseDocumentToDraftRow {
  out_purchase_document_id: string;
  out_status: PurchaseDocumentStatus;
  out_version: number;
}

export async function returnPurchaseDocumentToDraftRpc(
  supabase: SupabaseClient,
  input: ReturnPurchaseDocumentToDraftInput
): Promise<ReturnPurchaseDocumentToDraftResult> {
  const { data, error } = await supabase.rpc("return_purchase_document_to_draft", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason ?? null,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as ReturnPurchaseDocumentToDraftRow | undefined;
  if (!row) {
    throw new Error("return_purchase_document_to_draft returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, status: row.out_status, version: row.out_version };
}
