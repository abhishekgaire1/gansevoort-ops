import type { SupabaseClient } from "@supabase/supabase-js";
import { hashPinLookup, isValidPinFormat, runDummyPinVerification, verifyPinHash } from "@/app/lib/auth/pin";
import {
  deriveRateLimitKey,
  registerPinFailureAcrossScopes,
  resetDeviceScopeOnSuccess,
  checkAndIncrementCpuThrottle,
  type PinRateLimitKeys,
} from "@/app/lib/auth/rateLimit";
import { issueKioskToken } from "@/app/lib/auth/kioskToken";
import { listAssignedActiveStationsForEmployee } from "@/app/lib/kiosk/stations";

/**
 * The actual PIN-verification business logic, separated from the
 * app/actions/pin.ts Server Action so it can be called directly from the
 * manual integration tests (tests/pin.integration.test.ts) without needing
 * an active Next.js request context -- the Server Action wrapper's only
 * job is resolving organizationId/env vars/request headers/the device-id
 * cookie and delegating here, mirroring the split already used for the
 * withdrawal RPC (app/lib/inventory/withdrawal.ts vs. app/actions/withdrawal.ts).
 *
 * V1 authentication design (product decision): the PIN is both the kiosk
 * identifier and the credential -- there is no employee-name/code selection
 * step before PIN entry. pin_lookup_hash is HMAC-SHA256(PIN, PIN_PEPPER), so
 * an app_users row is only ever found when the submitted PIN already equals
 * the one the account was set up with. An incorrect PIN can therefore never
 * be attributed to a specific employee, only to "no match" in general --
 * there is intentionally no per-employee failed-attempt counter or lockout.
 * Brute-forcing the four-digit PIN space is blunted by three independent,
 * DB-backed, failed-attempt scopes (device/source-IP/organization) plus a
 * separate all-attempts CPU throttle -- see rateLimit.ts's own module
 * comment for the full design.
 *
 * Every terminal path below performs exactly one Argon2id verification --
 * real for a found/active/current-format app_user, a precomputed dummy for
 * every other case (no row, inactive, or a legacy reset-required account)
 * -- so none of those cases is distinguishable from a real wrong-PIN
 * attempt by response latency (account-enumeration timing side channel).
 */

/**
 * Kiosk station assignment enforcement (20260811100130): derived fresh, on
 * every PIN verification, from the employee's CURRENT active station
 * assignments -- never cached, never a stale default. "blocked" means zero
 * active assignments (an unassigned, newly-created, or fully-unassigned
 * employee); "single" auto-selects the one assignment with no picker;
 * "multiple" means the kiosk must show the station picker, scoped to
 * exactly this employee's assigned stations (never every organization
 * station).
 */
export type StationAccess =
  | { kind: "blocked" }
  | { kind: "single"; stationId: string; stationName: string }
  | { kind: "multiple" };

export type VerifyPinResult =
  | {
      ok: true;
      appUserId: string;
      organizationId: string;
      employeeDisplayName: string;
      employeeFirstName: string;
      kioskToken: string;
      stationAccess: StationAccess;
    }
  | { ok: false; reason: "invalid_pin" | "rate_limited" };

export interface VerifyPinCoreInput {
  pin: string;
  organizationId: string;
  /** Trusted, server-resolved source IP (or the shared "unknown" bucket)
   * -- never client-supplied directly. See rateLimitSource.ts. */
  sourceIp: string;
  /** The raw, already-signature-verified device identifier (see
   * deviceId.ts) -- the caller is responsible for verifying/issuing this
   * BEFORE calling verifyPinCore; this function only ever hashes it for
   * rate-limit keying, never re-verifies its signature. */
  deviceId: string;
  pinPepper: string;
  kioskTokenSecret: string;
}

export async function verifyPinCore(supabase: SupabaseClient, input: VerifyPinCoreInput): Promise<VerifyPinResult> {
  const { pin, organizationId, sourceIp, deviceId, pinPepper, kioskTokenSecret } = input;

  // Each scope gets its OWN key, even the two both derived from sourceIp
  // ("ip" and "ip_all_attempts" are deliberately different mechanisms --
  // see rateLimit.ts's own doc comment) -- deriveRateLimitKey hashes the
  // scope name IN, so these can never collide on the same counter row
  // even though pin_verify_rate_limits' primary key does not itself
  // include scope (20260811100118's own comment explains why).
  const cpuThrottleKey = deriveRateLimitKey("ip_all_attempts", sourceIp);

  // 1. All-attempts CPU/volume throttle -- bounds total compute from one
  // source regardless of outcome or format validity. Checked first and
  // separately from the three failed-attempt security scopes below (see
  // rateLimit.ts's own comment on why these are never conflated).
  const cpuThrottle = await checkAndIncrementCpuThrottle(supabase, organizationId, cpuThrottleKey);
  if (!cpuThrottle.allowed) {
    return { ok: false, reason: "rate_limited" };
  }

  const keys: PinRateLimitKeys = {
    deviceKey: deriveRateLimitKey("device", deviceId),
    ipKey: deriveRateLimitKey("ip", sourceIp),
    orgKey: deriveRateLimitKey("org", organizationId),
  };

  // 2. Failed-attempt security scopes -- device/ip/org are never checked
  // via a separate read step (see rateLimit.ts's own doc comment on why
  // that was racy for a distributed, multi-IP attack). Every branch below
  // that determines a FAILURE atomically registers it across all three
  // scopes via registerPinFailureAcrossScopes and gates further Argon2
  // work on the result, BEFORE spending that cost -- never after.

  if (!isValidPinFormat(pin)) {
    // No Argon2 (dummy or real) is ever spent on a malformed PIN -- an
    // obviously-invalid submission (e.g. containing letters) can never be
    // a real guess, so there is no timing-side-channel value in gating it
    // the same way as a well-formed no-match PIN. Still routed through the
    // same authoritative failure-recording path for consistency.
    const gate = await registerPinFailureAcrossScopes(supabase, organizationId, keys);
    return { ok: false, reason: gate.allowed ? "invalid_pin" : "rate_limited" };
  }

  const pinLookupHash = hashPinLookup(pin, pinPepper);

  const { data: appUser, error: lookupError } = await supabase
    .from("app_users")
    .select("id, pin_hash, employee_id, employees!inner(first_name, last_name)")
    .eq("organization_id", organizationId)
    .eq("pin_lookup_hash", pinLookupHash)
    .eq("is_active", true)
    .eq("kiosk_pin_format_version", "FOUR_DIGIT")
    .eq("kiosk_pin_reset_required", false)
    .eq("employees.status", "active")
    .maybeSingle();

  if (lookupError) {
    throw new Error(`PIN lookup failed: ${lookupError.message}`);
  }

  if (!appUser) {
    // No matching employee, a matching PIN belonging to an inactive
    // app_user, a matching PIN whose linked employee has been
    // deactivated, or a matching PIN that still belongs to a legacy
    // six-digit/reset-required account (forced-reset transition) --
    // every one of these is intentionally indistinguishable from the
    // outside, and every one of them is a GUARANTEED failure (there is no
    // eligible current lookup match). Register that failure atomically,
    // across all three scopes, BEFORE running the dummy Argon2
    // verification below -- once any scope is already at its ceiling,
    // this returns rate_limited immediately without ever touching Argon2,
    // closing the race where an already-exhausted scope could otherwise
    // still admit unbounded concurrent requests to that (dummy, but still
    // deliberately expensive) verification step.
    const gate = await registerPinFailureAcrossScopes(supabase, organizationId, keys);
    if (!gate.allowed) {
      return { ok: false, reason: "rate_limited" };
    }
    // Still runs a real Argon2id verification (against a precomputed dummy
    // hash) so this path isn't distinguishable from a real wrong-PIN
    // attempt by timing.
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
    // and report the same generic reason rather than authenticating. The
    // real Argon2 verification already ran (unavoidably, to determine
    // this), so there is no further expensive work left to gate for THIS
    // request -- still routed through the same authoritative
    // failure-recording path as the no-match branch above, both so future
    // requests see accurate counters and so the client-visible outcome
    // stays consistent with every other failure branch.
    console.error(
      `PIN credential-integrity mismatch for app_user ${appUser.id}: pin_lookup_hash matched but Argon2 verification failed`
    );
    const gate = await registerPinFailureAcrossScopes(supabase, organizationId, keys);
    return { ok: false, reason: gate.allowed ? "invalid_pin" : "rate_limited" };
  }

  // A successful verification never calls registerPinFailureAcrossScopes,
  // so it never consumes any of the three failure quotas (device/ip/org)
  // -- only the CPU throttle above, which counts every attempt regardless
  // of outcome. Only the device scope's current window is reset; ip/org
  // evidence is left untouched, exactly as before.
  await resetDeviceScopeOnSuccess(supabase, organizationId, keys.deviceKey);

  const kioskToken = issueKioskToken({ appUserId: appUser.id, organizationId }, kioskTokenSecret);
  const employee = Array.isArray(appUser.employees) ? appUser.employees[0] : appUser.employees;
  const employeeDisplayName = employee ? `${employee.first_name} ${employee.last_name}` : "";
  const employeeFirstName = employee?.first_name ?? "";

  // Kiosk station assignment enforcement (20260811100130): resolved fresh
  // on every successful PIN verification, from the employee's CURRENT
  // active station assignments -- so an assignment added or removed since
  // the employee's last login always takes effect on this new login,
  // never a stale value. Zero active assignments blocks kiosk access
  // entirely (never falls back to "pick from every organization
  // station"); exactly one auto-selects; two or more requires the picker,
  // which itself only ever lists these same assigned stations (see
  // app/actions/stations.ts).
  const assignedStations = await listAssignedActiveStationsForEmployee(supabase, organizationId, appUser.employee_id);
  const stationAccess: StationAccess =
    assignedStations.length === 0
      ? { kind: "blocked" }
      : assignedStations.length === 1
        ? { kind: "single", stationId: assignedStations[0]!.id, stationName: assignedStations[0]!.name }
        : { kind: "multiple" };

  return {
    ok: true,
    appUserId: appUser.id,
    organizationId,
    employeeDisplayName,
    employeeFirstName,
    kioskToken,
    stationAccess,
  };
}
