/**
 * Client-side pacing for kiosk session refresh. These constants MIRROR the
 * server-authoritative values in app/lib/auth/kioskToken.ts but are
 * deliberately re-declared here rather than imported: that module reads
 * node:crypto and must never end up in a client bundle (this file backs a
 * "use client" component tree), and in any case these two are UX-pacing
 * constants, not the security boundary itself -- the server enforces the
 * real ceiling independently on every call (see kioskToken.ts's
 * verifyKioskToken), so a client-side drift here would only ever make the
 * UI feel slightly early/late, never create a security gap.
 */
export const KIOSK_TOKEN_TTL_SECONDS = 120;
export const KIOSK_SESSION_MAX_SECONDS = 600;

/** Tuning constants, not security boundaries. */
export const REFRESH_AT_TOKEN_AGE_SECONDS = 70;
export const RECENT_ACTIVITY_WINDOW_SECONDS = 30;

export type SessionTickDecision = "refresh" | "expire_idle" | "expire_ceiling" | "noop";

/**
 * Called on a short interval by KioskApp while a session is active.
 * "refresh" as long as the employee interacts at least once every
 * ~70-100 seconds; a genuine idle gap of ~120s with no interaction lets the
 * token lapse client-side too, without waiting for a server round trip to
 * discover what the client can already compute.
 */
export function decideSessionTick(input: {
  now: number;
  tokenClientIssuedAt: number;
  sessionStartedAtClient: number;
  lastActivityAt: number;
}): SessionTickDecision {
  const { now, tokenClientIssuedAt, sessionStartedAtClient, lastActivityAt } = input;

  if (now - sessionStartedAtClient >= KIOSK_SESSION_MAX_SECONDS) {
    return "expire_ceiling";
  }
  if (now - tokenClientIssuedAt >= KIOSK_TOKEN_TTL_SECONDS) {
    return "expire_idle";
  }
  if (
    now - tokenClientIssuedAt >= REFRESH_AT_TOKEN_AGE_SECONDS &&
    now - lastActivityAt <= RECENT_ACTIVITY_WINDOW_SECONDS
  ) {
    return "refresh";
  }
  return "noop";
}
