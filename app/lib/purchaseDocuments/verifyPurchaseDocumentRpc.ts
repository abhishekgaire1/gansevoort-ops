import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around verify_purchase_document. Non-preparer-only --
 * throws CannotSelfVerifyError if the caller is the source document's
 * uploader (segregation of duties, identity-based, admin included).
 *
 * `header`/`lines` are optional: when provided, the RPC atomically
 * persists the reviewer's current (possibly unsaved) form state and
 * verifies in one transaction -- a separate Save Corrections click is
 * never required first. If that state differs from what's already
 * persisted, an attributed PURCHASE_DOCUMENT_REVIEW_CORRECTED event is
 * written as part of the same transaction; if it's identical, no
 * duplicate event is written. Omitting them verifies whatever is already
 * persisted, unchanged from the RPC's original behavior.
 */

export interface VerifyPurchaseDocumentInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  header?: PurchaseDocumentHeaderDraft;
  lines?: PurchaseDocumentLine[];
}

export interface VerifyPurchaseDocumentResult {
  purchaseDocumentId: string;
  verifiedAt: string;
}

interface VerifyPurchaseDocumentRow {
  out_purchase_document_id: string;
  out_verified_at: string;
}

export async function verifyPurchaseDocumentRpc(
  supabase: SupabaseClient,
  input: VerifyPurchaseDocumentInput
): Promise<VerifyPurchaseDocumentResult> {
  const { data, error } = await supabase.rpc("verify_purchase_document", {
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

  const row = (Array.isArray(data) ? data[0] : data) as VerifyPurchaseDocumentRow | undefined;
  if (!row) {
    throw new Error("verify_purchase_document returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, verifiedAt: row.out_verified_at };
}
