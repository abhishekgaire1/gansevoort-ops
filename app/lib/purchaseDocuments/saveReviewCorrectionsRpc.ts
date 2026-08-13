import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around save_purchase_document_review_corrections -- the
 * independent verifier's controlled write path for READY_FOR_VERIFICATION.
 * Non-preparer-only (throws CannotSelfVerifyError/GA004 if the caller
 * prepared this revision -- the same rule as verify, since reviewing your
 * own submission defeats maker-checker the same way self-verifying would).
 * The RPC computes and writes its own exactly-attributed
 * PURCHASE_DOCUMENT_REVIEW_CORRECTED event for THIS save only (never
 * batched with any other save, never written at all if nothing
 * meaningfully changed) -- this wrapper has no diff logic of its own.
 */

export interface SaveReviewCorrectionsInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
}

export interface SaveReviewCorrectionsResult {
  purchaseDocumentId: string;
  version: number;
}

interface SaveReviewCorrectionsRow {
  out_purchase_document_id: string;
  out_version: number;
}

export async function saveReviewCorrectionsRpc(
  supabase: SupabaseClient,
  input: SaveReviewCorrectionsInput
): Promise<SaveReviewCorrectionsResult> {
  const { data, error } = await supabase.rpc("save_purchase_document_review_corrections", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_expected_version: input.expectedVersion,
    p_header: input.header,
    p_lines: input.lines,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as SaveReviewCorrectionsRow | undefined;
  if (!row) {
    throw new Error("save_purchase_document_review_corrections returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, version: row.out_version };
}
