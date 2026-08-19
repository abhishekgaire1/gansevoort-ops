"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { recordInventoryWithdrawal, type RecordInventoryWithdrawalResult } from "@/app/lib/inventory/withdrawal";
import { InsufficientInventoryError, InvalidStorageLocationError } from "@/app/lib/inventory/errors";

export interface RecordWithdrawalInput {
  stationId: string;
  inventoryItemId: string;
  /** The physical storage location the item is withdrawn from -- see
   * app/lib/inventory/withdrawal.ts's doc comment. Required for every
   * new withdrawal (2A.5). */
  sourceLocationId: string;
  enteredQuantity: string;
  enteredUnitId: string;
  measuredBaseQuantity?: string | null;
  notes?: string | null;
  /** Generated once client-side per withdrawal attempt and reused verbatim
   * across retries of that same attempt -- see kioskReducer.ts's
   * SUBMIT_ATTEMPT_STARTED action. Makes recordWithdrawal safe to retry
   * after a network/server failure without risking a duplicate movement. */
  clientRequestId: string;
}

export type RecordWithdrawalResult =
  | { ok: true; result: RecordInventoryWithdrawalResult }
  | { ok: false; reason: "invalid_token" | "insufficient_inventory" | "invalid_location" | "rpc_error"; message: string; availableQuantity?: number | null };

/**
 * The kioskToken here is the short-lived signed token issued by verifyPin,
 * not a session cookie -- re-verified on every call so a stale/expired
 * handoff can never record a withdrawal, even if the client held onto it.
 */
export async function recordWithdrawal(
  kioskToken: string,
  input: RecordWithdrawalInput
): Promise<RecordWithdrawalResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token", message: "Your session has expired. Please sign in again." };
  }

  const supabase = getServiceRoleClient();

  try {
    const result = await recordInventoryWithdrawal(supabase, {
      performedByAppUserId: verification.payload.appUserId,
      stationId: input.stationId,
      inventoryItemId: input.inventoryItemId,
      sourceLocationId: input.sourceLocationId,
      enteredQuantity: input.enteredQuantity,
      enteredUnitId: input.enteredUnitId,
      measuredBaseQuantity: input.measuredBaseQuantity ?? null,
      notes: input.notes ?? null,
      clientRequestId: input.clientRequestId,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof InsufficientInventoryError) {
      const available = err.availableQuantity;
      return {
        ok: false,
        reason: "insufficient_inventory",
        message: available !== null ? `Only ${available} is currently available at this location.` : "Not enough inventory is currently available at this location.",
        availableQuantity: available,
      };
    }
    if (err instanceof InvalidStorageLocationError) {
      return { ok: false, reason: "invalid_location", message: "That location is no longer available. Reload and choose again." };
    }
    return { ok: false, reason: "rpc_error", message: err instanceof Error ? err.message : String(err) };
  }
}
