import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";

/**
 * Typed wrapper around save_purchase_document_draft. Preparer-only, and
 * requires status='DRAFT' plus a matching version (optimistic concurrency)
 * -- throws NotPreparerError or StaleVersionError respectively. Replaces
 * the entire purchase_document_lines row set on every call (the row `id`
 * PK is not stable across saves), but preserves each line's `lineKey`
 * verbatim -- that's the identity that survives across saves, used for
 * diffing (see save_purchase_document_review_corrections/verify_purchase_
 * document, both of which correlate lines by lineKey, never row id or
 * array position).
 */

export interface SavePurchaseDocumentDraftInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
}

export interface SavePurchaseDocumentDraftResult {
  purchaseDocumentId: string;
  version: number;
}

interface SavePurchaseDocumentDraftRow {
  out_purchase_document_id: string;
  out_version: number;
}

export async function savePurchaseDocumentDraftRpc(
  supabase: SupabaseClient,
  input: SavePurchaseDocumentDraftInput
): Promise<SavePurchaseDocumentDraftResult> {
  const { data, error } = await supabase.rpc("save_purchase_document_draft", {
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

  const row = (Array.isArray(data) ? data[0] : data) as SavePurchaseDocumentDraftRow | undefined;
  if (!row) {
    throw new Error("save_purchase_document_draft returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, version: row.out_version };
}
