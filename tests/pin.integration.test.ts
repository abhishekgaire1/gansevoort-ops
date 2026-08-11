import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";
import { checkAndIncrementPinRateLimit, deriveRateLimitKey } from "@/app/lib/auth/rateLimit";
import { verifyPinCore } from "@/app/lib/auth/verifyPin";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (`npm test` does not include
 * this file; run explicitly via `npm run test:integration`).
 *
 * Touches the linked gansevoort-ops-dev database directly: app_users and
 * pin_verify_rate_limits are NOT append-only, so these fixtures/rows are
 * safely mutable and reusable between runs, unlike the withdrawal RPC's
 * append-only tables (see withdrawal.rpc.test.ts).
 *
 * Uses its own dedicated fixture employee (isolated from
 * testFixtures.ts/withdrawal.rpc.test.ts) so lockout state produced here
 * can never make the withdrawal RPC tests flaky.
 */

const PIN = "483920";
const EMPLOYEE_CODE = "TEST-PIN-FIXTURE";

let supabase: SupabaseClient;
let organizationId: string;
let appUserId: string;
let pinPepper: string;
const kioskTokenSecret = "test-pin-integration-kiosk-secret";

async function resetFixtureState(): Promise<void> {
  await supabase.from("app_users").update({ failed_pin_attempts: 0, locked_until: null }).eq("id", appUserId);
}

beforeAll(async () => {
  supabase = getServiceRoleClient();
  pinPepper = process.env.PIN_PEPPER!;
  if (!pinPepper) throw new Error("PIN_PEPPER is not set");

  const { data: org, error: orgError } = await supabase.from("organizations").select("id").eq("name", "Gansevoort").single();
  if (orgError) throw orgError;
  organizationId = org.id as string;

  const { data: existingEmployee } = await supabase
    .from("employees")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("employee_code", EMPLOYEE_CODE)
    .maybeSingle();

  const employeeId = existingEmployee
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
        pin_lookup_hash: hashPinLookup(PIN, pinPepper),
        pin_hash: await hashPinForStorage(PIN),
      })
      .select("id")
      .single();
    if (error) throw error;
    appUserId = inserted.id as string;
  }

  await resetFixtureState();
});

describe("verifyPinCore", () => {
  it("succeeds with the correct PIN and resets attempt state", async () => {
    // Seed a nonzero attempt count first to prove success actually resets it.
    await supabase.from("app_users").update({ failed_pin_attempts: 2 }).eq("id", appUserId);

    const result = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIdentifier: "test-source-correct-pin",
      pinPepper,
      kioskTokenSecret,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appUserId).toBe(appUserId);
    }

    const { data: row } = await supabase.from("app_users").select("failed_pin_attempts, locked_until").eq("id", appUserId).single();
    expect(row!.failed_pin_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();

    await resetFixtureState();
  });

  it("rejects a PIN matching no employee, without touching any app_users row", async () => {
    const result = await verifyPinCore(supabase, {
      pin: "000111",
      organizationId,
      sourceIdentifier: "test-source-no-match",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
  });

  it("rejects a wrong PIN against the real fixture employee and increments failed_pin_attempts", async () => {
    await resetFixtureState();

    const result = await verifyPinCore(supabase, {
      pin: "999999",
      organizationId,
      sourceIdentifier: "test-source-wrong-pin",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });

    const { data: row } = await supabase.from("app_users").select("failed_pin_attempts").eq("id", appUserId).single();
    expect(row!.failed_pin_attempts).toBe(1);

    await resetFixtureState();
  });

  it("locks out after 5 consecutive failures, and the 6th attempt is rejected without running argon2 even with the correct PIN", async () => {
    await resetFixtureState();

    for (let i = 0; i < 5; i++) {
      await verifyPinCore(supabase, {
        pin: "999999",
        organizationId,
        sourceIdentifier: `test-source-lockout-${i}`,
        pinPepper,
        kioskTokenSecret,
      });
    }

    const { data: rowAfterFive } = await supabase.from("app_users").select("failed_pin_attempts, locked_until").eq("id", appUserId).single();
    expect(rowAfterFive!.failed_pin_attempts).toBe(5);
    expect(rowAfterFive!.locked_until).not.toBeNull();

    const result = await verifyPinCore(supabase, {
      pin: PIN, // correct PIN
      organizationId,
      sourceIdentifier: "test-source-lockout-check",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "locked" });

    await resetFixtureState();
  });

  it("starts a fresh failure cycle after a lockout expires (one failure => 1, not an immediate re-lock)", async () => {
    await resetFixtureState();
    // Simulate an already-expired lockout directly, never a literal 5-minute sleep.
    await supabase
      .from("app_users")
      .update({ failed_pin_attempts: 5, locked_until: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", appUserId);

    const result = await verifyPinCore(supabase, {
      pin: "999999",
      organizationId,
      sourceIdentifier: "test-source-fresh-cycle",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });

    const { data: row } = await supabase.from("app_users").select("failed_pin_attempts, locked_until").eq("id", appUserId).single();
    expect(row!.failed_pin_attempts).toBe(1);
    expect(row!.locked_until).toBeNull();

    await resetFixtureState();
  });

  it("correct PIN after an expired lockout resets attempts/lockout to 0/null", async () => {
    await resetFixtureState();
    await supabase
      .from("app_users")
      .update({ failed_pin_attempts: 5, locked_until: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", appUserId);

    const result = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIdentifier: "test-source-fresh-cycle-success",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result.ok).toBe(true);

    const { data: row } = await supabase.from("app_users").select("failed_pin_attempts, locked_until").eq("id", appUserId).single();
    expect(row!.failed_pin_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();

    await resetFixtureState();
  });
});

describe("PIN verify rate limiting", () => {
  it("blocks a single source after enough attempts within a window, while a different source is unaffected", async () => {
    const key = deriveRateLimitKey(`test-rate-limit-source-${Date.now()}`);
    const otherKey = deriveRateLimitKey(`test-rate-limit-other-${Date.now()}`);

    let lastResult: { allowed: boolean } = { allowed: true };
    for (let i = 0; i < 25; i++) {
      lastResult = await checkAndIncrementPinRateLimit(supabase, organizationId, key);
    }
    expect(lastResult.allowed).toBe(false);

    const otherResult = await checkAndIncrementPinRateLimit(supabase, organizationId, otherKey);
    expect(otherResult.allowed).toBe(true);
  });
});
