import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapInventoryRpcError } from "@/app/lib/inventory/errors";

/**
 * Safe editing of confirmed items -- the generic "Adjust Inventory"
 * action (record_inventory_correction, 20260811100141). Always operates
 * in the item's own base unit, matching record_inventory_waste's own
 * "do not introduce CASE/BOX conversion here" convention -- the UI shows
 * the base unit as a label, never a picker.
 */

export type CorrectionMode = "COUNTED" | "DELTA";

export interface RecordInventoryCorrectionResult {
  correctionId: string;
  movementId: string | null;
  previousBalance: number;
  newBalance: number;
  replayed: boolean;
}

export async function recordInventoryCorrection(
  supabase: SupabaseClient,
  actorAppUserId: string,
  inventoryItemId: string,
  locationId: string,
  mode: CorrectionMode,
  countedQuantity: number | null,
  deltaQuantity: number | null,
  reason: string,
  clientRequestId: string
): Promise<RecordInventoryCorrectionResult> {
  const { data, error } = await supabase.rpc("record_inventory_correction", {
    p_app_user_id: actorAppUserId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
    p_mode: mode,
    p_counted_quantity: countedQuantity,
    p_delta_quantity: deltaQuantity,
    p_reason: reason,
    p_client_request_id: clientRequestId,
  });
  if (error) throw mapInventoryRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_correction_id: string; out_movement_id: string | null; out_previous_balance: number; out_new_balance: number; out_replayed: boolean }
    | undefined;
  if (!row) throw new Error("record_inventory_correction returned no result");
  return {
    correctionId: row.out_correction_id,
    movementId: row.out_movement_id,
    previousBalance: row.out_previous_balance,
    newBalance: row.out_new_balance,
    replayed: row.out_replayed,
  };
}

export interface InventoryCorrectionPreview {
  previousBalance: number;
  proposedBalance: number;
  delta: number;
  wouldGoNegative: boolean;
  baseUnitCode: string;
}

/** Pure read, no RPC write -- computes exactly what
 * record_inventory_correction WOULD do, for the confirmation screen
 * (spec section 10/13). Reuses the same balance formula
 * (inventory_location_item_balance) the RPC itself reads under its
 * advisory lock, so the preview and the eventual write can never
 * meaningfully disagree except for a genuine intervening concurrent
 * change -- which the RPC's own lock-then-reread still catches
 * authoritatively at write time regardless of what this preview showed. */
export async function previewInventoryCorrection(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string,
  mode: CorrectionMode,
  countedQuantity: number | null,
  deltaQuantity: number | null
): Promise<InventoryCorrectionPreview> {
  const { data: itemRow, error: itemError } = await supabase
    .from("inventory_items")
    .select("base_unit_id, units:base_unit_id(code)")
    .eq("id", inventoryItemId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (itemError) throw new Error(itemError.message);
  const unit = itemRow ? (Array.isArray(itemRow.units) ? itemRow.units[0] : itemRow.units) : null;
  const baseUnitCode = (unit as { code?: string } | null)?.code ?? "unit";

  const { data: balanceData, error: balanceError } = await supabase.rpc("inventory_location_item_balance", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
  });
  if (balanceError) throw new Error(balanceError.message);
  const previousBalance = Number(balanceData ?? 0);

  const delta = mode === "COUNTED" ? (countedQuantity ?? 0) - previousBalance : (deltaQuantity ?? 0);
  const proposedBalance = previousBalance + delta;

  return { previousBalance, proposedBalance, delta, wouldGoNegative: proposedBalance < 0, baseUnitCode };
}
