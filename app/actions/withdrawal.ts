"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { recordInventoryWithdrawal, type RecordInventoryWithdrawalResult } from "@/app/lib/inventory/withdrawal";
import { InsufficientInventoryError, InvalidStorageLocationError } from "@/app/lib/inventory/errors";

/** Generic client-facing message for a genuinely unexpected failure --
 * same wording app/actions/purchaseDocuments.ts already established for
 * this exact situation (its own safeMessage() fallback). */
const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";

function isKnownWithdrawalError(err: unknown): boolean {
  return err instanceof InsufficientInventoryError || err instanceof InvalidStorageLocationError;
}

/** The employee-facing message can stay friendly, but an UNEXPECTED error
 * (not one of the typed business-rule errors above) must never just
 * vanish behind a generic message with no server-side trace -- mirrors
 * app/actions/purchaseDocuments.ts's own logIfUnexpected exactly. This is
 * shared-kiosk-facing, so the client message is especially important to
 * keep generic. */
function logIfUnexpected(actionName: string, err: unknown, context: Record<string, unknown>): void {
  if (!isKnownWithdrawalError(err)) {
    console.error(`${actionName}: unexpected error`, { ...context, error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err });
  }
}

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
    logIfUnexpected("recordWithdrawal", err, { stationId: input.stationId, inventoryItemId: input.inventoryItemId, sourceLocationId: input.sourceLocationId });
    return { ok: false, reason: "rpc_error", message: GENERIC_ERROR_MESSAGE };
  }
}
