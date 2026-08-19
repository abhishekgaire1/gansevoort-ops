"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { listInventoryItemSearchSignals, type InventoryItemSearchSignals } from "@/app/lib/kiosk/searchSignals";

export type { InventoryItemSearchSignals };

export type GetInventorySearchSignalsResult = { ok: true; signals: Record<string, InventoryItemSearchSignals> } | { ok: false; reason: "invalid_token" };

export async function getInventorySearchSignals(kioskToken: string): Promise<GetInventorySearchSignalsResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const signals = await listInventoryItemSearchSignals(supabase, verification.payload.organizationId);
  return { ok: true, signals };
}
