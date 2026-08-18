import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface ApproveLineClassificationExistingItemInput {
  purchaseDocumentId: string;
  lineKey: string;
  organizationId: string;
  appUserId: string;
  inventoryItemId: string;
  rememberVendorMapping?: boolean;
}

export interface ApproveLineClassificationExistingItemResult {
  classificationId: string;
}

interface ApproveLineClassificationExistingItemRow {
  out_classification_id: string;
}

export async function approveLineClassificationExistingItemRpc(
  supabase: SupabaseClient,
  input: ApproveLineClassificationExistingItemInput
): Promise<ApproveLineClassificationExistingItemResult> {
  const { data, error } = await supabase.rpc("approve_line_classification_existing_item", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_inventory_item_id: input.inventoryItemId,
    p_remember_vendor_mapping: input.rememberVendorMapping ?? true,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as ApproveLineClassificationExistingItemRow | undefined;
  if (!row) {
    throw new Error("approve_line_classification_existing_item returned no result row");
  }

  return { classificationId: row.out_classification_id };
}
