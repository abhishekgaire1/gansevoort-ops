"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { recordInventoryWithdrawal, type RecordInventoryWithdrawalResult } from "@/app/lib/inventory/withdrawal";

export interface RecordWithdrawalInput {
  stationId: string;
  inventoryItemId: string;
  enteredQuantity: string;
  enteredUnitId: string;
  measuredBaseQuantity?: string | null;
  notes?: string | null;
}

export type RecordWithdrawalResult =
  | { ok: true; result: RecordInventoryWithdrawalResult }
  | { ok: false; reason: "invalid_token" | "rpc_error"; message?: string };

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
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();

  try {
    const result = await recordInventoryWithdrawal(supabase, {
      performedByAppUserId: verification.payload.appUserId,
      stationId: input.stationId,
      inventoryItemId: input.inventoryItemId,
      enteredQuantity: input.enteredQuantity,
      enteredUnitId: input.enteredUnitId,
      measuredBaseQuantity: input.measuredBaseQuantity ?? null,
      notes: input.notes ?? null,
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: "rpc_error", message: err instanceof Error ? err.message : String(err) };
  }
}
