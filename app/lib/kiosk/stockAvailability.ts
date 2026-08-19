import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's stock-visibility/source-location
 * step (Milestone 2A.5 Phase 2). Deliberately narrow: item, location,
 * quantity available, base unit, full-stock reference, and whether the
 * balance includes a legacy estimate -- never price, invoice, or any
 * manager-configuration field. Reuses list_inventory_balances_for_item
 * (20260811100075), the same exact+frozen-legacy balance formula the
 * manager inventory page reads, so kiosk and manager can never disagree
 * about what "current balance" means.
 */

export interface KioskLocationAvailability {
  locationId: string;
  locationName: string;
  baseUnitCode: string;
  balance: number;
  fullReferenceQuantity: number | null;
  includesLegacyEstimate: boolean;
}

export async function getKioskItemAvailability(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string
): Promise<KioskLocationAvailability[]> {
  const { data, error } = await supabase.rpc("list_inventory_balances_for_item", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
  });
  if (error) {
    throw new Error(`list_inventory_balances_for_item failed: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    locationId: row.out_location_id as string,
    locationName: row.out_location_name as string,
    baseUnitCode: row.out_base_unit_code as string,
    balance: Number(row.out_balance),
    fullReferenceQuantity: row.out_full_reference_quantity === null ? null : Number(row.out_full_reference_quantity),
    includesLegacyEstimate: row.out_includes_legacy_estimate === true,
  }));
}
