"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveEmployeeDisplayNames } from "@/app/lib/inventory/cycleCounts";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * RC1 High-Withdrawal Manager Visibility -- read-only. exceptions rows
 * are the durable, already-authoritative HIGH_WITHDRAWAL facts
 * (20260811100076/100080/100112); this file only resolves them into a
 * manager-friendly shape (names instead of ids, employee display name)
 * -- it never recalculates a threshold, a quantity, or a status, and it
 * never writes to exceptions/user_notifications (those tables are only
 * ever written by the SECURITY DEFINER RPCs, from the service role).
 *
 * There is no established review/resolution lifecycle to build on:
 * exceptions.status/resolved_at/resolved_by_app_user_id/resolution_notes
 * exist in the schema, but nothing in this codebase has ever written
 * anything other than the 'open' default to them (verified: zero
 * `update public.exceptions` in the entire migration history) -- so
 * `status` is surfaced here as a plain, read-only fact, never with an
 * Acknowledge/Resolve/Approve/Reject action attached.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";

/** Same safe-error convention as app/actions/cycleCounts.ts /
 * inventoryWaste.ts / withdrawal.ts -- this file has no recognized
 * business-rule errors of its own (it's read-only), so every caught
 * error here is by definition unexpected and is always logged. */
function logUnexpected(actionName: string, err: unknown, context: Record<string, unknown>): void {
  console.error(`${actionName}: unexpected error`, { ...context, error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err });
}

export interface HighWithdrawalAlert {
  exceptionId: string;
  occurredAt: string;
  itemId: string;
  itemName: string;
  stationId: string;
  stationName: string;
  employeeName: string;
  sourceLocationId: string | null;
  sourceLocationName: string | null;
  observedQuantity: number;
  thresholdQuantity: number;
  unitCode: string;
  status: string;
}

interface ExceptionRow {
  id: string;
  opened_at: string;
  inventory_item_id: string;
  station_id: string;
  observed_quantity: number;
  threshold_quantity_at_detection: number;
  base_unit_id: string;
  source_movement_id: string;
  status: string;
}

/** Shared enrichment step (names instead of ids) for both the list and
 * detail actions -- deliberately plain, separate lookups rather than a
 * PostgREST embedded join, since exceptions' foreign keys to
 * inventory_movements/inventory_items/stations are all COMPOSITE
 * (id, organization_id) -- not the shape PostgREST's automatic
 * relationship inference reliably follows. */
async function enrichExceptionRows(supabase: SupabaseClient, organizationId: string, rows: ExceptionRow[]): Promise<HighWithdrawalAlert[]> {
  if (rows.length === 0) return [];

  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id))];
  const stationIds = [...new Set(rows.map((r) => r.station_id))];
  const unitIds = [...new Set(rows.map((r) => r.base_unit_id))];
  const movementIds = [...new Set(rows.map((r) => r.source_movement_id))];

  const [itemsResult, stationsResult, unitsResult, movementsResult] = await Promise.all([
    supabase.from("inventory_items").select("id, name").eq("organization_id", organizationId).in("id", itemIds),
    supabase.from("stations").select("id, name").eq("organization_id", organizationId).in("id", stationIds),
    supabase.from("units").select("id, code").in("id", unitIds),
    supabase.from("inventory_movements").select("id, performed_by_app_user_id, location_id").eq("organization_id", organizationId).in("id", movementIds),
  ]);

  const itemNameById = new Map((itemsResult.data ?? []).map((r) => [r.id as string, r.name as string]));
  const stationNameById = new Map((stationsResult.data ?? []).map((r) => [r.id as string, r.name as string]));
  const unitCodeById = new Map((unitsResult.data ?? []).map((r) => [r.id as string, r.code as string]));
  const movementById = new Map((movementsResult.data ?? []).map((r) => [r.id as string, r as { performed_by_app_user_id: string | null; location_id: string }]));

  const locationIds = [...new Set([...movementById.values()].map((m) => m.location_id).filter((id): id is string => Boolean(id)))];
  const appUserIds = [...new Set([...movementById.values()].map((m) => m.performed_by_app_user_id).filter((id): id is string => Boolean(id)))];

  const [locationsResult, employeeNameByAppUserId] = await Promise.all([
    locationIds.length > 0 ? supabase.from("locations").select("id, name").eq("organization_id", organizationId).in("id", locationIds) : Promise.resolve({ data: [] }),
    resolveEmployeeDisplayNames(supabase, appUserIds),
  ]);
  const locationNameById = new Map((locationsResult.data ?? []).map((r) => [r.id as string, r.name as string]));

  return rows.map((row) => {
    const movement = movementById.get(row.source_movement_id);
    const sourceLocationId = movement?.location_id ?? null;
    return {
      exceptionId: row.id,
      occurredAt: row.opened_at,
      itemId: row.inventory_item_id,
      itemName: itemNameById.get(row.inventory_item_id) ?? "—",
      stationId: row.station_id,
      stationName: stationNameById.get(row.station_id) ?? "—",
      employeeName: movement?.performed_by_app_user_id ? (employeeNameByAppUserId.get(movement.performed_by_app_user_id) ?? "—") : "—",
      sourceLocationId,
      sourceLocationName: sourceLocationId ? (locationNameById.get(sourceLocationId) ?? "—") : null,
      observedQuantity: Number(row.observed_quantity),
      thresholdQuantity: Number(row.threshold_quantity_at_detection),
      unitCode: unitCodeById.get(row.base_unit_id) ?? "—",
      status: row.status,
    };
  });
}

export type ListHighWithdrawalAlertsResult = { ok: true; alerts: HighWithdrawalAlert[] } | AuthFailure | { ok: false; reason: "load_failed"; message: string };

/** Newest first (Section 4B). Organization comes only from the
 * authenticated manager context -- never a client-supplied value. */
export async function listHighWithdrawalAlertsAction(): Promise<ListHighWithdrawalAlertsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const supabase = getServiceRoleClient();
    const { data, error } = await supabase
      .from("exceptions")
      .select("id, opened_at, inventory_item_id, station_id, observed_quantity, threshold_quantity_at_detection, base_unit_id, source_movement_id, status")
      .eq("organization_id", auth.manager.organizationId)
      .eq("exception_type", "HIGH_WITHDRAWAL")
      .order("opened_at", { ascending: false });

    if (error) throw new Error(error.message);

    const alerts = await enrichExceptionRows(supabase, auth.manager.organizationId, (data ?? []) as ExceptionRow[]);
    return { ok: true, alerts };
  } catch (err) {
    logUnexpected("listHighWithdrawalAlertsAction", err, { organizationId: auth.manager.organizationId });
    return { ok: false, reason: "load_failed", message: GENERIC_ERROR_MESSAGE };
  }
}

export type GetHighWithdrawalAlertResult = { ok: true; alert: HighWithdrawalAlert | null } | AuthFailure | { ok: false; reason: "load_failed"; message: string };

/** Org-scoped by construction (Section 4C: cross-organization access
 * "rejected/not-found") -- an exceptionId from another organization (or
 * one that doesn't exist, or isn't a HIGH_WITHDRAWAL exception) simply
 * resolves to `alert: null`, exactly like getInventoryWasteDetailAction's
 * existing convention; never another org's data, never a distinguishing
 * error that would confirm a different org's exception exists. */
export async function getHighWithdrawalAlertAction(exceptionId: string): Promise<GetHighWithdrawalAlertResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const supabase = getServiceRoleClient();
    const { data, error } = await supabase
      .from("exceptions")
      .select("id, opened_at, inventory_item_id, station_id, observed_quantity, threshold_quantity_at_detection, base_unit_id, source_movement_id, status")
      .eq("organization_id", auth.manager.organizationId)
      .eq("exception_type", "HIGH_WITHDRAWAL")
      .eq("id", exceptionId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return { ok: true, alert: null };

    const [alert] = await enrichExceptionRows(supabase, auth.manager.organizationId, [data as ExceptionRow]);
    return { ok: true, alert: alert ?? null };
  } catch (err) {
    logUnexpected("getHighWithdrawalAlertAction", err, { organizationId: auth.manager.organizationId, exceptionId });
    return { ok: false, reason: "load_failed", message: GENERIC_ERROR_MESSAGE };
  }
}
