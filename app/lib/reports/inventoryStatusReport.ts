import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listInventoryBalances } from "@/app/lib/inventory/listInventoryBalances";
import { computeStockGauge, type StockLevel } from "@/app/lib/inventory/stockLevel";

/**
 * V1 Reports foundation -- Inventory Status (Section 33). Deliberately
 * NOT a new RPC: list_inventory_balances is already the authoritative,
 * already-tested current-balance read model Current Inventory itself
 * uses, and computeStockGauge is the exact same pure classification
 * logic that page already applies per row -- this report is that same
 * truth, just filtered/counted differently, never a second definition of
 * "low stock."
 */
export interface InventoryStatusRow {
  inventoryItemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  baseUnitCode: string;
  balance: number;
  fullReferenceQuantity: number | null;
  stockLevel: StockLevel | null;
}

export interface InventoryStatusReport {
  lowStockCount: number;
  outOfStockCount: number;
  healthyCount: number;
  rows: InventoryStatusRow[];
}

export interface InventoryStatusFilters {
  locationId?: string | null;
  categoryId?: string | null;
}

export async function getInventoryStatusReport(
  supabase: SupabaseClient,
  organizationId: string,
  filters: InventoryStatusFilters = {}
): Promise<InventoryStatusReport> {
  const balances = await listInventoryBalances(supabase, organizationId);

  let itemCategoryById = new Map<string, string | null>();
  if (filters.categoryId) {
    const { data: items } = await supabase.from("inventory_items").select("id, category_id").eq("organization_id", organizationId);
    itemCategoryById = new Map((items ?? []).map((i) => [i.id as string, (i.category_id as string | null) ?? null]));
  }

  const rows: InventoryStatusRow[] = balances
    .filter((b) => !filters.locationId || b.locationId === filters.locationId)
    .filter((b) => !filters.categoryId || itemCategoryById.get(b.inventoryItemId) === filters.categoryId)
    .map((b) => {
      const gauge = computeStockGauge(b.balance, b.fullReferenceQuantity);
      return {
        inventoryItemId: b.inventoryItemId,
        itemName: b.itemName,
        locationId: b.locationId,
        locationName: b.locationName,
        baseUnitCode: b.baseUnitCode,
        balance: b.balance,
        fullReferenceQuantity: b.fullReferenceQuantity,
        stockLevel: gauge.level,
      };
    });

  return {
    lowStockCount: rows.filter((r) => r.stockLevel === "LOW").length,
    outOfStockCount: rows.filter((r) => r.stockLevel === "EMPTY").length,
    healthyCount: rows.filter((r) => r.stockLevel === "HEALTHY" || r.stockLevel === "FULL").length,
    rows: rows.filter((r) => r.stockLevel === "LOW" || r.stockLevel === "EMPTY").sort((a, b) => (a.stockLevel === "EMPTY" ? -1 : 1) - (b.stockLevel === "EMPTY" ? -1 : 1)),
  };
}
