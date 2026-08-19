import type { SupabaseClient } from "@supabase/supabase-js";

export interface InventoryItemSearchSignals {
  vendorSkus: string[];
  vendorDescriptions: string[];
}

/**
 * Trusted secondary search text per item -- CONFIRMED, active
 * vendor_item_mappings rows only (20260811100078's
 * list_inventory_item_search_signals). Never pending AI suggestions,
 * never unconfirmed matches: this schema has no separate "trusted
 * aliases" table (docs/DATABASE.md's vendor_item_aliases concept was
 * consolidated into vendor_item_mappings during 2A.3), so confirmed
 * vendor descriptions and vendor SKUs are the only two trusted
 * secondary signals available beyond the item's own canonical name.
 *
 * Fetched once per kiosk session (small, org-scoped, no pricing/invoice
 * data) and searched entirely client-side -- see app/kiosk/_lib/search.ts.
 */
export async function listInventoryItemSearchSignals(
  supabase: SupabaseClient,
  organizationId: string
): Promise<Record<string, InventoryItemSearchSignals>> {
  const { data, error } = await supabase.rpc("list_inventory_item_search_signals", { p_organization_id: organizationId });
  if (error) {
    throw new Error(`list_inventory_item_search_signals failed: ${error.message}`);
  }

  const rows = (data ?? []) as { out_inventory_item_id: string; out_vendor_sku: string | null; out_normalized_description: string | null }[];
  const signals: Record<string, InventoryItemSearchSignals> = {};

  for (const row of rows) {
    const entry = (signals[row.out_inventory_item_id] ??= { vendorSkus: [], vendorDescriptions: [] });
    if (row.out_vendor_sku !== null) entry.vendorSkus.push(row.out_vendor_sku);
    if (row.out_normalized_description !== null) entry.vendorDescriptions.push(row.out_normalized_description);
  }

  return signals;
}
