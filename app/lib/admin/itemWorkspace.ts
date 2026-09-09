import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminItem, type AdminItemDetail } from "@/app/lib/admin/items";
import { lookupItemPurchaseCostById } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";

/**
 * Safe editing of confirmed items -- the item workspace's Overview
 * section aggregator: current item detail + current on-hand balance by
 * location (derived from the ledger, never a stored column) + an
 * explicitly-labeled operational cost estimate for "current inventory
 * value." No new RPC of its own -- this is a read-side composition of
 * three already-existing/already-added reads.
 */

export interface ItemLocationBalance {
  locationId: string;
  locationName: string;
  balance: number;
}

export interface ItemWorkspaceOverview {
  item: AdminItemDetail;
  totalOnHandQuantity: number;
  locationBalances: ItemLocationBalance[];
  /** Null when no verified cost basis exists yet for this item -- the UI
   * must show "-- (no verified cost yet)," never a fabricated $0. Always
   * an operational estimate, never an accounting valuation (same
   * disclaimer as every other cost display in this codebase). */
  estimatedTotalValue: number | null;
  estimatedUnitCost: number | null;
}

export async function getItemWorkspaceOverview(supabase: SupabaseClient, organizationId: string, itemId: string): Promise<ItemWorkspaceOverview | null> {
  const item = await getAdminItem(supabase, organizationId, itemId);
  if (!item) return null;

  const { data: balanceRows, error: balanceError } = await supabase.rpc("list_inventory_balances_for_item", {
    p_organization_id: organizationId,
    p_inventory_item_id: itemId,
  });
  if (balanceError) throw new Error(balanceError.message);
  const locationBalances: ItemLocationBalance[] = ((balanceRows ?? []) as { out_location_id: string; out_location_name: string; out_balance: number }[]).map((r) => ({
    locationId: r.out_location_id,
    locationName: r.out_location_name,
    balance: r.out_balance,
  }));
  const totalOnHandQuantity = locationBalances.reduce((sum, l) => sum + l.balance, 0);

  const cost = await lookupItemPurchaseCostById({ supabase, organizationId, now: new Date() }, itemId, 30);
  const estimatedUnitCost = cost.status === "exact" ? (cost.weightedAverage?.weightedAverageBaseUnitCost ?? cost.latest.unitCostPerBaseUnit) : null;
  const estimatedTotalValue = estimatedUnitCost !== null ? estimatedUnitCost * totalOnHandQuantity : null;

  return { item, totalOnHandQuantity, locationBalances, estimatedTotalValue, estimatedUnitCost };
}

export interface ArchiveDependencies {
  hasPositiveStock: boolean;
  positiveStockLocations: { locationId: string; locationName: string; balance: number }[];
  activeVendorMappingCount: number;
  activeUsageUnitCount: number;
  openDocumentLineCount: number;
}

export async function getAdminItemArchiveDependencies(supabase: SupabaseClient, organizationId: string, itemId: string): Promise<ArchiveDependencies> {
  const { data, error } = await supabase.rpc("get_admin_item_archive_dependencies", {
    p_organization_id: organizationId,
    p_item_id: itemId,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_has_positive_stock: boolean;
        out_positive_stock_locations: { locationId: string; locationName: string; balance: number }[];
        out_active_vendor_mapping_count: number;
        out_active_usage_unit_count: number;
        out_open_document_line_count: number;
      }
    | undefined;
  if (!row) throw new Error("get_admin_item_archive_dependencies returned no result");
  return {
    hasPositiveStock: row.out_has_positive_stock,
    positiveStockLocations: row.out_positive_stock_locations,
    activeVendorMappingCount: row.out_active_vendor_mapping_count,
    activeUsageUnitCount: row.out_active_usage_unit_count,
    openDocumentLineCount: row.out_open_document_line_count,
  };
}
