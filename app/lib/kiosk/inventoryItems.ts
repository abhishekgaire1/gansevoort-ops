import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's item-selection screen. Fetches
 * the full active catalog in one call; search/category filtering happens
 * entirely client-side afterward (see app/kiosk/_components/ItemSearch.tsx)
 * -- hundreds of {id, name, categoryId, categoryName} rows is trivial to
 * hold in memory and keeps every keystroke instant with zero further
 * network round trips.
 *
 * Filters only on the item's own status='active', matching the RPC's own
 * authorization surface (record_inventory_withdrawal does not check
 * inventory_categories.is_active at all) -- an item under a now-inactive
 * category is still listed here, intentionally consistent with what the
 * RPC would actually accept.
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
  inventory_categories: { name: string } | { name: string }[] | null;
}

export async function listActiveInventoryItemsForOrganization(
  supabase: SupabaseClient,
  organizationId: string
): Promise<KioskInventoryItem[]> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, name, category_id, inventory_categories(name)")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("name");

  if (error) {
    throw new Error(`listActiveInventoryItemsForOrganization failed: ${error.message}`);
  }

  return ((data ?? []) as InventoryItemRow[]).map((row) => {
    const category = Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories;
    return {
      id: row.id,
      name: row.name,
      categoryId: row.category_id,
      categoryName: category?.name ?? "",
    };
  });
}
