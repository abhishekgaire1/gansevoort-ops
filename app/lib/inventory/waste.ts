import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapInventoryWasteRpcError } from "@/app/lib/inventory/errors";
import { resolveEmployeeDisplayNames } from "@/app/lib/inventory/cycleCounts";
import { listInventoryBalances } from "@/app/lib/inventory/listInventoryBalances";
import type { WasteReasonCode } from "@/app/lib/inventory/wasteReasons";

/**
 * Inventory Waste (standalone, Phase B/C): known inventory loss from an
 * EXACT physical storage location, before that inventory is withdrawn to
 * a station. Mirrors record_inventory_withdrawal's structure/idempotency
 * contract closely -- see 20260811100085_inventory_waste.sql's own
 * comments for the exact server-side guarantees. Station waste and
 * Transfers are explicitly out of scope for this milestone.
 *
 * Reason-code constants live in wasteReasons.ts, not here (that module
 * has no "server-only" dependency, so client components can import its
 * runtime values directly -- see that file's own comment).
 */
export type { WasteReasonCode };

export interface StockedItemAtLocation {
  inventoryItemId: string;
  itemName: string;
  baseUnitCode: string;
  balance: number;
}

/**
 * Item picker for the Record Waste flow (Part 7): items with a POSITIVE
 * authoritative balance at the chosen location, never the whole Item
 * Master. Reuses list_inventory_balances -- the SAME authoritative
 * Item+Location balance read the manager's main Inventory page already
 * uses -- filtered here to one location and balance > 0, rather than
 * adding a new location-scoped RPC. Unlike Cycle Count, a zero-balance
 * item is never shown: this workflow immediately subtracts inventory, so
 * there is normally nothing to waste against a system balance of zero
 * (a physical/system mismatch belongs to Cycle Count reconciliation
 * first, not this flow).
 */
export async function listStockedItemsAtLocation(
  supabase: SupabaseClient,
  organizationId: string,
  locationId: string
): Promise<StockedItemAtLocation[]> {
  const balances = await listInventoryBalances(supabase, organizationId);
  return balances
    .filter((row) => row.locationId === locationId && row.balance > 0)
    .map((row) => ({
      inventoryItemId: row.inventoryItemId,
      itemName: row.itemName,
      baseUnitCode: row.baseUnitCode,
      balance: row.balance,
    }))
    .sort((a, b) => a.itemName.localeCompare(b.itemName));
}

export interface RecordInventoryWasteInput {
  recordedByAppUserId: string;
  locationId: string;
  inventoryItemId: string;
  quantity: string;
  reasonCode: WasteReasonCode;
  note?: string | null;
  clientRequestId: string;
}

export interface RecordInventoryWasteResult {
  wasteEventId: string;
  movementId: string;
  movementLineId: string;
  quantity: string;
  unitCode: string;
  replayed: boolean;
}

interface RecordInventoryWasteRow {
  out_waste_event_id: string;
  out_movement_id: string;
  out_movement_line_id: string;
  out_quantity: string | number;
  out_unit_code: string;
  out_replayed: boolean;
}

export async function recordInventoryWaste(supabase: SupabaseClient, input: RecordInventoryWasteInput): Promise<RecordInventoryWasteResult> {
  const { data, error } = await supabase.rpc("record_inventory_waste", {
    p_recorded_by_app_user_id: input.recordedByAppUserId,
    p_location_id: input.locationId,
    p_inventory_item_id: input.inventoryItemId,
    p_quantity: input.quantity,
    p_reason_code: input.reasonCode,
    p_note: input.note ?? null,
    p_client_request_id: input.clientRequestId,
  });

  if (error) {
    throw mapInventoryWasteRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as RecordInventoryWasteRow | undefined;
  if (!row) {
    throw new Error("record_inventory_waste returned no result row");
  }

  return {
    wasteEventId: row.out_waste_event_id,
    movementId: row.out_movement_id,
    movementLineId: row.out_movement_line_id,
    quantity: String(row.out_quantity),
    unitCode: row.out_unit_code,
    replayed: row.out_replayed,
  };
}

export interface InventoryWasteEventSummary {
  wasteEventId: string;
  locationId: string;
  locationName: string;
  inventoryItemId: string;
  itemName: string;
  quantity: string;
  unitCode: string;
  reasonCode: WasteReasonCode;
  note: string | null;
  recordedByAppUserId: string;
  recordedByName: string;
  recordedAt: string;
  inventoryMovementId: string;
  cycleCountId: string | null;
}

interface ListInventoryWasteEventsRow {
  out_waste_event_id: string;
  out_location_id: string;
  out_location_name: string;
  out_inventory_item_id: string;
  out_item_name: string;
  out_quantity: string | number;
  out_unit_code: string;
  out_reason_code: string;
  out_note: string | null;
  out_recorded_by_app_user_id: string;
  out_recorded_at: string;
  out_inventory_movement_id: string;
  out_cycle_count_id: string | null;
}

export interface ListInventoryWasteEventsInput {
  organizationId: string;
  locationId?: string | null;
  reasonCode?: WasteReasonCode | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
}

export async function listInventoryWasteEvents(
  supabase: SupabaseClient,
  input: ListInventoryWasteEventsInput
): Promise<InventoryWasteEventSummary[]> {
  const { data, error } = await supabase.rpc("list_inventory_waste_events", {
    p_organization_id: input.organizationId,
    p_location_id: input.locationId ?? null,
    p_reason_code: input.reasonCode ?? null,
    p_from_date: input.fromDate ?? null,
    p_to_date: input.toDate ?? null,
    p_limit: input.limit ?? 50,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ListInventoryWasteEventsRow[];
  const names = await resolveEmployeeDisplayNames(supabase, rows.map((row) => row.out_recorded_by_app_user_id));

  return rows.map((row) => ({
    wasteEventId: row.out_waste_event_id,
    locationId: row.out_location_id,
    locationName: row.out_location_name,
    inventoryItemId: row.out_inventory_item_id,
    itemName: row.out_item_name,
    quantity: String(row.out_quantity),
    unitCode: row.out_unit_code,
    reasonCode: row.out_reason_code as WasteReasonCode,
    note: row.out_note,
    recordedByAppUserId: row.out_recorded_by_app_user_id,
    recordedByName: names.get(row.out_recorded_by_app_user_id) ?? "",
    recordedAt: row.out_recorded_at,
    inventoryMovementId: row.out_inventory_movement_id,
    cycleCountId: row.out_cycle_count_id,
  }));
}

export interface InventoryWasteEventDetail extends InventoryWasteEventSummary {
  cycleCountLineId: string | null;
}

interface GetInventoryWasteDetailRow extends ListInventoryWasteEventsRow {
  out_cycle_count_line_id: string | null;
}

export async function getInventoryWasteDetail(
  supabase: SupabaseClient,
  organizationId: string,
  wasteEventId: string
): Promise<InventoryWasteEventDetail | null> {
  const { data, error } = await supabase.rpc("get_inventory_waste_detail", {
    p_organization_id: organizationId,
    p_waste_event_id: wasteEventId,
  });
  if (error) throw new Error(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as GetInventoryWasteDetailRow | undefined;
  if (!row) return null;

  const names = await resolveEmployeeDisplayNames(supabase, [row.out_recorded_by_app_user_id]);

  return {
    wasteEventId: row.out_waste_event_id,
    locationId: row.out_location_id,
    locationName: row.out_location_name,
    inventoryItemId: row.out_inventory_item_id,
    itemName: row.out_item_name,
    quantity: String(row.out_quantity),
    unitCode: row.out_unit_code,
    reasonCode: row.out_reason_code as WasteReasonCode,
    note: row.out_note,
    recordedByAppUserId: row.out_recorded_by_app_user_id,
    recordedByName: names.get(row.out_recorded_by_app_user_id) ?? "",
    recordedAt: row.out_recorded_at,
    inventoryMovementId: row.out_inventory_movement_id,
    cycleCountId: row.out_cycle_count_id,
    cycleCountLineId: row.out_cycle_count_line_id,
  };
}
