import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapInventoryRpcError } from "@/app/lib/inventory/errors";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";

export interface PostPurchaseDocumentInventoryInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
}

export interface PostPurchaseDocumentInventoryResult {
  status: "POSTED" | "ALREADY_POSTED";
  postingId: string | null;
  postedLineCount: number;
  movementCount: number;
}

/** The ONLY operation that increases inventory. Idempotent: a retry,
 * double-click, or concurrent duplicate converges on the existing posting
 * (status ALREADY_POSTED) via the unique receipt_line_id backbone -- see
 * 20260811100064. */
export async function postPurchaseDocumentInventoryRpc(
  supabase: SupabaseClient,
  input: PostPurchaseDocumentInventoryInput
): Promise<PostPurchaseDocumentInventoryResult> {
  const { data, error } = await supabase.rpc("post_purchase_document_inventory", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
  });

  if (error) {
    // GA003 (not VERIFIED) belongs to the purchase-document registry;
    // GA017 (posting blocked) to the inventory one.
    if (error.code === "GA003") throw mapPurchaseDocumentRpcError(error);
    throw mapInventoryRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_status: string; out_posting_id: string | null; out_posted_line_count: number; out_movement_count: number }
    | undefined;
  if (!row) {
    throw new Error("post_purchase_document_inventory returned no result row");
  }

  return {
    status: row.out_status as "POSTED" | "ALREADY_POSTED",
    postingId: row.out_posting_id,
    postedLineCount: row.out_posted_line_count,
    movementCount: row.out_movement_count,
  };
}

export interface SetInventoryStockReferenceInput {
  organizationId: string;
  inventoryItemId: string;
  locationId: string;
  fullQuantity: number;
  appUserId: string;
}

/** Manager override of the full-stock reference -- changes ONLY the
 * visualization baseline (append-only row + audit event). Never creates a
 * movement, never changes a balance. */
export async function setInventoryStockReferenceRpc(supabase: SupabaseClient, input: SetInventoryStockReferenceInput): Promise<void> {
  const { error } = await supabase.rpc("set_inventory_stock_reference", {
    p_organization_id: input.organizationId,
    p_inventory_item_id: input.inventoryItemId,
    p_location_id: input.locationId,
    p_full_quantity: input.fullQuantity,
    p_app_user_id: input.appUserId,
  });

  if (error) {
    throw mapInventoryRpcError(error);
  }
}
