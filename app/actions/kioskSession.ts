"use server";

import { refreshKioskToken } from "@/app/lib/auth/kioskToken";

/**
 * Reissues the caller's kiosk token, extending its 120-second TTL while
 * preserving the original session's absolute ceiling (see kioskToken.ts).
 * Deliberately a separate, deliberately-called action rather than piggybacked
 * onto every read action: item search on the kiosk is entirely client-side
 * (no server traffic per keystroke), so a read-triggered refresh scheme
 * would not reliably capture "the employee is still actively using the
 * device." The kiosk UI calls this on a timer, gated by recently-observed
 * user activity (see app/kiosk/_lib/sessionRefresh.ts), not on every tap.
 *
 * No SupabaseClient/database access is needed here -- refreshKioskToken is
 * pure token/crypto logic -- so unlike the read actions in app/actions/
 * (stations.ts, inventoryItems.ts, withdrawalUnit.ts) there is no
 * separate app/lib/kiosk/* core module to split this into.
 */
export type RefreshKioskSessionResult =
  | { ok: true; kioskToken: string }
  | { ok: false; reason: "invalid_token" | "session_expired" };

export async function refreshKioskSession(kioskToken: string): Promise<RefreshKioskSessionResult> {
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) {
    throw new Error("KIOSK_TOKEN_SECRET is not set");
  }

  const result = refreshKioskToken(kioskToken, kioskTokenSecret);
  if (!result.ok) {
    // "session_expired" is surfaced distinctly for observability even though
    // the kiosk UI treats it identically to "invalid_token" -- both trigger
    // the same hard reset to the PIN screen (see app/kiosk/_lib/kioskReducer.ts).
    return result.reason === "session_expired"
      ? { ok: false, reason: "session_expired" }
      : { ok: false, reason: "invalid_token" };
  }

  return { ok: true, kioskToken: result.token };
}
