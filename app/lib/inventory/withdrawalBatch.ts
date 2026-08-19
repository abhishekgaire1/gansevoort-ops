import type { SupabaseClient } from "@supabase/supabase-js";
import { mapInventoryBatchRpcError } from "@/app/lib/inventory/errors";

/**
 * Typed wrapper around record_inventory_withdrawal_batch (2A.5 multi-item
 * cart). The whole cart is submitted as ONE call, becoming one or more
 * ISSUE_TO_STATION movements (one per distinct source location touched)
 * inside a single database transaction -- it either all commits or none
 * of it does. See 20260811100079_withdrawal_batches.sql for the full
 * atomicity/locking/idempotency contract.
 *
 * clientRequestId is required and covers the WHOLE batch, not one line
 * (Part 18) -- reusing it across retries of the same checkout attempt is
 * what makes a retry safe: an identical (once normalized/aggregated)
 * cart replays the original committed result, a changed cart under the
 * same id fails closed instead of silently extending or replacing the
 * original checkout.
 */

export interface WithdrawalBatchCartLine {
  inventoryItemId: string;
  sourceLocationId: string;
  enteredQuantity: string;
  enteredUnitId: string;
  measuredBaseQuantity?: string | null;
}

export interface RecordInventoryWithdrawalBatchInput {
  performedByAppUserId: string;
  stationId: string;
  clientRequestId: string;
  cartLines: WithdrawalBatchCartLine[];
  notes?: string | null;
}

export interface WithdrawalBatchLineResult {
  movementId: string;
  movementLineId: string;
  inventoryItemId: string;
  sourceLocationId: string;
  normalizedBaseQuantity: string;
  baseUnitId: string;
  exceptionId: string | null;
  exceptionRaised: boolean;
}

export interface RecordInventoryWithdrawalBatchResult {
  withdrawalBatchId: string;
  lines: WithdrawalBatchLineResult[];
  replayed: boolean;
}

interface WithdrawalBatchRow {
  out_withdrawal_batch_id: string;
  out_movement_id: string;
  out_movement_line_id: string;
  out_inventory_item_id: string;
  out_source_location_id: string;
  out_normalized_base_quantity: string | number;
  out_base_unit_id: string;
  out_exception_id: string | null;
  out_exception_raised: boolean;
  out_replayed: boolean;
}

export async function recordInventoryWithdrawalBatch(
  supabase: SupabaseClient,
  input: RecordInventoryWithdrawalBatchInput
): Promise<RecordInventoryWithdrawalBatchResult> {
  const { data, error } = await supabase.rpc("record_inventory_withdrawal_batch", {
    p_performed_by_app_user_id: input.performedByAppUserId,
    p_station_id: input.stationId,
    p_client_request_id: input.clientRequestId,
    p_cart_lines: input.cartLines.map((line) => ({
      inventoryItemId: line.inventoryItemId,
      sourceLocationId: line.sourceLocationId,
      enteredQuantity: line.enteredQuantity,
      enteredUnitId: line.enteredUnitId,
      measuredBaseQuantity: line.measuredBaseQuantity ?? null,
    })),
    p_notes: input.notes ?? null,
  });

  if (error) {
    throw mapInventoryBatchRpcError(error);
  }

  const rows = (Array.isArray(data) ? data : data ? [data] : []) as WithdrawalBatchRow[];
  if (rows.length === 0) {
    throw new Error("record_inventory_withdrawal_batch returned no result rows");
  }

  return {
    withdrawalBatchId: rows[0].out_withdrawal_batch_id,
    replayed: rows[0].out_replayed,
    lines: rows.map((row) => ({
      movementId: row.out_movement_id,
      movementLineId: row.out_movement_line_id,
      inventoryItemId: row.out_inventory_item_id,
      sourceLocationId: row.out_source_location_id,
      normalizedBaseQuantity: String(row.out_normalized_base_quantity),
      baseUnitId: row.out_base_unit_id,
      exceptionId: row.out_exception_id,
      exceptionRaised: row.out_exception_raised,
    })),
  };
}
