"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import {
  recordInventoryWithdrawalBatch,
  type RecordInventoryWithdrawalBatchResult,
  type WithdrawalBatchCartLine,
} from "@/app/lib/inventory/withdrawalBatch";
import { BatchInsufficientInventoryError, InvalidStorageLocationError, type InsufficientBatchLine } from "@/app/lib/inventory/errors";

export interface RecordWithdrawalBatchInput {
  stationId: string;
  cartLines: WithdrawalBatchCartLine[];
  clientRequestId: string;
}

export type RecordWithdrawalBatchResult =
  | { ok: true; result: RecordInventoryWithdrawalBatchResult }
  | {
      ok: false;
      reason: "invalid_token" | "insufficient_inventory" | "invalid_location" | "rpc_error";
      message: string;
      insufficientLines?: InsufficientBatchLine[];
    };

/**
 * The kioskToken here is the short-lived signed token issued by
 * verifyPin, re-verified on every call -- the same trust boundary the
 * single-item recordWithdrawal action uses. The employee identity that
 * ends up on every movement in the batch comes from THIS token, never
 * from client-supplied input.
 */
export async function recordWithdrawalBatch(kioskToken: string, input: RecordWithdrawalBatchInput): Promise<RecordWithdrawalBatchResult> {
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
    const result = await recordInventoryWithdrawalBatch(supabase, {
      performedByAppUserId: verification.payload.appUserId,
      stationId: input.stationId,
      clientRequestId: input.clientRequestId,
      cartLines: input.cartLines,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof BatchInsufficientInventoryError) {
      return {
        ok: false,
        reason: "insufficient_inventory",
        message: "Inventory changed while you were selecting items.",
        insufficientLines: err.lines,
      };
    }
    if (err instanceof InvalidStorageLocationError) {
      return { ok: false, reason: "invalid_location", message: "One of the selected locations is no longer available. Reload and choose again." };
    }
    return { ok: false, reason: "rpc_error", message: err instanceof Error ? err.message : String(err) };
  }
}
