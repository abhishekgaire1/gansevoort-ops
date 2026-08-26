"use server";

import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { mapItemMasterRpcError, UsageUnitStateError, InvalidUsageUnitConfigurationError } from "@/app/lib/itemMaster/errors";

/**
 * Purchase-versus-usage unit model (approved-plan §8) -- lets an Admin
 * view/add/deactivate/reprioritize an already-confirmed INVENTORY item's
 * kiosk usage units from Item Master, independent of any purchase
 * document. Same requireAdmin gate as the rest of AdminItemDetailView
 * (base unit, deactivation) -- this is a structural Item Master change,
 * not a per-document approval.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export interface ItemUsageUnitSummary {
  usageUnitId: string;
  slot: 1 | 2;
  unitId: string;
  unitCode: string;
  unitName: string;
  confirmedAt: string | null;
  /** Whether this slot is "measure at withdrawal" (weigh-at-kiosk
   * restoration, approved product decision) rather than a fixed
   * conversion factor -- never the factor itself, which this screen
   * never needs or shows. */
  requiresActualMeasurement: boolean;
}

export type ListItemUsageUnitsResult = { ok: true; units: ItemUsageUnitSummary[] } | AuthFailure;

interface UsageUnitRow {
  id: string;
  usage_slot: number;
  confirmed_at: string | null;
  inventory_item_units: { unit_id: string; requires_actual_measurement: boolean; units: { code: string; name: string } | { code: string; name: string }[] | null } | null;
}

export async function listItemUsageUnitsAction(itemId: string): Promise<ListItemUsageUnitsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("inventory_item_usage_units")
    .select("id, usage_slot, confirmed_at, inventory_item_units!inner(unit_id, requires_actual_measurement, units(code, name))")
    .eq("organization_id", auth.manager.organizationId)
    .eq("inventory_item_id", itemId)
    .eq("is_active", true)
    .order("usage_slot", { ascending: true });
  if (error) throw new Error(error.message);

  const units: ItemUsageUnitSummary[] = ((data ?? []) as unknown as UsageUnitRow[]).map((row) => {
    const iiu = row.inventory_item_units;
    const unit = iiu ? ((Array.isArray(iiu.units) ? iiu.units[0] : iiu.units) as { code: string; name: string } | null) : null;
    return {
      usageUnitId: row.id,
      slot: row.usage_slot === 2 ? 2 : 1,
      unitId: iiu?.unit_id ?? "",
      unitCode: unit?.code ?? "",
      unitName: unit?.name ?? "",
      confirmedAt: row.confirmed_at,
      requiresActualMeasurement: iiu?.requires_actual_measurement ?? false,
    };
  });

  return { ok: true, units };
}

export type UsageUnitMutationResult = { ok: true } | AuthFailure | { ok: false; reason: "error"; message: string };

/**
 * requiresActualMeasurement defaults to false (fixed conversion, unchanged
 * behavior). When true, secondaryConversionFactor must be null -- the
 * employee supplies the actual measured base quantity at withdrawal time
 * instead (weigh-at-kiosk restoration, approved product decision). The
 * manager is always the one confirming this mode here -- an AI proposal
 * elsewhere may recommend a mode, but never calls this action directly.
 */
export async function addSecondaryUsageUnitAction(
  itemId: string,
  secondaryUnitCode: string,
  secondaryConversionFactor: number | null,
  requiresActualMeasurement = false
): Promise<UsageUnitMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { error } = await supabase.rpc("manager_add_secondary_usage_unit", {
    p_organization_id: auth.manager.organizationId,
    p_app_user_id: auth.manager.appUserId,
    p_inventory_item_id: itemId,
    p_secondary_unit_code: secondaryUnitCode,
    p_secondary_conversion_factor: secondaryConversionFactor,
    p_requires_actual_measurement: requiresActualMeasurement,
  });
  if (error) {
    const mapped = mapItemMasterRpcError(error);
    return { ok: false, reason: "error", message: mapped instanceof InvalidUsageUnitConfigurationError || mapped instanceof UsageUnitStateError ? mapped.message : "Unable to add secondary usage unit." };
  }
  return { ok: true };
}

export async function deactivateSecondaryUsageUnitAction(itemId: string): Promise<UsageUnitMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { error } = await supabase.rpc("manager_deactivate_secondary_usage_unit", {
    p_organization_id: auth.manager.organizationId,
    p_app_user_id: auth.manager.appUserId,
    p_inventory_item_id: itemId,
  });
  if (error) return { ok: false, reason: "error", message: "Unable to deactivate secondary usage unit." };
  return { ok: true };
}

export async function setPrimaryUsageUnitAction(itemId: string, usageUnitId: string): Promise<UsageUnitMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { error } = await supabase.rpc("manager_set_primary_usage_unit", {
    p_organization_id: auth.manager.organizationId,
    p_app_user_id: auth.manager.appUserId,
    p_inventory_item_id: itemId,
    p_usage_unit_id: usageUnitId,
  });
  if (error) {
    const mapped = mapItemMasterRpcError(error);
    return { ok: false, reason: "error", message: mapped instanceof UsageUnitStateError ? mapped.message : "Unable to change the primary usage unit." };
  }
  return { ok: true };
}
