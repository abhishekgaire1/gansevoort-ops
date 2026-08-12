import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's quantity-entry screen under the
 * withdrawal-unit simplification: an employee always withdraws in the
 * item's own canonical base unit (inventory_items.base_unit_id -- see
 * units.unit_type for its COUNT/WEIGHT/VOLUME tracking basis), never a
 * packaging unit like BOX/CASE/PACK. Those packaging units stay in
 * inventory_item_units untouched, for a future purchasing/receiving
 * workflow -- this file never lists them.
 *
 * DATA CONVENTION this relies on: every withdrawable item must have an
 * ACTIVE inventory_item_units row for its own base unit (unit_id =
 * base_unit_id), with conversion_factor = 1 and requires_actual_measurement
 * = false -- the base unit is always trivially "one of its own entry
 * units," at a 1:1 conversion. This is what record_inventory_withdrawal's
 * enforce_movement_line_measurement() trigger and the
 * inventory_movement_lines_item_unit_fk constraint require in order to
 * accept entered_unit_id = base_unit_id at all (see
 * 20260811100005_inventory_transactions.sql) -- neither the schema nor the
 * RPC were changed for this simplification, so master data must supply
 * that row for every item (scripts/dev-seed.ts does this for every seeded
 * item). If it's missing, this returns unit_not_configured rather than
 * letting the employee reach a quantity screen that would only fail at
 * final submit.
 */

export interface WithdrawalUnit {
  baseUnitId: string;
  baseUnitCode: string;
  baseUnitName: string;
  baseUnitType: string;
}

export type GetWithdrawalUnitResult =
  | { ok: true; unit: WithdrawalUnit }
  | { ok: false; reason: "item_not_found" | "unit_not_configured" };

interface BaseUnitRow {
  code: string;
  name: string;
  unit_type: string;
}

export async function getWithdrawalUnitForItem(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string
): Promise<GetWithdrawalUnitResult> {
  const { data: item, error: itemError } = await supabase
    .from("inventory_items")
    .select("id, base_unit_id, units(code, name, unit_type)")
    .eq("id", inventoryItemId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (itemError) {
    throw new Error(`getWithdrawalUnitForItem item lookup failed: ${itemError.message}`);
  }
  if (!item) {
    return { ok: false, reason: "item_not_found" };
  }

  const baseUnit = (Array.isArray(item.units) ? item.units[0] : item.units) as BaseUnitRow | null;

  const { data: entryUnit, error: entryUnitError } = await supabase
    .from("inventory_item_units")
    .select("id")
    .eq("inventory_item_id", inventoryItemId)
    .eq("unit_id", item.base_unit_id)
    .eq("is_active", true)
    .maybeSingle();

  if (entryUnitError) {
    throw new Error(`getWithdrawalUnitForItem entry-unit lookup failed: ${entryUnitError.message}`);
  }
  if (!entryUnit) {
    return { ok: false, reason: "unit_not_configured" };
  }

  return {
    ok: true,
    unit: {
      baseUnitId: item.base_unit_id as string,
      baseUnitCode: baseUnit?.code ?? "",
      baseUnitName: baseUnit?.name ?? "",
      baseUnitType: baseUnit?.unit_type ?? "",
    },
  };
}
