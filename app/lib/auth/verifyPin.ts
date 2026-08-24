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
 * V1 authentication design (product decision): the PIN is both the kiosk
 * identifier and the credential -- there is no employee-name/code selection
 * step before PIN entry. pin_lookup_hash is HMAC-SHA256(PIN, PIN_PEPPER), so
 * an app_users row is only ever found when the submitted PIN already equals
 * the one the account was set up with. An incorrect PIN can therefore never
 * be attributed to a specific employee, only to "no match" in general --
 * there is intentionally no per-employee failed-attempt counter or lockout
 * in V1. Brute-forcing the PIN space is blunted only by the source-based
 * rate limiter (rateLimit.ts / pin_verify_rate_limits).
 *
 * Every terminal path below performs exactly one Argon2id verification --
 * real for a found/active app_user, a precomputed dummy for "no match" (no
 * row, or a row belonging to an inactive app_user) -- so that path cannot be
 * distinguished from a real wrong-PIN attempt by response latency
 * (account-enumeration timing side channel).
 */

export type VerifyPinResult =
  | {
      ok: true;
      appUserId: string;
      organizationId: string;
      employeeDisplayName: string;
      employeeFirstName: string;
      kioskToken: string;
      defaultStationId: string | null;
      defaultStationName: string | null;
      autoResolveStation: boolean;
      canChangeStation: boolean;
    }
  | { ok: false; reason: "invalid_pin" | "rate_limited" };

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
    .select(
      "id, pin_hash, employee_id, employees!inner(first_name, last_name, default_station_id, auto_resolve_station, can_change_station)"
    )
    .eq("organization_id", organizationId)
    .eq("pin_lookup_hash", pinLookupHash)
    .eq("is_active", true)
    .eq("employees.status", "active")
    .maybeSingle();

  if (lookupError) {
    throw new Error(`PIN lookup failed: ${lookupError.message}`);
  }

  if (!appUser) {
    // No matching employee, a matching PIN belonging to an inactive
    // app_user, or (Admin Foundation milestone fix -- see that
    // milestone's final report) a matching PIN whose linked employee has
    // been deactivated via Admin even though app_users.is_active was
    // somehow left true -- all three are intentionally indistinguishable
    // from the outside. The rate limit check above is the only thing
    // throttling this case. Still runs a real Argon2id verification
    // (against a precomputed dummy hash) so this path isn't
    // distinguishable from a real wrong-PIN attempt by timing.
    await runDummyPinVerification();
    return { ok: false, reason: "invalid_pin" };
  }

  const isValid = await verifyPinHash(pin, appUser.pin_hash);

  if (!isValid) {
    // Reaching this point means pin_lookup_hash already matched this exact
    // submitted PIN to this app_user's row, so under the V1 identification
    // design an Argon2 mismatch here is not an ordinary mistyped PIN (that
    // case never finds a row at all -- see the !appUser branch above). It
    // means pin_hash and pin_lookup_hash have gone out of sync for this
    // account, which should never happen in normal operation. Fail closed
    // and report the same generic reason rather than authenticating.
    console.error(
      `PIN credential-integrity mismatch for app_user ${appUser.id}: pin_lookup_hash matched but Argon2 verification failed`
    );
    return { ok: false, reason: "invalid_pin" };
  }

  const kioskToken = issueKioskToken({ appUserId: appUser.id, organizationId }, kioskTokenSecret);
  const employee = Array.isArray(appUser.employees) ? appUser.employees[0] : appUser.employees;
  const employeeDisplayName = employee ? `${employee.first_name} ${employee.last_name}` : "";
  const employeeFirstName = employee?.first_name ?? "";
  const defaultStationId: string | null = employee?.default_station_id ?? null;
  const autoResolveStation = employee?.auto_resolve_station ?? false;
  const canChangeStation = employee?.can_change_station ?? false;

  // Fetched only when there's a default station to name -- the locked and
  // auto_changeable branches need a human-readable name to display without
  // an extra client round trip to the station-list action; must_pick
  // employees have no default station at all, so nothing to look up.
  let defaultStationName: string | null = null;
  if (defaultStationId) {
    const { data: station, error: stationError } = await supabase
      .from("stations")
      .select("name")
      .eq("id", defaultStationId)
      .maybeSingle();

    if (stationError) {
      throw new Error(`default station lookup failed: ${stationError.message}`);
    }
    defaultStationName = (station?.name as string | undefined) ?? null;
  }

  return {
    ok: true,
    appUserId: appUser.id,
    organizationId,
    employeeDisplayName,
    employeeFirstName,
    kioskToken,
    defaultStationId,
    defaultStationName,
    autoResolveStation,
    canChangeStation,
  };
}
