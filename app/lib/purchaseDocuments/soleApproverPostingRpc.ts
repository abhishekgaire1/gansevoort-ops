import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import { mapInventoryRpcError, INVENTORY_SQLSTATE } from "@/app/lib/inventory/errors";
import type { SoleApproverReasonCode } from "@/app/lib/purchaseDocuments/soleApproverReason";

/**
 * Typed wrapper around post_purchase_document_sole_approver
 * (20260811100133) -- the ONE call that takes a fully-valid DRAFT
 * straight to VERIFIED (as sole approver) and POSTED, atomically. Every
 * completeness gate this reuses (item mapping/receiving, delivery
 * verifier, plausible date, amendment-lineage-already-posted, and the
 * full inventory-posting blocker scan) is enforced authoritatively in the
 * database, not just by this wrapper -- see the migration's own comments.
 *
 * Error codes can come from either domain this RPC touches: its own
 * (GA002/GA013/GA075/GA076/GA078, mapped by mapPurchaseDocumentRpcError)
 * or post_purchase_document_inventory's, which it calls internally
 * (GA017 posting-blocked, GA075 already inherited above) -- so this
 * wrapper tries the purchase-document mapping first and falls back to the
 * inventory mapping for anything that maps to a bare Error there.
 */

export interface PostPurchaseDocumentSoleApproverInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  expectedVersion: number;
  reason: SoleApproverReasonCode;
  notes: string | null;
  idempotencyKey: string;
}

export interface PostPurchaseDocumentSoleApproverResult {
  purchaseDocumentId: string;
  status: string;
  verifiedAt: string;
  verificationMethod: string;
  postingStatus: "POSTED" | "ALREADY_POSTED";
  postingId: string | null;
  postedLineCount: number;
  movementCount: number;
  invoiceTotal: number | null;
  inventoryValue: number;
  inventoryLineCount: number;
  expenseLineCount: number;
}

interface PostPurchaseDocumentSoleApproverRow {
  out_purchase_document_id: string;
  out_status: string;
  out_verified_at: string;
  out_verification_method: string;
  out_posting_status: "POSTED" | "ALREADY_POSTED";
  out_posting_id: string | null;
  out_posted_line_count: number;
  out_movement_count: number;
  out_invoice_total: number | null;
  out_inventory_value: number;
  out_inventory_line_count: number;
  out_expense_line_count: number;
}

function mapSoleApproverRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code && (Object.values(INVENTORY_SQLSTATE) as string[]).includes(error.code)) {
    return mapInventoryRpcError(error);
  }
  return mapPurchaseDocumentRpcError(error);
}

export async function postPurchaseDocumentSoleApproverRpc(
  supabase: SupabaseClient,
  input: PostPurchaseDocumentSoleApproverInput
): Promise<PostPurchaseDocumentSoleApproverResult> {
  const { data, error } = await supabase.rpc("post_purchase_document_sole_approver", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason,
    p_notes: input.notes,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    throw mapSoleApproverRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as PostPurchaseDocumentSoleApproverRow | undefined;
  if (!row) {
    throw new Error("post_purchase_document_sole_approver returned no result row");
  }

  return {
    purchaseDocumentId: row.out_purchase_document_id,
    status: row.out_status,
    verifiedAt: row.out_verified_at,
    verificationMethod: row.out_verification_method,
    postingStatus: row.out_posting_status,
    postingId: row.out_posting_id,
    postedLineCount: row.out_posted_line_count,
    movementCount: row.out_movement_count,
    invoiceTotal: row.out_invoice_total,
    inventoryValue: row.out_inventory_value,
    inventoryLineCount: row.out_inventory_line_count,
    expenseLineCount: row.out_expense_line_count,
  };
}
