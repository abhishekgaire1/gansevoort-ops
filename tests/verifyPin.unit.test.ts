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
}

function createFakeSupabase({ lookupData, lookupError = null }: FakeSupabaseOptions) {
  const rpc = vi.fn().mockResolvedValue({ data: [{ failed_pin_attempts: 1, locked_until: null }], error: null });
  const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  const maybeSingle = vi.fn().mockResolvedValue({ data: lookupData, error: lookupError });
  const selectEq2 = vi.fn().mockReturnValue({ maybeSingle });
  const selectEq1 = vi.fn().mockReturnValue({ eq: selectEq2 });
  const select = vi.fn().mockReturnValue({ eq: selectEq1 });
  const from = vi.fn().mockReturnValue({ select, update });
  return { client: { from, rpc } as unknown as SupabaseClient, rpc, update, updateEq };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyPinCore Argon2 call-count parity across terminal paths", () => {
  it("no matching employee: calls runDummyPinVerification once, never verifyPinHash", async () => {
    const { client } = createFakeSupabase({ lookupData: null });

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
  });

  it("locked employee: calls runDummyPinVerification once, never verifyPinHash", async () => {
    const { client } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: "irrelevant",
        failed_pin_attempts: 5,
        locked_until: new Date(Date.now() + 60_000).toISOString(),
        employee_id: "emp-1",
        employees: { first_name: "Test", last_name: "Employee" },
      },
    });

    const result = await verifyPinCore(client, {
      pin: "123456",
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    expect(result).toEqual({ ok: false, reason: "locked" });
    expect(runDummyPinVerification).toHaveBeenCalledTimes(1);
    expect(verifyPinHash).toHaveBeenCalledTimes(0);
  });

  it("wrong PIN for a real, unlocked employee: calls verifyPinHash once, never runDummyPinVerification, and registers the failure atomically", async () => {
    const realHash = await hashPinForStorage("999999");
    const { client, rpc } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: realHash,
        failed_pin_attempts: 0,
        locked_until: null,
        employee_id: "emp-1",
        employees: { first_name: "Test", last_name: "Employee" },
      },
    });

    const result = await verifyPinCore(client, {
      pin: "111111", // wrong
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(verifyPinHash).toHaveBeenCalledTimes(1);
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
    // Failure bookkeeping goes through the atomic RPC, not a read-then-write update.
    expect(rpc).toHaveBeenCalledWith("register_pin_verification_failure", { p_app_user_id: "app-user-1" });
  });

  it("correct PIN for a real, unlocked employee: calls verifyPinHash once, never runDummyPinVerification, and resets attempts", async () => {
    const realPin = "424242";
    const realHash = await hashPinForStorage(realPin);
    const { client, update, updateEq } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: realHash,
        failed_pin_attempts: 3,
        locked_until: null,
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
    expect(verifyPinHash).toHaveBeenCalledTimes(1);
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
    expect(update).toHaveBeenCalledWith({ failed_pin_attempts: 0, locked_until: null });
    expect(updateEq).toHaveBeenCalledWith("id", "app-user-1");
  });

  it("no returned message distinguishes 'no such employee' from 'wrong PIN for a real employee' -- both report the same generic reason", async () => {
    const notFound = await verifyPinCore(createFakeSupabase({ lookupData: null }).client, {
      pin: "123456",
      organizationId: ORG_ID,
      sourceIdentifier: "src-1",
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });

    const realHash = await hashPinForStorage("999999");
    const wrongForReal = await verifyPinCore(
      createFakeSupabase({
        lookupData: {
          id: "app-user-2",
          pin_hash: realHash,
          failed_pin_attempts: 0,
          locked_until: null,
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

    expect(notFound).toEqual(wrongForReal);
    expect(notFound).toEqual({ ok: false, reason: "invalid_pin" });
  });
});
