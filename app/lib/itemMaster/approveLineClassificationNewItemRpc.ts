import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface ApproveLineClassificationNewItemInput {
  purchaseDocumentId: string;
  lineKey: string;
  organizationId: string;
  appUserId: string;
  finalName: string;
  disposition: "INVENTORY" | "NON_INVENTORY";
  categoryId: string | null;
  spendCategoryId: string | null;
  baseUnitCode: string | null;
  pendingItemId?: string | null;
  rememberVendorMapping?: boolean;
  purchaseUnitCode?: string | null;
  receivingBehavior?: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor?: number | null;
  /** Optional second kiosk usage unit -- the primary is always the
   * item's base unit and is configured server-side automatically; this is
   * ONLY ever a manager-confirmed value, never AI-proposed (approved-plan
   * §6/§11). Null/omitted means the item has no secondary usage unit. */
  secondaryUsageUnitCode?: string | null;
  secondaryConversionFactor?: number | null;
  /** Weigh-at-kiosk restoration (20260811100126): true only when the
   * manager explicitly picked "Measure at withdrawal" for the secondary
   * usage unit. Omitted/false reproduces prior behavior exactly (a fixed
   * secondary requiring a positive conversion factor). */
  secondaryRequiresMeasurement?: boolean;
}

export interface ApproveLineClassificationNewItemResult {
  inventoryItemId: string;
  classificationId: string;
}

interface ApproveLineClassificationNewItemRow {
  out_inventory_item_id: string;
  out_classification_id: string;
}

/** One manager action, one transaction: confirms the item (creating it if
 * p_pendingItemId is not given, else confirming that AI-proposed row),
 * confirms the line's classification, and -- unless opted out -- remembers
 * the vendor mapping. */
export async function approveLineClassificationNewItemRpc(
  supabase: SupabaseClient,
  input: ApproveLineClassificationNewItemInput
): Promise<ApproveLineClassificationNewItemResult> {
  const { data, error } = await supabase.rpc("approve_line_classification_new_item", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_final_name: input.finalName,
    p_disposition: input.disposition,
    p_category_id: input.categoryId,
    p_spend_category_id: input.spendCategoryId,
    p_base_unit_code: input.baseUnitCode,
    p_pending_item_id: input.pendingItemId ?? null,
    p_remember_vendor_mapping: input.rememberVendorMapping ?? true,
    p_purchase_unit_code: input.purchaseUnitCode ?? null,
    p_receiving_behavior: input.receivingBehavior ?? null,
    p_fixed_conversion_factor: input.fixedConversionFactor ?? null,
    p_secondary_usage_unit_code: input.secondaryUsageUnitCode ?? null,
    p_secondary_conversion_factor: input.secondaryConversionFactor ?? null,
    p_secondary_requires_measurement: input.secondaryRequiresMeasurement ?? false,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as ApproveLineClassificationNewItemRow | undefined;
  if (!row) {
    throw new Error("approve_line_classification_new_item returned no result row");
  }

  return { inventoryItemId: row.out_inventory_item_id, classificationId: row.out_classification_id };
}
