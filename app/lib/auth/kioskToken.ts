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
 */

export const KIOSK_TOKEN_TTL_SECONDS = 120;

export interface KioskTokenPayload {
  appUserId: string;
  organizationId: string;
  issuedAt: number;
  nonce: string;
}

export type VerifyKioskTokenResult =
  | { ok: true; payload: KioskTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payloadEncoded: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payloadEncoded).digest("hex");
}

export function issueKioskToken(
  input: { appUserId: string; organizationId: string },
  secret: string
): string {
  const payload: KioskTokenPayload = {
    appUserId: input.appUserId,
    organizationId: input.organizationId,
    issuedAt: Math.floor(Date.now() / 1000),
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

  const ageSeconds = Math.floor(Date.now() / 1000) - payload.issuedAt;
  if (ageSeconds < 0 || ageSeconds > KIOSK_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}
