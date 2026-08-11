"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { listActiveInventoryItemsForOrganization, type KioskInventoryItem } from "@/app/lib/kiosk/inventoryItems";

export type { KioskInventoryItem };

export type ListActiveInventoryItemsResult =
  | { ok: true; items: KioskInventoryItem[] }
  | { ok: false; reason: "invalid_token" };

export async function listActiveInventoryItems(kioskToken: string): Promise<ListActiveInventoryItemsResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const items = await listActiveInventoryItemsForOrganization(supabase, verification.payload.organizationId);
  return { ok: true, items };
}
