"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { getWithdrawalUnitForItem, type WithdrawalUnit } from "@/app/lib/kiosk/withdrawalUnit";

export type { WithdrawalUnit };

export type GetWithdrawalUnitResult =
  | { ok: true; unit: WithdrawalUnit }
  | { ok: false; reason: "invalid_token" | "item_not_found" | "unit_not_configured" };

export async function getWithdrawalUnit(kioskToken: string, inventoryItemId: string): Promise<GetWithdrawalUnitResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const result = await getWithdrawalUnitForItem(supabase, verification.payload.organizationId, inventoryItemId);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, unit: result.unit };
}
