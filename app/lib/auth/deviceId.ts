import crypto from "node:crypto";

/**
 * Signed, server-issued kiosk/browser device identifier -- the "device"
 * scope of the layered PIN rate limiter (approved-plan §8). Distinct from
 * the kiosk token (kioskToken.ts, which represents an authenticated
 * post-PIN session): this identifier exists BEFORE any PIN is entered,
 * persists across many login attempts over a long time, and is never a
 * credential or session by itself -- it only tells the rate limiter "this
 * is the same physical device/browser that was just here," so a genuine
 * employee mistyping their PIN a few times isn't punished by a source-IP
 * or organization-wide counter shared with every other kiosk.
 *
 * Never trusted as the ONLY security boundary (a client can clear
 * cookies) -- the source-IP and organization-wide scopes in rateLimit.ts
 * exist specifically because this one can be discarded at will. Signed
 * with KIOSK_DEVICE_ID_SECRET, a secret distinct from PIN_PEPPER and
 * KIOSK_TOKEN_SECRET (the three guard different things and must not be
 * the same value, matching this codebase's existing secret-separation
 * convention). Required in every environment, with no fallback value --
 * app/actions/pin.ts throws (fails closed) if it is unset, exactly like
 * PIN_PEPPER/KIOSK_TOKEN_SECRET already do.
 *
 * SECRET ROTATION: rotating KIOSK_DEVICE_ID_SECRET invalidates every
 * previously-issued device cookie's signature. This is graceful, not
 * destructive: verifyDeviceId simply reports {ok:false} for the old
 * cookie (as if it had never existed), and app/actions/pin.ts's
 * resolveOrIssueDeviceId issues each kiosk a brand-new device id on its
 * next attempt. The only observable effect is that every kiosk's
 * accumulated device-scope failure history (rateLimit.ts's "device"
 * scope) resets to zero -- never an error, never a lockout, and the
 * source-IP/organization scopes (keyed independently of the device
 * cookie) are completely unaffected by a rotation.
 */

const DEVICE_ID_BYTES = 18;

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64url");
}

function sign(deviceId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(deviceId).digest("hex");
}

/** A fresh, random, signed device identifier -- the raw value to persist
 * in the device cookie (`${deviceId}.${signature}`). */
export function issueDeviceId(secret: string): string {
  const deviceId = base64UrlEncode(crypto.randomBytes(DEVICE_ID_BYTES));
  return `${deviceId}.${sign(deviceId, secret)}`;
}

export type VerifyDeviceIdResult = { ok: true; deviceId: string } | { ok: false };

/** Verifies a device-id cookie value's signature. A missing, malformed, or
 * tampered cookie is never treated as "the same device" -- the caller
 * (app/actions/pin.ts) issues a fresh one instead, which is exactly the
 * intended behavior for "device cookie cannot be forged." */
export function verifyDeviceId(cookieValue: string | undefined | null, secret: string): VerifyDeviceIdResult {
  if (!cookieValue) return { ok: false };
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return { ok: false };
  const [deviceId, signature] = parts;
  if (!deviceId || !signature) return { ok: false };

  let signatureBuffer: Buffer;
  let expectedBuffer: Buffer;
  try {
    signatureBuffer = Buffer.from(signature, "hex");
    expectedBuffer = Buffer.from(sign(deviceId, secret), "hex");
  } catch {
    return { ok: false };
  }

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return { ok: false };
  }

  return { ok: true, deviceId };
}
