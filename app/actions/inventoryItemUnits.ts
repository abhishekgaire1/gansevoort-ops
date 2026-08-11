"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { listActiveItemUnitsForItem, type KioskItemUnitOption } from "@/app/lib/kiosk/inventoryItemUnits";

export type { KioskItemUnitOption };

export type ListActiveItemUnitsResult =
  | { ok: true; units: KioskItemUnitOption[]; baseUnitCode: string; baseUnitName: string }
  | { ok: false; reason: "invalid_token" | "item_not_found" };

export async function listActiveItemUnits(
  kioskToken: string,
  inventoryItemId: string
): Promise<ListActiveItemUnitsResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const result = await listActiveItemUnitsForItem(supabase, verification.payload.organizationId, inventoryItemId);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, units: result.units, baseUnitCode: result.baseUnitCode, baseUnitName: result.baseUnitName };
}
