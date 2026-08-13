import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";
import { checkAndIncrementPinRateLimit, deriveRateLimitKey } from "@/app/lib/auth/rateLimit";
import { verifyPinCore } from "@/app/lib/auth/verifyPin";
import { resolveTestOrgId } from "./testFixtures";

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
 * per-employee failed-attempt counter or lockout -- brute-forcing the PIN
 * space is blunted only by the source-based rate limiter, covered below.
 */

const PIN = "483920";
const EMPLOYEE_CODE = "TEST-PIN-FIXTURE";

let supabase: SupabaseClient;
let organizationId: string;
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
    .update({ is_active: true, pin_lookup_hash: canonicalPinLookupHash, pin_hash: canonicalPinHash })
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
      sourceIdentifier: "test-source-correct-pin",
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
      pin: "000111",
      organizationId,
      sourceIdentifier: "test-source-no-match",
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
      sourceIdentifier: "test-source-inactive",
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
    const mismatchedHash = await hashPinForStorage("111222");
    await supabase.from("app_users").update({ pin_hash: mismatchedHash }).eq("id", appUserId);

    const result = await verifyPinCore(supabase, {
      pin: PIN,
      organizationId,
      sourceIdentifier: "test-source-credential-integrity",
      pinPepper,
      kioskTokenSecret,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_pin" });

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
