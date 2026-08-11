import crypto from "node:crypto";

/**
 * Short-lived, single-purpose, server-signed token that carries "who just
 * entered their PIN" from the PIN screen to the station/item/quantity
 * screens on a shared kiosk device -- deliberately NOT a session cookie.
 * A shared iPad has no notion of "logged in" that should outlive one
 * transaction; this token expires quickly and is held only in client
 * component state (never a cookie, never localStorage) by the caller.
 *
 * Signed with KIOSK_TOKEN_SECRET, a secret distinct from PIN_PEPPER (the
 * two guard different things and must not be the same value). Pure/no env
 * reads here either, same reasoning as pin.ts -- callers pass the secret in.
 *
 * Two lifetimes are tracked, both server-authoritative:
 *  - KIOSK_TOKEN_TTL_SECONDS: how long any single issued token is valid.
 *  - KIOSK_SESSION_MAX_SECONDS: an absolute ceiling measured from the
 *    original PIN success (sessionStartedAt), which survives every refresh
 *    unchanged. A refreshed token gets a new issuedAt but never a new
 *    sessionStartedAt, so no amount of activity-driven refreshing can keep
 *    a kiosk session alive past the ceiling -- the client may also track
 *    this for UX (a visible session clock, a proactive reset), but it is
 *    never the authority; verifyKioskToken enforces it server-side on every
 *    call, not just at refresh time.
 */

export const KIOSK_TOKEN_TTL_SECONDS = 120;
export const KIOSK_SESSION_MAX_SECONDS = 600;

export interface KioskTokenPayload {
  appUserId: string;
  organizationId: string;
  issuedAt: number;
  sessionStartedAt: number;
  nonce: string;
}

export type VerifyKioskTokenResult =
  | { ok: true; payload: KioskTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "session_expired" };

export type RefreshKioskTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "session_expired" };

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payloadEncoded: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payloadEncoded).digest("hex");
}

/**
 * sessionStartedAt defaults to now() when omitted -- the normal case at PIN
 * verification, which starts a fresh session. A refresh (see
 * refreshKioskToken below) passes the *original* sessionStartedAt through
 * unchanged, which is what makes the absolute ceiling actually absolute.
 */
export function issueKioskToken(
  input: { appUserId: string; organizationId: string; sessionStartedAt?: number },
  secret: string
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: KioskTokenPayload = {
    appUserId: input.appUserId,
    organizationId: input.organizationId,
    issuedAt: now,
    sessionStartedAt: input.sessionStartedAt ?? now,
    nonce: crypto.randomBytes(9).toString("base64url"),
  };
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  return `${payloadEncoded}.${sign(payloadEncoded, secret)}`;
}

export function verifyKioskToken(token: string, secret: string): VerifyKioskTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  const [payloadEncoded, signature] = parts;

  let signatureBuffer: Buffer;
  let expectedBuffer: Buffer;
  try {
    signatureBuffer = Buffer.from(signature, "hex");
    expectedBuffer = Buffer.from(sign(payloadEncoded, secret), "hex");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: KioskTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadEncoded)) as KioskTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);

  const tokenAgeSeconds = now - payload.issuedAt;
  if (tokenAgeSeconds < 0 || tokenAgeSeconds > KIOSK_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  // Enforced here (not only at refresh) so every caller of verifyKioskToken
  // -- recordWithdrawal, the read actions, and refreshKioskToken itself --
  // gets the absolute session ceiling for free, with no duplicated logic.
  const sessionAgeSeconds = now - payload.sessionStartedAt;
  if (sessionAgeSeconds < 0 || sessionAgeSeconds > KIOSK_SESSION_MAX_SECONDS) {
    return { ok: false, reason: "session_expired" };
  }

  return { ok: true, payload };
}

/**
 * Reissues a token for the same employee/session, with a fresh issuedAt
 * (and thus a fresh KIOSK_TOKEN_TTL_SECONDS window) but the *original*
 * sessionStartedAt carried through unchanged. Verifies the incoming token
 * first, so a session already past its absolute ceiling is refused here
 * automatically -- refresh can never extend a session beyond
 * KIOSK_SESSION_MAX_SECONDS from the original PIN success.
 */
export function refreshKioskToken(token: string, secret: string): RefreshKioskTokenResult {
  const verification = verifyKioskToken(token, secret);
  if (!verification.ok) {
    return verification;
  }
  const newToken = issueKioskToken(
    {
      appUserId: verification.payload.appUserId,
      organizationId: verification.payload.organizationId,
      sessionStartedAt: verification.payload.sessionStartedAt,
    },
    secret
  );
  return { ok: true, token: newToken };
}
