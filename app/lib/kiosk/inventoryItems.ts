import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's item-selection screen.
 *
 * Milestone 2A.5 correction: the kiosk is a WITHDRAWAL interface, so its
 * normal grid must show ONLY items with a POSITIVE total available
 * balance in at least one active, storage-eligible location -- never the
 * full Item Master catalog. An item being confirmed in Item Master does
 * not mean it is physically available; showing every confirmed item
 * regardless of stock (the pre-2A.5 behavior) produced dead-end cards
 * like "Burrata Mozzarella Cheese" that always landed on "No inventory is
 * currently available" once tapped.
 *
 * Sourced from list_kiosk_available_inventory (20260811100077) -- ONE
 * efficient server-side query, never one balance request per card. That
 * query already reuses the same authoritative exact+frozen-legacy
 * balance formula the manager page and per-item kiosk lookup use, so the
 * grid, the stock card, and the source-location picker can never
 * disagree about what "available" means. The result is small (dozens of
 * rows at most for a real org), so search/category filtering stays
 * entirely client-side afterward, same as before (app/kiosk/_lib/
 * itemFilter.ts).
 *
 * Also still excludes any item that isn't actually withdrawable: the
 * withdrawal-unit simplification requires an ACTIVE, self-referencing
 * inventory_item_units row for the item's own base_unit_id (see
 * app/lib/kiosk/withdrawalUnit.ts) -- an item missing that row would only
 * fail once selected. This safety net is unchanged from before 2A.5.
 */

export interface KioskInventoryItem {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  baseUnitCode: string;
  /** Total available quantity summed across every currently-positive
   * storage location -- shown directly on the grid card. */
  totalAvailableQuantity: number;
  positiveLocationCount: number;
  /** Populated ONLY when positiveLocationCount === 1 -- lets the card
   * (and the immediately-following quantity screen) show a real gauge
   * without a second round trip. Null when more than one location has
   * stock; the employee resolves which one via the "Take From" step. */
  singleLocation: {
    locationId: string;
    locationName: string;
    fullReferenceQuantity: number | null;
    referenceSource: "RESTOCK" | "MANAGER_OVERRIDE" | null;
  } | null;
}

interface KioskAvailableInventoryRow {
  out_inventory_item_id: string;
  out_item_name: string;
  out_category_id: string;
  out_category_name: string;
  out_base_unit_code: string;
  out_total_available_quantity: number | string;
  out_positive_location_count: number;
  out_single_location_id: string | null;
  out_single_location_name: string | null;
  out_single_location_full_reference_quantity: number | string | null;
  out_single_location_reference_source: "RESTOCK" | "MANAGER_OVERRIDE" | null;
}

export async function listActiveInventoryItemsForOrganization(
  supabase: SupabaseClient,
  organizationId: string
): Promise<KioskInventoryItem[]> {
  const { data, error } = await supabase.rpc("list_kiosk_available_inventory", { p_organization_id: organizationId });
  if (error) {
    throw new Error(`list_kiosk_available_inventory failed: ${error.message}`);
  }

  const rows = (data ?? []) as KioskAvailableInventoryRow[];
  if (rows.length === 0) {
    return [];
  }

  const { data: entryUnits, error: entryUnitsError } = await supabase
    .from("inventory_items")
    .select("id, base_unit_id, inventory_item_units!inner(unit_id, is_active)")
    .in(
      "id",
      rows.map((row) => row.out_inventory_item_id)
    )
    .eq("inventory_item_units.is_active", true);

  if (entryUnitsError) {
    throw new Error(`listActiveInventoryItemsForOrganization entry-unit lookup failed: ${entryUnitsError.message}`);
  }

  const withdrawableItemIds = new Set(
    ((entryUnits ?? []) as { id: string; base_unit_id: string; inventory_item_units: { unit_id: string }[] }[])
      .filter((row) => row.inventory_item_units.some((u) => u.unit_id === row.base_unit_id))
      .map((row) => row.id)
  );

  return rows
    .filter((row) => withdrawableItemIds.has(row.out_inventory_item_id))
    .map((row) => ({
      id: row.out_inventory_item_id,
      name: row.out_item_name,
      categoryId: row.out_category_id,
      categoryName: row.out_category_name,
      baseUnitCode: row.out_base_unit_code,
      totalAvailableQuantity: Number(row.out_total_available_quantity),
      positiveLocationCount: row.out_positive_location_count,
      singleLocation:
        row.out_single_location_id !== null
          ? {
              locationId: row.out_single_location_id,
              locationName: row.out_single_location_name!,
              fullReferenceQuantity: row.out_single_location_full_reference_quantity === null ? null : Number(row.out_single_location_full_reference_quantity),
              referenceSource: row.out_single_location_reference_source,
            }
          : null,
    }));
}
