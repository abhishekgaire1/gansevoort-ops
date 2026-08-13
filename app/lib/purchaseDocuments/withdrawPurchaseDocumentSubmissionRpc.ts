import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around withdraw_purchase_document_submission. Preparer-only
 * (the OPPOSITE identity check from verify/return, which are
 * non-preparer-only) -- only the person who submitted a document may pull
 * it back. Restores the latest PURCHASE_DOCUMENT_SUBMITTED snapshot
 * exactly like return_purchase_document_to_draft, so any reviewer
 * corrections saved during this cycle are never silently promoted into the
 * restored draft -- they remain in audit history as discarded review
 * activity.
 */

export interface WithdrawPurchaseDocumentSubmissionInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  reason?: string | null;
}

export interface WithdrawPurchaseDocumentSubmissionResult {
  purchaseDocumentId: string;
  status: PurchaseDocumentStatus;
  version: number;
}

interface WithdrawPurchaseDocumentSubmissionRow {
  out_purchase_document_id: string;
  out_status: PurchaseDocumentStatus;
  out_version: number;
}

export async function withdrawPurchaseDocumentSubmissionRpc(
  supabase: SupabaseClient,
  input: WithdrawPurchaseDocumentSubmissionInput
): Promise<WithdrawPurchaseDocumentSubmissionResult> {
  const { data, error } = await supabase.rpc("withdraw_purchase_document_submission", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason ?? null,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as WithdrawPurchaseDocumentSubmissionRow | undefined;
  if (!row) {
    throw new Error("withdraw_purchase_document_submission returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, status: row.out_status, version: row.out_version };
}
