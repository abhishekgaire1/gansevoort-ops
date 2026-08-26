"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { getKioskUsageUnitsForItem, type KioskUsageUnits, type KioskUsageUnitOption, type KioskUsageSlot } from "@/app/lib/kiosk/withdrawalUnit";

export type { KioskUsageUnits, KioskUsageUnitOption, KioskUsageSlot };

export type GetKioskUsageUnitsResult =
  | { ok: true; units: KioskUsageUnits }
  | { ok: false; reason: "invalid_token" | "item_not_found" | "unit_not_configured" };

export async function getKioskUsageUnits(kioskToken: string, inventoryItemId: string): Promise<GetKioskUsageUnitsResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const result = await getKioskUsageUnitsForItem(supabase, verification.payload.organizationId, inventoryItemId);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, units: result.units };
}
