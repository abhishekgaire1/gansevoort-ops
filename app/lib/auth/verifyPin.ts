import type { SupabaseClient } from "@supabase/supabase-js";
import { hashPinLookup, isValidPinFormat, runDummyPinVerification, verifyPinHash } from "@/app/lib/auth/pin";
import { checkAndIncrementPinRateLimit, deriveRateLimitKey } from "@/app/lib/auth/rateLimit";
import { issueKioskToken } from "@/app/lib/auth/kioskToken";

/**
 * The actual PIN-verification business logic, separated from the
 * app/actions/pin.ts Server Action so it can be called directly from the
 * manual integration tests (tests/pin.integration.test.ts) without needing
 * an active Next.js request context -- the Server Action wrapper's only
 * job is resolving organizationId/env vars/request headers and delegating
 * here, mirroring the split already used for the withdrawal RPC
 * (app/lib/inventory/withdrawal.ts vs. app/actions/withdrawal.ts).
 *
 * Every terminal path below performs exactly one Argon2id verification --
 * real for a found/unlocked app_user, a precomputed dummy for "no match"
 * and "locked" -- so those two fast paths cannot be distinguished from a
 * real wrong-PIN attempt by response latency (account-enumeration timing
 * side channel).
 */

export type VerifyPinResult =
  | { ok: true; appUserId: string; organizationId: string; employeeDisplayName: string; kioskToken: string }
  | { ok: false; reason: "invalid_pin" | "locked" | "rate_limited" };

export interface VerifyPinCoreInput {
  pin: string;
  organizationId: string;
  sourceIdentifier: string;
  pinPepper: string;
  kioskTokenSecret: string;
}

export async function verifyPinCore(
  supabase: SupabaseClient,
  input: VerifyPinCoreInput
): Promise<VerifyPinResult> {
  const { pin, organizationId, sourceIdentifier, pinPepper, kioskTokenSecret } = input;

  const rateLimitKey = deriveRateLimitKey(sourceIdentifier);
  const rateLimitResult = await checkAndIncrementPinRateLimit(supabase, organizationId, rateLimitKey);
  if (!rateLimitResult.allowed) {
    return { ok: false, reason: "rate_limited" };
  }

  if (!isValidPinFormat(pin)) {
    return { ok: false, reason: "invalid_pin" };
  }

  const pinLookupHash = hashPinLookup(pin, pinPepper);

  const { data: appUser, error: lookupError } = await supabase
    .from("app_users")
    .select("id, pin_hash, failed_pin_attempts, locked_until, employee_id, employees(first_name, last_name)")
    .eq("organization_id", organizationId)
    .eq("pin_lookup_hash", pinLookupHash)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`PIN lookup failed: ${lookupError.message}`);
  }

  if (!appUser) {
    // No matching employee. Nothing to increment -- the rate limit check
    // above is the only thing throttling this case. Still runs a real
    // Argon2id verification (against a precomputed dummy hash) so this
    // path isn't distinguishable from a real wrong-PIN attempt by timing.
    await runDummyPinVerification();
    return { ok: false, reason: "invalid_pin" };
  }

  const now = new Date();
  const lockedUntil = appUser.locked_until ? new Date(appUser.locked_until) : null;
  const isCurrentlyLocked = lockedUntil !== null && lockedUntil > now;

  if (isCurrentlyLocked) {
    // Same timing-normalization reasoning as the "no match" branch above --
    // this intentionally still costs one Argon2id verification, just
    // against the dummy hash instead of skipping straight to a fast return.
    await runDummyPinVerification();
    return { ok: false, reason: "locked" };
  }

  const isValid = await verifyPinHash(pin, appUser.pin_hash);

  if (isValid) {
    await supabase.from("app_users").update({ failed_pin_attempts: 0, locked_until: null }).eq("id", appUser.id);

    const kioskToken = issueKioskToken({ appUserId: appUser.id, organizationId }, kioskTokenSecret);
    const employee = Array.isArray(appUser.employees) ? appUser.employees[0] : appUser.employees;
    const employeeDisplayName = employee ? `${employee.first_name} ${employee.last_name}` : "";

    return { ok: true, appUserId: appUser.id, organizationId, employeeDisplayName, kioskToken };
  }

  // Wrong PIN. Bookkeeping (fresh-cycle-after-expiry / increment / lockout
  // threshold) is a single atomic Postgres statement
  // (register_pin_verification_failure), not a JS read-then-write -- this
  // is what makes it race-free under concurrent wrong-PIN requests against
  // the same app_user. The DB re-evaluates locked_until against now() at
  // update time, not against the possibly-stale value read moments ago.
  const { error: failureError } = await supabase.rpc("register_pin_verification_failure", {
    p_app_user_id: appUser.id,
  });
  if (failureError) {
    throw new Error(`failed to register PIN verification failure: ${failureError.message}`);
  }

  return { ok: false, reason: "invalid_pin" };
}
