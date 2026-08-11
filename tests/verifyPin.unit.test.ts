import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * CI-safe: no network, no database. Verifies the LOGICAL structure of the
 * Argon2 timing-normalization fix in verifyPinCore -- that every terminal
 * path calls exactly one PIN-verification-cost function (real or dummy) --
 * by spying on module-level function calls, not by measuring wall-clock
 * time (which would be flaky). See pin.unit.test.ts for the companion
 * proof that runDummyPinVerification performs a genuine Argon2id
 * verification and that its underlying hash is memoized, not regenerated.
 *
 * Under V1's PIN-only identification design there is no per-employee
 * failed-attempt/lockout state (see verifyPin.ts): a lookup either finds no
 * active app_user at all (dummy Argon2, always "invalid_pin") or finds
 * exactly the account the submitted PIN belongs to, in which case Argon2
 * verification against pin_hash either succeeds (issues a kiosk token) or
 * -- only in the anomalous case where pin_hash and pin_lookup_hash have
 * gone out of sync for that account -- fails closed as a credential-
 * integrity mismatch, still reporting the same generic "invalid_pin".
 *
 * Both vi.mock calls below wrap the REAL implementations (so verifyPinCore
 * still runs actual argon2/rate-limit logic here, just observably) rather
 * than replacing them with fakes -- these are spies, not stubs, except for
 * checkAndIncrementPinRateLimit, which is fully stubbed to "always allowed"
 * since rate limiting itself is already covered by pin.unit.test.ts and
 * pin.integration.test.ts and is orthogonal to what this file verifies.
 */

vi.mock("@/app/lib/auth/rateLimit", () => ({
  deriveRateLimitKey: vi.fn((source: string) => `key:${source}`),
  checkAndIncrementPinRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/app/lib/auth/pin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/auth/pin")>();
  return {
    ...actual,
    verifyPinHash: vi.fn(actual.verifyPinHash),
    runDummyPinVerification: vi.fn(actual.runDummyPinVerification),
  };
});

import { hashPinForStorage, runDummyPinVerification, verifyPinHash } from "@/app/lib/auth/pin";
import { verifyPinCore } from "@/app/lib/auth/verifyPin";

const PIN_PEPPER = "test-pepper";
const KIOSK_TOKEN_SECRET = "test-kiosk-secret";
const ORG_ID = "org-1";

interface FakeSupabaseOptions {
  lookupData: Record<string, unknown> | null;
  lookupError?: unknown;
  /** Only consulted when lookupData's nested employees.default_station_id
   * is non-null -- verifyPinCore issues a second lookup against "stations"
   * only in that case. */
  stationData?: Record<string, unknown> | null;
  stationError?: unknown;
}

function createFakeSupabase({ lookupData, lookupError = null, stationData = null, stationError = null }: FakeSupabaseOptions) {
  const appUsersMaybeSingle = vi.fn().mockResolvedValue({ data: lookupData, error: lookupError });
  // Chain is .select(...).eq("organization_id", ...).eq("pin_lookup_hash", ...).eq("is_active", true).maybeSingle()
  const appUsersEq3 = vi.fn().mockReturnValue({ maybeSingle: appUsersMaybeSingle });
  const appUsersEq2 = vi.fn().mockReturnValue({ eq: appUsersEq3 });
  const appUsersEq1 = vi.fn().mockReturnValue({ eq: appUsersEq2 });
  const appUsersSelect = vi.fn().mockReturnValue({ eq: appUsersEq1 });

  const stationsMaybeSingle = vi.fn().mockResolvedValue({ data: stationData, error: stationError });
  // Chain is .select("name").eq("id", ...).maybeSingle()
  const stationsEq = vi.fn().mockReturnValue({ maybeSingle: stationsMaybeSingle });
  const stationsSelect = vi.fn().mockReturnValue({ eq: stationsEq });

  const from = vi.fn((table: string) => {
    if (table === "app_users") return { select: appUsersSelect };
    if (table === "stations") return { select: stationsSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  return { client: { from } as unknown as SupabaseClient, from, appUsersEq3, stationsSelect, stationsEq };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyPinCore Argon2 call-count parity across terminal paths", () => {
  it("no matching PIN (unknown, or belonging to an inactive app_user): calls runDummyPinVerification once, never verifyPinHash", async () => {
    const { client, appUsersEq3 } = createFakeSupabase({ lookupData: null });

    const result = await verifyPinCore(client, {
      pin: "123456",
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(runDummyPinVerification).toHaveBeenCalledTimes(1);
    expect(verifyPinHash).toHaveBeenCalledTimes(0);
    // The lookup filters out inactive app_users at the query level, not as a separate branch.
    expect(appUsersEq3).toHaveBeenCalledWith("is_active", true);
  });

  it("credential-integrity mismatch (pin_lookup_hash matched but Argon2 fails): calls verifyPinHash once, never runDummyPinVerification, and fails closed", async () => {
    // A pin_hash that does NOT correspond to the submitted PIN, even though
    // the lookup already matched this app_user by pin_lookup_hash -- only
    // reachable in practice via account data corruption, never a plain
    // mistyped PIN (see the top-of-file comment).
    const mismatchedHash = await hashPinForStorage("999999");
    const { client } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: mismatchedHash,
        employee_id: "emp-1",
        employees: { first_name: "Test", last_name: "Employee" },
      },
    });

    const result = await verifyPinCore(client, {
      pin: "111111",
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(verifyPinHash).toHaveBeenCalledTimes(1);
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
  });

  it("correct PIN for a real, active app_user: calls verifyPinHash once, never runDummyPinVerification, and issues a kiosk token", async () => {
    const realPin = "424242";
    const realHash = await hashPinForStorage(realPin);
    const { client } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: realHash,
        employee_id: "emp-1",
        employees: { first_name: "Test", last_name: "Employee" },
      },
    });

    const result = await verifyPinCore(client, {
      pin: realPin,
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appUserId).toBe("app-user-1");
    }
    expect(verifyPinHash).toHaveBeenCalledTimes(1);
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
  });

  it("no returned reason distinguishes 'no such PIN' from a credential-integrity mismatch -- both report the same generic reason", async () => {
    const notFound = await verifyPinCore(createFakeSupabase({ lookupData: null }).client, {
      pin: "123456",
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    const mismatchedHash = await hashPinForStorage("999999");
    const credentialMismatch = await verifyPinCore(
      createFakeSupabase({
        lookupData: {
          id: "app-user-2",
          pin_hash: mismatchedHash,
          employee_id: "emp-2",
          employees: { first_name: "Test", last_name: "Employee" },
        },
      }).client,
      {
        pin: "111111",
        organizationId: ORG_ID,
        sourceIdentifier: "src-1",
        pinPepper: PIN_PEPPER,
        kioskTokenSecret: KIOSK_TOKEN_SECRET,
      }
    );

    expect(notFound).toEqual(credentialMismatch);
    expect(notFound).toEqual({ ok: false, reason: "invalid_pin" });
  });
});

describe("verifyPinCore station config fields on success", () => {
  it("returns defaultStationId/defaultStationName/autoResolveStation/canChangeStation from the employee row, looking up the station name separately", async () => {
    const realPin = "424242";
    const realHash = await hashPinForStorage(realPin);
    const { client, from } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: realHash,
        employee_id: "emp-1",
        employees: {
          first_name: "Maria",
          last_name: "G.",
          default_station_id: "station-1",
          auto_resolve_station: true,
          can_change_station: false,
        },
      },
      stationData: { name: "Grill" },
    });

    const result = await verifyPinCore(client, {
      pin: realPin,
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    expect(result).toEqual({
      ok: true,
      appUserId: "app-user-1",
      organizationId: ORG_ID,
      employeeDisplayName: "Maria G.",
      kioskToken: expect.any(String),
      defaultStationId: "station-1",
      defaultStationName: "Grill",
      autoResolveStation: true,
      canChangeStation: false,
    });
    expect(from).toHaveBeenCalledWith("stations");
  });

  it("does not query the stations table at all when the employee has no default station (must_pick branch)", async () => {
    const realPin = "424242";
    const realHash = await hashPinForStorage(realPin);
    const { client, from } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: realHash,
        employee_id: "emp-1",
        employees: {
          first_name: "Sam",
          last_name: "T.",
          default_station_id: null,
          auto_resolve_station: false,
          can_change_station: false,
        },
      },
    });

    const result = await verifyPinCore(client, {
      pin: realPin,
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.defaultStationId).toBeNull();
      expect(result.defaultStationName).toBeNull();
      expect(result.autoResolveStation).toBe(false);
    }
    expect(from).not.toHaveBeenCalledWith("stations");
  });
});
