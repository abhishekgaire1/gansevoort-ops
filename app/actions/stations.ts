"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { listActiveStationsForOrganization, type KioskStation } from "@/app/lib/kiosk/stations";

export type { KioskStation };

export type ListActiveStationsResult =
  | { ok: true; stations: KioskStation[] }
  | { ok: false; reason: "invalid_token" };

/**
 * Used for the station picker: employees with can_change_station=true, or
 * whose auto_resolve_station=false (must_pick branch, see
 * app/kiosk/_lib/stationBranch.ts). Every kiosk read action re-verifies the
 * token rather than trusting a prior call, same as recordWithdrawal.
 */
export async function listActiveStations(kioskToken: string): Promise<ListActiveStationsResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const verification = verifyKioskToken(kioskToken, kioskTokenSecret);
  if (!verification.ok) {
    return { ok: false, reason: "invalid_token" };
  }

  const supabase = getServiceRoleClient();
  const stations = await listActiveStationsForOrganization(supabase, verification.payload.organizationId);
  return { ok: true, stations };
}
