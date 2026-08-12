import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's item-selection screen. Fetches
 * the full active catalog in one call; search/category filtering happens
 * entirely client-side afterward (see app/kiosk/_lib/itemFilter.ts) --
 * hundreds of {id, name, categoryId, categoryName} rows is trivial to
 * hold in memory and keeps every keystroke instant with zero further
 * network round trips.
 *
 * Filters only on the item's own status='active', matching the RPC's own
 * authorization surface (record_inventory_withdrawal does not check
 * inventory_categories.is_active at all) -- an item under a now-inactive
 * category is still listed here, intentionally consistent with what the
 * RPC would actually accept.
 *
 * Also excludes any item that isn't actually withdrawable yet: the
 * withdrawal-unit simplification requires an ACTIVE, self-referencing
 * inventory_item_units row for the item's own base_unit_id (see
 * app/lib/kiosk/withdrawalUnit.ts) -- an item missing that row would only
 * fail once selected. Filtering it out of the catalog here means an
 * employee never sees a selectable item that can't actually be withdrawn,
 * rather than surfacing a manager-facing configuration error mid-flow.
 */

export interface KioskInventoryItem {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
}

interface InventoryItemRow {
  id: string;
  name: string;
  category_id: string;
  base_unit_id: string;
  inventory_categories: { name: string } | { name: string }[] | null;
}

export async function listActiveInventoryItemsForOrganization(
  supabase: SupabaseClient,
  organizationId: string
): Promise<KioskInventoryItem[]> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, name, category_id, base_unit_id, inventory_categories(name)")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("name");

  if (error) {
    throw new Error(`listActiveInventoryItemsForOrganization failed: ${error.message}`);
  }

  const rows = (data ?? []) as InventoryItemRow[];
  if (rows.length === 0) {
    return [];
  }

  const { data: entryUnits, error: entryUnitsError } = await supabase
    .from("inventory_item_units")
    .select("inventory_item_id, unit_id")
    .in(
      "inventory_item_id",
      rows.map((row) => row.id)
    )
    .eq("is_active", true);

  if (entryUnitsError) {
    throw new Error(`listActiveInventoryItemsForOrganization entry-unit lookup failed: ${entryUnitsError.message}`);
  }

  const baseUnitIdByItemId = new Map(rows.map((row) => [row.id, row.base_unit_id]));
  const withdrawableItemIds = new Set(
    (entryUnits ?? [])
      .filter((row) => baseUnitIdByItemId.get(row.inventory_item_id as string) === row.unit_id)
      .map((row) => row.inventory_item_id as string)
  );

  return rows
    .filter((row) => withdrawableItemIds.has(row.id))
    .map((row) => {
      const category = Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories;
      return {
        id: row.id,
        name: row.name,
        categoryId: row.category_id,
        categoryName: category?.name ?? "",
      };
    });
}
