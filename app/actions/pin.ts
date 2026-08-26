"use server";

import { headers, cookies } from "next/headers";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getKioskOrganizationId } from "@/app/lib/auth/kioskOrg";
import { issueDeviceId, verifyDeviceId } from "@/app/lib/auth/deviceId";
import { verifyPinCore, type VerifyPinResult } from "@/app/lib/auth/verifyPin";
import { resolveRateLimitSource } from "@/app/lib/auth/rateLimitSource";

export type { VerifyPinResult };

const DEVICE_ID_COOKIE_NAME = "kiosk_device_id";
// Long-lived: a kiosk device's identity should persist across many login
// attempts over a long time, unlike the short-lived kiosk session token
// (kioskToken.ts) issued only after a successful PIN. One year is
// deliberately generous -- the whole point is device CONTINUITY, and a
// cookie that expired routinely would just mean every kiosk quietly loses
// its own device-scoped failure history on a schedule, weakening the
// device-level protection without strengthening anything.
const DEVICE_ID_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Server-derived request-source identifier for rate limiting. Never
 * client-supplied -- deployed on Vercel, so only the platform-set
 * x-vercel-forwarded-for header is trusted (Vercel's edge overwrites it
 * with the real client IP; a client can supply an arbitrary generic
 * x-forwarded-for/x-real-ip, so those are deliberately not consulted). */
async function getRequestSourceIp(): Promise<string> {
  const headerList = await headers();
  return resolveRateLimitSource(headerList.get("x-vercel-forwarded-for"));
}

/**
 * Resolves this browser's signed device identifier for rate-limit
 * purposes, issuing (and persisting) a fresh one when absent or tampered
 * -- never accepted as an arbitrary raw client value (verifyDeviceId
 * checks the HMAC signature; a forged/edited cookie is treated exactly
 * like "no cookie at all"). HttpOnly + SameSite=lax + Secure in
 * production, consistent with this being a security-relevant identifier
 * that client-side script should never be able to read or forge, while
 * still being sent on the same-site form submissions the kiosk uses.
 */
async function resolveOrIssueDeviceId(secret: string): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(DEVICE_ID_COOKIE_NAME)?.value;
  const verification = verifyDeviceId(existing, secret);
  if (verification.ok) {
    return verification.deviceId;
  }

  const issued = issueDeviceId(secret);
  cookieStore.set(DEVICE_ID_COOKIE_NAME, issued, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_ID_COOKIE_MAX_AGE_SECONDS,
  });
  // The signed cookie value's own payload (before the "." signature) is
  // exactly what deviceId.ts's issueDeviceId/verifyDeviceId agree is the
  // deviceId -- re-derive it the same way rather than re-parsing here.
  const [deviceId] = issued.split(".");
  return deviceId;
}

export async function verifyPin(pin: string): Promise<VerifyPinResult> {
  const organizationId = getKioskOrganizationId();
  const supabase = getServiceRoleClient();
  const sourceIp = await getRequestSourceIp();

  const pinPepper = process.env.PIN_PEPPER;
  if (!pinPepper) throw new Error("PIN_PEPPER is not set");
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) throw new Error("KIOSK_TOKEN_SECRET is not set");
  const deviceIdSecret = process.env.KIOSK_DEVICE_ID_SECRET;
  if (!deviceIdSecret) throw new Error("KIOSK_DEVICE_ID_SECRET is not set");

  const deviceId = await resolveOrIssueDeviceId(deviceIdSecret);

  return verifyPinCore(supabase, { pin, organizationId, sourceIp, deviceId, pinPepper, kioskTokenSecret });
}
