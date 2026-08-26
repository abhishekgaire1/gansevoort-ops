import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's quantity-entry screen under the
 * purchase-versus-usage unit model (see supabase/migrations/
 * 20260811100119_purchase_usage_units_schema.sql and
 * 20260811100121_withdrawal_kiosk_unit_authorization.sql): an employee
 * withdraws in whichever unit(s) a manager has explicitly confirmed as a
 * kiosk USAGE unit for the item -- one required primary, one optional
 * secondary -- never any vendor purchase-only unit (BOX/CASE as sold),
 * and never a unit this loader didn't itself return.
 *
 * This deliberately returns ONLY what the kiosk needs to display and
 * submit a choice -- unit id, code, name, slot -- and never the
 * conversion_factor those rows carry. The server independently
 * re-derives and re-checks the authoritative factor at withdrawal time
 * (enforce_movement_line_measurement's ISSUE_TO_STATION branch); nothing
 * the browser holds is ever trusted for that arithmetic.
 */

export type KioskUsageSlot = 1 | 2;

export interface KioskUsageUnitOption {
  usageUnitId: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  slot: KioskUsageSlot;
  /** True when this unit is "measure at withdrawal" (approved product
   * decision restoring weigh-at-kiosk support, 20260811100126): no fixed
   * factor is assumed, and the employee must enter the actual measured
   * base quantity directly at withdrawal time -- see
   * enforce_movement_line_measurement. False means the server derives
   * the base quantity from a confirmed fixed conversion_factor instead. */
  requiresActualMeasurement: boolean;
}

export interface KioskUsageUnits {
  primary: KioskUsageUnitOption;
  /** Null when the item has no confirmed secondary usage unit -- never a
   * fabricated placeholder (approved-plan §3). */
  secondary: KioskUsageUnitOption | null;
  /** True only when a secondary exists -- a one-unit item gets rigid,
   * selector-free quantity entry (approved-plan §11). */
  needsSelector: boolean;
  /** The item's own authoritative base unit code -- shown beside the
   * measured-quantity field regardless of which usage unit is selected,
   * since measured_base_quantity is always expressed in THIS unit, never
   * the selected usage unit's own code (weigh-at-kiosk restoration). */
  baseUnitCode: string;
}

export type GetKioskUsageUnitsResult =
  | { ok: true; units: KioskUsageUnits }
  | { ok: false; reason: "item_not_found" | "unit_not_configured" };

interface UsageUnitRow {
  id: string;
  usage_slot: number;
  inventory_item_units: {
    unit_id: string;
    requires_actual_measurement: boolean;
    units: { code: string; name: string } | { code: string; name: string }[] | null;
  } | null;
}

export async function getKioskUsageUnitsForItem(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string
): Promise<GetKioskUsageUnitsResult> {
  const { data: item, error: itemError } = await supabase
    .from("inventory_items")
    .select("id, base_unit_id")
    .eq("id", inventoryItemId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (itemError) {
    throw new Error(`getKioskUsageUnitsForItem item lookup failed: ${itemError.message}`);
  }
  if (!item) {
    return { ok: false, reason: "item_not_found" };
  }

  const { data: baseUnit, error: baseUnitError } = await supabase.from("units").select("code").eq("id", item.base_unit_id).single();
  if (baseUnitError) {
    throw new Error(`getKioskUsageUnitsForItem base-unit lookup failed: ${baseUnitError.message}`);
  }
  const baseUnitCode = baseUnit.code as string;

  const { data: rows, error: rowsError } = await supabase
    .from("inventory_item_usage_units")
    .select("id, usage_slot, inventory_item_units!inner(unit_id, is_active, requires_actual_measurement, units(code, name))")
    .eq("organization_id", organizationId)
    .eq("inventory_item_id", inventoryItemId)
    .eq("is_active", true)
    .eq("inventory_item_units.is_active", true)
    .order("usage_slot", { ascending: true });

  if (rowsError) {
    throw new Error(`getKioskUsageUnitsForItem usage-unit lookup failed: ${rowsError.message}`);
  }

  const toOption = (row: UsageUnitRow): KioskUsageUnitOption | null => {
    const iiu = row.inventory_item_units;
    if (!iiu) return null;
    const unit = (Array.isArray(iiu.units) ? iiu.units[0] : iiu.units) as { code: string; name: string } | null;
    if (!unit) return null;
    const slot = row.usage_slot === 2 ? 2 : 1;
    return {
      usageUnitId: row.id,
      unitId: iiu.unit_id,
      unitCode: unit.code,
      unitName: unit.name,
      slot,
      requiresActualMeasurement: iiu.requires_actual_measurement,
    };
  };

  const options = ((rows ?? []) as unknown as UsageUnitRow[]).map(toOption).filter((o): o is KioskUsageUnitOption => o !== null);

  const primary = options.find((o) => o.slot === 1) ?? null;
  if (!primary) {
    return { ok: false, reason: "unit_not_configured" };
  }
  const secondary = options.find((o) => o.slot === 2) ?? null;

  return {
    ok: true,
    units: { primary, secondary, needsSelector: secondary !== null, baseUnitCode },
  };
}
