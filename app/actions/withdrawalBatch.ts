"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import {
  recordInventoryWithdrawalBatch,
  type RecordInventoryWithdrawalBatchResult,
  type WithdrawalBatchCartLine,
} from "@/app/lib/inventory/withdrawalBatch";
import { BatchInsufficientInventoryError, InvalidStorageLocationError, KioskUsageUnitNotAuthorizedError, type InsufficientBatchLine } from "@/app/lib/inventory/errors";

/** Generic client-facing message for a genuinely unexpected failure --
 * same wording app/actions/purchaseDocuments.ts already established for
 * this exact situation (its own safeMessage() fallback). */
const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";

function isKnownWithdrawalBatchError(err: unknown): boolean {
  return err instanceof BatchInsufficientInventoryError || err instanceof InvalidStorageLocationError || err instanceof KioskUsageUnitNotAuthorizedError;
}

/** The employee-facing message can stay friendly, but an UNEXPECTED error
 * must never just vanish behind a generic message with no server-side
 * trace -- mirrors app/actions/purchaseDocuments.ts's own
 * logIfUnexpected exactly. Shared-kiosk-facing, same as recordWithdrawal. */
function logIfUnexpected(actionName: string, err: unknown, context: Record<string, unknown>): void {
  if (!isKnownWithdrawalBatchError(err)) {
    console.error(`${actionName}: unexpected error`, { ...context, error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err });
  }
}

export interface RecordWithdrawalBatchInput {
  stationId: string;
  cartLines: WithdrawalBatchCartLine[];
  clientRequestId: string;
}

export type RecordWithdrawalBatchResult =
  | { ok: true; result: RecordInventoryWithdrawalBatchResult }
  | {
      ok: false;
      reason: "invalid_token" | "insufficient_inventory" | "invalid_location" | "unit_not_authorized" | "rpc_error";
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
    if (err instanceof KioskUsageUnitNotAuthorizedError) {
      return { ok: false, reason: "unit_not_authorized", message: "One item's withdrawal unit changed. Reload and choose again." };
    }
    logIfUnexpected("recordWithdrawalBatch", err, { stationId: input.stationId, lineCount: input.cartLines.length });
    return { ok: false, reason: "rpc_error", message: GENERIC_ERROR_MESSAGE };
  }
}
