"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { listEmployeeRecentWithdrawnItemIds } from "@/app/lib/kiosk/recentItems";

export type GetEmployeeRecentWithdrawnItemIdsResult = { ok: true; itemIds: string[] } | { ok: false; reason: "invalid_token" };

/**
 * Personalized to the token's own appUserId (2A.5 §14) -- an employee can
 * never fetch another employee's recent list, since the id driving this
 * query comes from the signed kiosk token, never a client-supplied
 * parameter.
 */
export async function getEmployeeRecentWithdrawnItemIds(kioskToken: string): Promise<GetEmployeeRecentWithdrawnItemIdsResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const itemIds = await listEmployeeRecentWithdrawnItemIds(supabase, verification.payload.organizationId, verification.payload.appUserId);
  return { ok: true, itemIds };
}
