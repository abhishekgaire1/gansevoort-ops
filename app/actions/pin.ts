"use server";

import { headers } from "next/headers";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getKioskOrganizationId } from "@/app/lib/auth/kioskOrg";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { hashPinForStorage, hashPinLookup, isValidPinFormat } from "@/app/lib/auth/pin";
import { verifyPinCore, type VerifyPinResult } from "@/app/lib/auth/verifyPin";
import { resolveRateLimitSource } from "@/app/lib/auth/rateLimitSource";

export type { VerifyPinResult };

/** Server-derived request-source identifier for rate limiting. Never
 * client-supplied -- deployed on Vercel, so only the platform-set
 * x-vercel-forwarded-for header is trusted (Vercel's edge overwrites it
 * with the real client IP; a client can supply an arbitrary generic
 * x-forwarded-for/x-real-ip, so those are deliberately not consulted). */
async function getRequestSourceIdentifier(): Promise<string> {
  const headerList = await headers();
  return resolveRateLimitSource(headerList.get("x-vercel-forwarded-for"));
}

export async function verifyPin(pin: string): Promise<VerifyPinResult> {
  const organizationId = getKioskOrganizationId();
  const supabase = getServiceRoleClient();
  const sourceIdentifier = await getRequestSourceIdentifier();

  const pinPepper = process.env.PIN_PEPPER;
  if (!pinPepper) throw new Error("PIN_PEPPER is not set");
  const kioskTokenSecret = process.env.KIOSK_TOKEN_SECRET;
  if (!kioskTokenSecret) throw new Error("KIOSK_TOKEN_SECRET is not set");

  return verifyPinCore(supabase, { pin, organizationId, sourceIdentifier, pinPepper, kioskTokenSecret });
}

export type CreateOrResetPinResult =
  | { ok: true }
  | { ok: false; reason: "not_authenticated" | "not_authorized" | "invalid_pin_format" | "pin_already_in_use" };

export async function createOrResetEmployeePin(
  employeeId: string,
  newPin: string
): Promise<CreateOrResetPinResult> {
  const authResult = await requireManagerOrAdmin();
  if (!authResult.ok) {
    return { ok: false, reason: authResult.reason };
  }

  if (!isValidPinFormat(newPin)) {
    return { ok: false, reason: "invalid_pin_format" };
  }

  const supabase = getServiceRoleClient();
  const pinPepper = process.env.PIN_PEPPER;
  if (!pinPepper) {
    throw new Error("PIN_PEPPER is not set");
  }

  const pinLookupHash = hashPinLookup(newPin, pinPepper);
  const pinHash = await hashPinForStorage(newPin);

  const { error } = await supabase
    .from("app_users")
    .update({
      pin_lookup_hash: pinLookupHash,
      pin_hash: pinHash,
      pin_set_at: new Date().toISOString(),
      failed_pin_attempts: 0,
      locked_until: null,
    })
    .eq("employee_id", employeeId)
    .eq("organization_id", authResult.manager.organizationId);

  if (error) {
    // unique_violation on app_users_org_pin_lookup_key: another employee in
    // this org already has this exact PIN. Never reveal which one.
    if (error.code === "23505") {
      return { ok: false, reason: "pin_already_in_use" };
    }
    throw new Error(`failed to set PIN for employee ${employeeId}: ${error.message}`);
  }

  return { ok: true };
}
