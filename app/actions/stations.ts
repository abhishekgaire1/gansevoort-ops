"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { verifyKioskToken } from "@/app/lib/auth/kioskToken";
import { listAssignedActiveStationsForEmployee, type KioskStation } from "@/app/lib/kiosk/stations";

export type { KioskStation };

export type ListActiveStationsResult =
  | { ok: true; stations: KioskStation[] }
  | { ok: false; reason: "invalid_token" };

/**
 * Used for the station picker (the "must_pick" branch -- 2+ active
 * assignments, see app/kiosk/_lib/stationBranch.ts) and for the mid-
 * session "Change Station" action. Every kiosk read action re-verifies
 * the token rather than trusting a prior call, same as recordWithdrawal --
 * and, as of 20260811100130, this action ALSO re-resolves the employee's
 * CURRENT active station assignments fresh on every call (never cached in
 * the token), so an assignment removed after login is reflected the very
 * next time this loads, including from an already-open browser session.
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

  const { data: appUser, error: appUserError } = await supabase
    .from("app_users")
    .select("employee_id")
    .eq("id", verification.payload.appUserId)
    .eq("organization_id", verification.payload.organizationId)
    .eq("is_active", true)
    .maybeSingle();

  if (appUserError || !appUser) {
    return { ok: false, reason: "invalid_token" };
  }

  const stations = await listAssignedActiveStationsForEmployee(supabase, verification.payload.organizationId, appUser.employee_id as string);
  return { ok: true, stations };
}
