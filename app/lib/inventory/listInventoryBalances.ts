import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface InventoryBalanceRow {
  inventoryItemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  baseUnitCode: string;
  /** Derived from the append-only ledger (list_inventory_balances /
   * inventory_location_balances) -- there is no mutable current-quantity
   * column anywhere. */
  balance: number;
  /** The current full-stock reference (latest inventory_stock_references
   * row), or null when no restock/override has ever set one. */
  fullReferenceQuantity: number | null;
  referenceSource: "RESTOCK" | "MANAGER_OVERRIDE" | null;
  referenceSetAt: string | null;
}

export async function listInventoryBalances(supabase: SupabaseClient, organizationId: string): Promise<InventoryBalanceRow[]> {
  const { data, error } = await supabase.rpc("list_inventory_balances", { p_organization_id: organizationId });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    inventoryItemId: row.out_inventory_item_id as string,
    itemName: row.out_item_name as string,
    locationId: row.out_location_id as string,
    locationName: row.out_location_name as string,
    baseUnitCode: row.out_base_unit_code as string,
    balance: Number(row.out_balance),
    fullReferenceQuantity: row.out_full_reference_quantity === null ? null : Number(row.out_full_reference_quantity),
    referenceSource: (row.out_reference_source as "RESTOCK" | "MANAGER_OVERRIDE" | null) ?? null,
    referenceSetAt: (row.out_reference_set_at as string | null) ?? null,
  }));
}
