"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { getKioskItemAvailability, type KioskLocationAvailability } from "@/app/lib/kiosk/stockAvailability";

export type { KioskLocationAvailability };

export type GetKioskItemAvailabilityResult = { ok: true; locations: KioskLocationAvailability[] } | { ok: false; reason: "invalid_token" };

/**
 * Fetched once an employee selects an item, alongside getWithdrawalUnit --
 * drives the kiosk's stock card and, when more than one location has
 * stock, the required "Take From" choice (never auto-guessed, never
 * pro-rata for a new withdrawal). An empty array means genuinely no
 * stock anywhere -- the kiosk renders "No inventory is currently
 * available" and disables Withdraw, never a fake 0%.
 */
export async function getKioskItemAvailabilityAction(kioskToken: string, inventoryItemId: string): Promise<GetKioskItemAvailabilityResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const locations = await getKioskItemAvailability(supabase, verification.payload.organizationId, inventoryItemId);
  return { ok: true, locations };
}
