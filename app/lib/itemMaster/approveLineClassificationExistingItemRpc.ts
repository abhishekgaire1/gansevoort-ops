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
  /** Registers/versions THIS vendor's (or SKU's) own purchase package for
   * an already-confirmed item -- e.g. a known canonical item being
   * invoiced by a new vendor for the first time. Never overwrites another
   * vendor's or SKU's package (approved-plan §8): the underlying RPC keys
   * the package to this specific vendor_item_mappings row, not the bare
   * item. Null/omitted purchaseUnitCode leaves any existing package
   * configuration for this vendor/SKU untouched. */
  purchaseUnitCode?: string | null;
  receivingBehavior?: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor?: number | null;
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
    p_purchase_unit_code: input.purchaseUnitCode ?? null,
    p_receiving_behavior: input.receivingBehavior ?? null,
    p_fixed_conversion_factor: input.fixedConversionFactor ?? null,
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
