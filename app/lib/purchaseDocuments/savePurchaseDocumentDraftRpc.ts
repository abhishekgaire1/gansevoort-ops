import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentHeaderDraft } from "@/app/lib/purchaseDocuments/types";
import type { NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Typed wrapper around save_purchase_document_draft. Preparer-only, and
 * requires status='DRAFT' plus a matching version (optimistic concurrency)
 * -- throws NotPreparerError or StaleVersionError respectively. Replaces
 * the entire line set on every call (see the migration's own comment on
 * why line UUIDs aren't stable across saves).
 */

export interface SavePurchaseDocumentDraftInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  header: PurchaseDocumentHeaderDraft;
  lines: NormalizedInvoiceLine[];
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
