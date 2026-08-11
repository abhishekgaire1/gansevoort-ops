import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's unit + quantity entry screen.
 * Drives that screen's field layout entirely off this metadata (see
 * app/kiosk/_lib/quantityEntry.ts) -- no item-specific UI logic anywhere.
 *
 * Also returns the item's own base unit name/code: the "actual measured
 * quantity" field for a requires_actual_measurement unit (e.g. "2 BOX" of
 * chicken thighs) must be labeled in the item's base unit ("Actual weight
 * measured (Pounds)"), not the entry unit -- inventory_items.base_unit_id,
 * not inventory_item_units, is where that lives.
 */

export interface KioskItemUnitOption {
  unitId: string;
  unitCode: string;
  unitName: string;
  conversionFactor: string | null;
  requiresActualMeasurement: boolean;
  isDefaultEntryUnit: boolean;
}

export type ListActiveItemUnitsCoreResult =
  | { ok: true; units: KioskItemUnitOption[]; baseUnitCode: string; baseUnitName: string }
  | { ok: false; reason: "item_not_found" };

interface ItemUnitRow {
  unit_id: string;
  conversion_factor: string | number | null;
  requires_actual_measurement: boolean;
  is_default_entry_unit: boolean;
  units: { code: string; name: string } | { code: string; name: string }[] | null;
}

/**
 * Confirms the item resolves within the token's own organization before
 * returning its units -- item_not_found covers both "wrong org" and
 * "doesn't exist" without distinguishing, the same anti-enumeration spirit
 * as the PIN design (though the stakes here are much lower: item names,
 * not credentials).
 */
export async function listActiveItemUnitsForItem(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string
): Promise<ListActiveItemUnitsCoreResult> {
  const { data: item, error: itemError } = await supabase
    .from("inventory_items")
    .select("id, units(code, name)")
    .eq("id", inventoryItemId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (itemError) {
    throw new Error(`listActiveItemUnitsForItem item lookup failed: ${itemError.message}`);
  }
  if (!item) {
    return { ok: false, reason: "item_not_found" };
  }

  const baseUnit = Array.isArray(item.units) ? item.units[0] : item.units;

  const { data, error } = await supabase
    .from("inventory_item_units")
    .select("unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, units(code, name)")
    .eq("inventory_item_id", inventoryItemId)
    .eq("is_active", true);

  if (error) {
    throw new Error(`listActiveItemUnitsForItem units lookup failed: ${error.message}`);
  }

  const units: KioskItemUnitOption[] = ((data ?? []) as ItemUnitRow[]).map((row) => {
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    return {
      unitId: row.unit_id,
      unitCode: unit?.code ?? "",
      unitName: unit?.name ?? "",
      conversionFactor: row.conversion_factor === null ? null : String(row.conversion_factor),
      requiresActualMeasurement: row.requires_actual_measurement,
      isDefaultEntryUnit: row.is_default_entry_unit,
    };
  });

  return { ok: true, units, baseUnitCode: baseUnit?.code ?? "", baseUnitName: baseUnit?.name ?? "" };
}
