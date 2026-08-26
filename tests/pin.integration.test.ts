import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { hashPinForStorage, hashPinLookup, isValidPinFormat } from "@/app/lib/auth/pin";
import {
  deriveRateLimitKey,
  incrementPinRateLimit,
  registerPinFailureAcrossScopes,
  getOrgPinRateLimitStatus,
  unlockOrgPinRateLimits,
  MAX_FAILURES_IP,
  MAX_FAILURES_ORG,
  WINDOW_SECONDS_IP,
  type PinRateLimitKeys,
} from "@/app/lib/auth/rateLimit";
import { setEmployeeKioskPin } from "@/app/lib/admin/users";
import { verifyPinCore } from "@/app/lib/auth/verifyPin";
import { resolveTestOrgId, setupOtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (`npm test` does not include
 * this file; run explicitly via `npm run test:integration`).
 *
 * Touches the linked gansevoort-ops-dev database directly: app_users and
 * pin_verify_rate_limits are NOT append-only, so these fixtures/rows are
 * safely mutable and reusable between runs, unlike the withdrawal RPC's
 * append-only tables (see withdrawal.rpc.test.ts).
 *
 * Lives inside the shared TEST RPC Fixture Org (via testFixtures.ts's
 * resolveTestOrgId, which only resolves it -- creation happens once,
 * serially, in scripts/test-integration-setup.ts before this file ever
 * runs) -- never the real "Gansevoort" organization a manager uses for
 * manual browser testing. Uses its own dedicated fixture employee within
 * that org (isolated from testFixtures.ts's own setupRpcTestFixtures()/
 * withdrawal.rpc.test.ts) so state produced here can never make the
 * withdrawal RPC tests flaky.
 *
 * V1 authentication design (product decision): the PIN is both the kiosk
 * identifier and the credential -- no employee-name/code selection step
 * before PIN entry. pin_lookup_hash is HMAC-SHA256(PIN, PIN_PEPPER), so an
 * app_users row is only ever found when the submitted PIN already equals
 * the one the account was set up with; an incorrect PIN can never be
 * attributed to a specific employee. There is intentionally no
 * per-employee failed-attempt counter or lockout -- brute-forcing the
 * four-digit PIN space is blunted by the layered device/IP/organization
 * failed-attempt scopes plus the separate all-attempts CPU throttle (see
 * rateLimit.ts), covered below.
 */

const PIN = "4839";
const EMPLOYEE_CODE = "TEST-PIN-FIXTURE";

let supabase: SupabaseClient;
let organizationId: string;
let employeeId: string;
let appUserId: string;
let pinPepper: string;
const kioskTokenSecret = "test-pin-integration-kiosk-secret";

// Computed once in beforeAll and reused by resetFixtureState() so every
// test can cheaply restore the fixture to its known-good state without
// re-running Argon2id per reset.
let canonicalPinLookupHash: string;
let canonicalPinHash: string;

async function resetFixtureState(): Promise<void> {
  await supabase
    .from("app_users")
    .update({
      is_active: true,
      pin_lookup_hash: canonicalPinLookupHash,
      pin_hash: canonicalPinHash,
      kiosk_pin_format_version: "FOUR_DIGIT",
      kiosk_pin_reset_required: false,
    })
    .eq("id", appUserId);
}

beforeAll(async () => {
  supabase = getServiceRoleClient();
  pinPepper = process.env.PIN_PEPPER!;
  if (!pinPepper) throw new Error("PIN_PEPPER is not set");

  canonicalPinLookupHash = hashPinLookup(PIN, pinPepper);
  canonicalPinHash = await hashPinForStorage(PIN);

  ({ organizationId } = await resolveTestOrgId(supabase));

  const { data: existingEmployee } = await supabase
    .from("employees")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("employee_code", EMPLOYEE_CODE)
    .maybeSingle();

  employeeId = existingEmployee
    ? (existingEmployee.id as string)
    : (
        await supabase
          .from("employees")
          .insert({ organization_id: organizationId, first_name: "Test", last_name: "PinFixture", employee_code: EMPLOYEE_CODE })
          .select("id")
          .single()
      ).data!.id;

  const { data: existingAppUser } = await supabase.from("app_users").select("id").eq("employee_id", employeeId).maybeSingle();

  if (existingAppUser) {
    appUserId = existingAppUser.id as string;
  } else {
    const { data: inserted, error } = await supabase
      .from("app_users")
      .insert({
        organization_id: organizationId,
        employee_id: employeeId,
        pin_lookup_hash: canonicalPinLookupHash,
        pin_hash: canonicalPinHash,
      })
      .select("id")
      .single();
    if (error) throw error;
    appUserId = inserted.id as string;
  }

  await resetFixtureState();
});

describe("verifyPinCore", () => {
  it("succeeds with the correct PIN and issues a kiosk token", async () => {
    const result = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIp: "203.0.113.10",
      deviceId: "test-device-correct-pin",
      pinPepper,
      kioskTokenSecret,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appUserId).toBe(appUserId);
    }
  });

  it("rejects an unknown PIN and does not modify the app_users row", async () => {
    const { data: before } = await supabase.from("app_users").select("*").eq("id", appUserId).single();

    const result = await verifyPinCore(supabase, {
      pin: "0001",
      organizationId,
      sourceIp: "203.0.113.11",
      deviceId: "test-device-no-match",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });

    const { data: after } = await supabase.from("app_users").select("*").eq("id", appUserId).single();
    expect(after).toEqual(before);
  });

  it("rejects a correct PIN belonging to an inactive app_user, with the same generic reason as an unknown PIN", async () => {
    await resetFixtureState();
    await supabase.from("app_users").update({ is_active: false }).eq("id", appUserId);

    const result = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIp: "203.0.113.12",
      deviceId: "test-device-inactive",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });

    await resetFixtureState();
  });

  it("rejects a correct PIN still marked legacy/reset-required (forced-reset transition), with the same generic reason", async () => {
    await resetFixtureState();
    await supabase.from("app_users").update({ kiosk_pin_format_version: "LEGACY_SIX_DIGIT", kiosk_pin_reset_required: true }).eq("id", appUserId);

    const result = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIp: "203.0.113.13",
      deviceId: "test-device-reset-required",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });

    await resetFixtureState();
  });

  it("fails closed on a credential-integrity mismatch (pin_lookup_hash matches, Argon2 does not)", async () => {
    await resetFixtureState();
    // Corrupt only pin_hash, leaving pin_lookup_hash (and thus
    // identification of this exact account by the correct PIN) intact --
    // simulates the accounts' two credential fields having gone out of
    // sync, not a mistyped PIN.
    const mismatchedHash = await hashPinForStorage("1112");
    await supabase.from("app_users").update({ pin_hash: mismatchedHash }).eq("id", appUserId);

    const result = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIp: "203.0.113.14",
      deviceId: "test-device-credential-integrity",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });

    await resetFixtureState();
  });
});

describe("PIN verify rate limiting", () => {
  it("blocks a single source after enough FAILED attempts within a window, while a different source is unaffected", async () => {
    const key = deriveRateLimitKey("ip", `test-rate-limit-source-${Date.now()}`);
    const otherKey = deriveRateLimitKey("ip", `test-rate-limit-other-${Date.now()}`);

    let lastCount = 0;
    for (let i = 0; i < MAX_FAILURES_IP + 5; i++) {
      lastCount = await incrementPinRateLimit(supabase, organizationId, "ip", key, WINDOW_SECONDS_IP);
    }
    expect(lastCount).toBeGreaterThan(MAX_FAILURES_IP);

    const otherCount = await incrementPinRateLimit(supabase, organizationId, "ip", otherKey, WINDOW_SECONDS_IP);
    expect(otherCount).toBe(1);
  });
});

describe("set_employee_kiosk_pin RPC -- reset flow, leading-zero PIN", () => {
  it("resets the fixture employee to a leading-zero four-digit PIN, clears reset-required, and the new PIN (not the old one) authenticates", async () => {
    await resetFixtureState();
    // Deliberately corrupt to a legacy/reset-required state first, mirroring
    // a real forced-reset-transition employee, so this test proves the RPC
    // itself clears both kiosk_pin_format_version and kiosk_pin_reset_required
    // -- not just that verifyPinCore already ignores a manually-seeded row.
    await supabase.from("app_users").update({ kiosk_pin_format_version: "LEGACY_SIX_DIGIT", kiosk_pin_reset_required: true }).eq("id", appUserId);

    const leadingZeroPin = "0042";
    expect(isValidPinFormat(leadingZeroPin)).toBe(true);
    await setEmployeeKioskPin(supabase, organizationId, appUserId, employeeId, leadingZeroPin, pinPepper);

    const { data: afterReset } = await supabase
      .from("app_users")
      .select("kiosk_pin_format_version, kiosk_pin_reset_required")
      .eq("id", appUserId)
      .single();
    expect(afterReset).toEqual({ kiosk_pin_format_version: "FOUR_DIGIT", kiosk_pin_reset_required: false });

    // The new leading-zero PIN authenticates, with the zero intact (never
    // coerced to a number anywhere in the RPC or the lookup-hash path).
    const newPinResult = await verifyPinCore(supabase, {
      pin: leadingZeroPin,
      organizationId,
      sourceIp: "203.0.113.20",
      deviceId: "test-device-leading-zero-reset",
      pinPepper,
      kioskTokenSecret,
    });
    expect(newPinResult.ok).toBe(true);
    if (newPinResult.ok) {
      expect(newPinResult.appUserId).toBe(appUserId);
    }

    // The OLD PIN (used before this reset) no longer authenticates.
    const oldPinResult = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIp: "203.0.113.21",
      deviceId: "test-device-leading-zero-old-pin",
      pinPepper,
      kioskTokenSecret,
    });
    expect(oldPinResult).toEqual({ ok: false, reason: "invalid_pin" });

    // Restore the fixture to its canonical PIN for any other test file/run
    // that might reuse this same fixture employee.
    await setEmployeeKioskPin(supabase, organizationId, appUserId, employeeId, PIN, pinPepper);
    await resetFixtureState();
  });
});

describe("register_pin_verification_failure RPC -- atomic distributed rate limiting against the REAL database", () => {
  it("caps the ORG scope at exactly MAX_FAILURES_ORG permitted requests, even under many concurrent callers using DIFFERENT device/ip keys (proves the fix against real Postgres, not just the in-memory unit-test fake)", async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sharedOrgKey = deriveRateLimitKey("org", `test-atomic-org-${runId}`);

    // Bring the org scope to MAX_FAILURES_ORG - 1 first (sequential,
    // simulating prior history), each with its own distinct device/ip key
    // so neither of those scopes is ever exhausted.
    for (let i = 0; i < MAX_FAILURES_ORG - 1; i++) {
      const keys: PinRateLimitKeys = {
        deviceKey: deriveRateLimitKey("device", `prior-device-${runId}-${i}`),
        ipKey: deriveRateLimitKey("ip", `prior-ip-${runId}-${i}`),
        orgKey: sharedOrgKey,
      };
      await registerPinFailureAcrossScopes(supabase, organizationId, keys);
    }

    // Now fire 100 concurrent requests, each with its OWN distinct
    // device/ip key (simulating a distributed, multi-IP attack) but the
    // SAME shared org key -- exactly the scenario the concurrency race
    // analysis described. At most exactly ONE more may be permitted.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => {
        const keys: PinRateLimitKeys = {
          deviceKey: deriveRateLimitKey("device", `attack-device-${runId}-${i}`),
          ipKey: deriveRateLimitKey("ip", `attack-ip-${runId}-${i}`),
          orgKey: sharedOrgKey,
        };
        return registerPinFailureAcrossScopes(supabase, organizationId, keys);
      })
    );

    const permittedCount = results.filter((r) => r.allowed).length;
    expect(permittedCount).toBe(1);
  });
});

describe("organization PIN rate-limit status + manager unlock RPCs (real database)", () => {
  it("reports locked out once the org scope is driven to its ceiling, and unlock restores it -- scoped ONLY to this organization", async () => {
    // Drive the FIXTURE ORG's real org-scope key (the same one verifyPinCore
    // itself uses) to its ceiling, so get_org_pin_rate_limit_status's
    // read against that exact key reports locked out.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < MAX_FAILURES_ORG; i++) {
      const keys: PinRateLimitKeys = {
        deviceKey: deriveRateLimitKey("device", `lockout-device-${runId}-${i}`),
        ipKey: deriveRateLimitKey("ip", `lockout-ip-${runId}-${i}`),
        orgKey: deriveRateLimitKey("org", organizationId),
      };
      await registerPinFailureAcrossScopes(supabase, organizationId, keys);
    }

    const lockedStatus = await getOrgPinRateLimitStatus(supabase, organizationId);
    expect(lockedStatus.isLockedOut).toBe(true);

    // A DIFFERENT organization's status must be completely unaffected.
    const { organizationId: otherOrgId } = await setupOtherOrgFixtures(supabase);
    const otherStatus = await getOrgPinRateLimitStatus(supabase, otherOrgId);
    expect(otherStatus.isLockedOut).toBe(false);

    // Manager unlock restores this organization's own kiosk PIN attempts.
    await unlockOrgPinRateLimits(supabase, organizationId, appUserId);
    const afterUnlock = await getOrgPinRateLimitStatus(supabase, organizationId);
    expect(afterUnlock.isLockedOut).toBe(false);
    expect(afterUnlock.attemptCount).toBe(0);

    // Exactly one audit event was written for this unlock action.
    const { data: auditRows, error: auditError } = await supabase
      .from("audit_events")
      .select("id, action, entity_type, entity_id, actor_app_user_id")
      .eq("organization_id", organizationId)
      .eq("action", "KIOSK_PIN_RATE_LIMIT_UNLOCK")
      .eq("actor_app_user_id", appUserId)
      .order("occurred_at", { ascending: false })
      .limit(1);
    expect(auditError).toBeNull();
    expect(auditRows).toHaveLength(1);
    expect(auditRows![0].entity_type).toBe("organization");
    expect(auditRows![0].entity_id).toBe(organizationId);

    // A legitimate login still works normally after the unlock (kiosk
    // token/station authorization unaffected by the rate-limit machinery).
    await resetFixtureState();
    const loginResult = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIp: "203.0.113.30",
      deviceId: "test-device-post-unlock-login",
      pinPepper,
      kioskTokenSecret,
    });
    expect(loginResult.ok).toBe(true);
  });
});
