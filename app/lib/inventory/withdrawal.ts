import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Typed wrapper around the record_inventory_withdrawal RPC. Accepts an
 * already-authenticated SupabaseClient (the service-role client, in
 * practice) rather than constructing its own, keeping this module
 * framework-agnostic and directly testable.
 *
 * Quantities are typed as strings, not numbers, on both sides: PostgREST
 * accepts numeric RPC parameters as strings without precision loss, and
 * returning them as strings avoids passing an exact Postgres NUMERIC
 * through a JS float64 unnecessarily (docs/DATABASE.md: quantities are
 * NUMERIC, not floating point).
 *
 * clientRequestId is required (not optional): the RPC itself rejects a null
 * client_request_id for every new withdrawal it creates (see migration
 * 20260811100015_withdrawal_idempotency.sql), so there is no valid call
 * into this function without one. Reusing the same clientRequestId across
 * retries of the same submission attempt makes retries safe -- a retry
 * with an identical payload replays the original result (replayed: true,
 * no new rows); a retry with the same id but a different payload fails
 * closed instead of silently returning an unrelated withdrawal.
 */

export interface RecordInventoryWithdrawalInput {
  performedByAppUserId: string;
  stationId: string;
  inventoryItemId: string;
  enteredQuantity: string;
  enteredUnitId: string;
  measuredBaseQuantity?: string | null;
  notes?: string | null;
  clientRequestId: string;
}

export interface RecordInventoryWithdrawalResult {
  movementId: string;
  movementLineId: string;
  normalizedBaseQuantity: string;
  baseUnitId: string;
  exceptionId: string | null;
  exceptionRaised: boolean;
  replayed: boolean;
}

interface RecordInventoryWithdrawalRow {
  movement_id: string;
  movement_line_id: string;
  normalized_base_quantity: string | number;
  base_unit_id: string;
  exception_id: string | null;
  exception_raised: boolean;
  replayed: boolean;
}

export async function recordInventoryWithdrawal(
  supabase: SupabaseClient,
  input: RecordInventoryWithdrawalInput
): Promise<RecordInventoryWithdrawalResult> {
  const { data, error } = await supabase.rpc("record_inventory_withdrawal", {
    p_performed_by_app_user_id: input.performedByAppUserId,
    p_station_id: input.stationId,
    p_inventory_item_id: input.inventoryItemId,
    p_entered_quantity: input.enteredQuantity,
    p_entered_unit_id: input.enteredUnitId,
    p_measured_base_quantity: input.measuredBaseQuantity ?? null,
    p_notes: input.notes ?? null,
    p_client_request_id: input.clientRequestId,
  });

  if (error) {
    throw new Error(`record_inventory_withdrawal failed: ${error.message}`);
  }

  // supabase-js returns a single-row RETURNS TABLE result as a one-element array.
  const row = (Array.isArray(data) ? data[0] : data) as RecordInventoryWithdrawalRow | undefined;
  if (!row) {
    throw new Error("record_inventory_withdrawal returned no result row");
  }

  return {
    movementId: row.movement_id,
    movementLineId: row.movement_line_id,
    normalizedBaseQuantity: String(row.normalized_base_quantity),
    baseUnitId: row.base_unit_id,
    exceptionId: row.exception_id,
    exceptionRaised: row.exception_raised,
    replayed: row.replayed,
  };
}
