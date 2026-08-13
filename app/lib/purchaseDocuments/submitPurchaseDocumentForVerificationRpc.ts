import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around submit_purchase_document_for_verification.
 * Preparer-only. The RPC's completeness gates (vendor set + active,
 * document type resolved, at least one line) are folded into its own
 * atomic transition -- a rejection here (StaleVersionError, reused for
 * "not a DRAFT / stale version / incomplete", since the RPC uses the same
 * GA002 code for all of them) should rarely surface in practice if the
 * calling UI pre-checks the same conditions before enabling Submit.
 *
 * `header`/`lines` are optional: when provided, the RPC atomically
 * persists that exact form state and transitions to READY_FOR_VERIFICATION
 * in one transaction -- the caller never needs a separate Save Draft call
 * first, and there is no risk of submitting stale, previously-persisted
 * values. Omitting them submits whatever is already persisted, unchanged
 * from the RPC's original behavior.
 */

export interface SubmitPurchaseDocumentForVerificationInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  header?: PurchaseDocumentHeaderDraft;
  lines?: PurchaseDocumentLine[];
}

export interface SubmitPurchaseDocumentForVerificationResult {
  purchaseDocumentId: string;
  status: PurchaseDocumentStatus;
  version: number;
}

interface SubmitPurchaseDocumentForVerificationRow {
  out_purchase_document_id: string;
  out_status: PurchaseDocumentStatus;
  out_version: number;
}

export async function submitPurchaseDocumentForVerificationRpc(
  supabase: SupabaseClient,
  input: SubmitPurchaseDocumentForVerificationInput
): Promise<SubmitPurchaseDocumentForVerificationResult> {
  const { data, error } = await supabase.rpc("submit_purchase_document_for_verification", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_expected_version: input.expectedVersion,
    p_header: input.header ?? null,
    p_lines: input.lines ?? null,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as SubmitPurchaseDocumentForVerificationRow | undefined;
  if (!row) {
    throw new Error("submit_purchase_document_for_verification returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, status: row.out_status, version: row.out_version };
}
