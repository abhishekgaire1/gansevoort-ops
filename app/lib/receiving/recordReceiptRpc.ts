import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";
import type { ReceiptKind, ReceiptLineInput } from "@/app/lib/receiving/types";

export interface RecordReceiptInput {
  organizationId: string;
  appUserId: string;
  receiptKind: ReceiptKind;
  /** Required for DELIVERY, ignored for CORRECTION (the RPC derives it
   * server-side from the receipt being corrected). */
  purchaseDocumentId?: string | null;
  correctsReceiptId?: string | null;
  defaultLocationId?: string | null;
  notes?: string | null;
  lines: ReceiptLineInput[];
  /** A caller-generated, stable-per-submission-attempt key (20260811100061)
   * -- a retry (double-click, network retry) using the SAME key returns
   * the already-recorded receipt instead of creating a duplicate. Never
   * derived from document/line identity alone -- legitimate additional
   * deliveries must remain possible, so callers rotate this per distinct
   * logical submission, not per document. Optional: a caller that omits
   * it (e.g. an internal/system caller) gets today's unprotected
   * behavior. */
  idempotencyKey?: string | null;
}

export interface RecordReceiptResult {
  receiptId: string;
}

export async function recordReceiptRpc(supabase: SupabaseClient, input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const { data, error } = await supabase.rpc("record_receipt", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_receipt_kind: input.receiptKind,
    p_purchase_document_id: input.purchaseDocumentId ?? null,
    p_corrects_receipt_id: input.correctsReceiptId ?? null,
    p_default_location_id: input.defaultLocationId ?? null,
    p_notes: input.notes ?? null,
    p_lines: input.lines,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_receipt_id: string } | undefined;
  if (!row) {
    throw new Error("record_receipt returned no result row");
  }

  return { receiptId: row.out_receipt_id };
}
