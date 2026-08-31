import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * CI-safe: no network, no database. Verifies the LOGICAL structure of the
 * Argon2 timing-normalization fix in verifyPinCore -- that every terminal
 * path calls exactly one PIN-verification-cost function (real or dummy) --
 * by spying on module-level function calls, not by measuring wall-clock
 * time (which would be flaky). See pin.unit.test.ts for the companion
 * proof that runDummyPinVerification performs a genuine Argon2id
 * verification and that its underlying hash is memoized, not regenerated,
 * and pinRateLimit.unit.test.ts for the full layered rate-limiter
 * behavior (device/ip/org/cpu-throttle) -- this file stubs rateLimit.ts
 * entirely (always "allowed"), since rate limiting itself is orthogonal to
 * what this file verifies.
 *
 * Under V1's PIN-only identification design there is no per-employee
 * failed-attempt/lockout state (see verifyPin.ts): a lookup either finds no
 * active, current-format, non-reset-required app_user at all (dummy
 * Argon2, always "invalid_pin") or finds exactly the account the
 * submitted PIN belongs to, in which case Argon2 verification against
 * pin_hash either succeeds (issues a kiosk token) or -- only in the
 * anomalous case where pin_hash and pin_lookup_hash have gone out of sync
 * for that account -- fails closed as a credential-integrity mismatch,
 * still reporting the same generic "invalid_pin".
 *
 * Both vi.mock calls below wrap the REAL implementations (so verifyPinCore
 * still runs actual argon2 logic here, just observably) rather than
 * replacing them with fakes -- these are spies, not stubs, except for the
 * rate-limit module, which is fully stubbed to "always allowed / no-op".
 */

vi.mock("@/app/lib/auth/rateLimit", () => ({
  deriveRateLimitKey: vi.fn((scope: string, source: string) => `key:${scope}:${source}`),
  registerPinFailureAcrossScopes: vi.fn(async () => ({ allowed: true })),
  resetDeviceScopeOnSuccess: vi.fn(async () => undefined),
  checkAndIncrementCpuThrottle: vi.fn(async () => ({ allowed: true })),
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
import { registerPinFailureAcrossScopes, resetDeviceScopeOnSuccess } from "@/app/lib/auth/rateLimit";
import { verifyPinCore } from "@/app/lib/auth/verifyPin";

const PIN_PEPPER = "test-pepper";
const KIOSK_TOKEN_SECRET = "test-kiosk-secret";
const ORG_ID = "org-1";

const BASE_INPUT = {
  organizationId: ORG_ID,
  sourceIp: "203.0.113.5",
  deviceId: "device-1",
  pinPepper: PIN_PEPPER,
  kioskTokenSecret: KIOSK_TOKEN_SECRET,
};

interface FakeAssignmentRow {
  out_station_id: string;
  out_station_name: string;
  out_station_code: string | null;
}

interface FakeSupabaseOptions {
  lookupData: Record<string, unknown> | null;
  lookupError?: unknown;
  /** Kiosk station assignment enforcement (20260811100130): verifyPinCore
   * now resolves station access via list_employee_station_assignments,
   * never a "stations" table lookup. Defaults to exactly one assignment
   * (the common case) so existing success-path tests that don't care
   * about station branching still resolve to a "single" StationAccess
   * without each needing to specify it. Pass an empty array for "blocked"
   * or two-or-more rows for "multiple". */
  assignmentRows?: FakeAssignmentRow[];
  assignmentError?: unknown;
}

const DEFAULT_ASSIGNMENT_ROWS: FakeAssignmentRow[] = [{ out_station_id: "station-1", out_station_name: "Grill", out_station_code: null }];

function createFakeSupabase({ lookupData, lookupError = null, assignmentRows = DEFAULT_ASSIGNMENT_ROWS, assignmentError = null }: FakeSupabaseOptions) {
  const appUsersMaybeSingle = vi.fn().mockResolvedValue({ data: lookupData, error: lookupError });
  // Chain is .select(...).eq("organization_id", ...).eq("pin_lookup_hash", ...)
  //   .eq("is_active", true).eq("kiosk_pin_format_version", "FOUR_DIGIT")
  //   .eq("kiosk_pin_reset_required", false).eq("employees.status", "active")
  //   .maybeSingle()
  const appUsersEq6 = vi.fn().mockReturnValue({ maybeSingle: appUsersMaybeSingle });
  const appUsersEq5 = vi.fn().mockReturnValue({ eq: appUsersEq6 });
  const appUsersEq4 = vi.fn().mockReturnValue({ eq: appUsersEq5 });
  const appUsersEq3 = vi.fn().mockReturnValue({ eq: appUsersEq4 });
  const appUsersEq2 = vi.fn().mockReturnValue({ eq: appUsersEq3 });
  const appUsersEq1 = vi.fn().mockReturnValue({ eq: appUsersEq2 });
  const appUsersSelect = vi.fn().mockReturnValue({ eq: appUsersEq1 });

  const from = vi.fn((table: string) => {
    if (table === "app_users") return { select: appUsersSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  const rpc = vi.fn((fn: string) => {
    if (fn === "list_employee_station_assignments") return Promise.resolve({ data: assignmentRows, error: assignmentError });
    throw new Error(`unexpected rpc: ${fn}`);
  });

  return {
    client: { from, rpc } as unknown as SupabaseClient,
    from,
    rpc,
    appUsersEq3,
    appUsersEq4,
    appUsersEq5,
    appUsersEq6,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyPinCore Argon2 call-count parity across terminal paths", () => {
  it("no matching PIN (unknown, or belonging to an inactive app_user): calls runDummyPinVerification once, never verifyPinHash", async () => {
    const { client, appUsersEq3, appUsersEq4, appUsersEq5, appUsersEq6 } = createFakeSupabase({ lookupData: null });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: "1234" });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(runDummyPinVerification).toHaveBeenCalledTimes(1);
    expect(verifyPinHash).toHaveBeenCalledTimes(0);
    // The lookup filters out inactive app_users, legacy/reset-required
    // accounts, and (Admin Foundation milestone) inactive/terminated
    // employees, all at the query level, never as separate branches.
    expect(appUsersEq3).toHaveBeenCalledWith("is_active", true);
    expect(appUsersEq4).toHaveBeenCalledWith("kiosk_pin_format_version", "FOUR_DIGIT");
    expect(appUsersEq5).toHaveBeenCalledWith("kiosk_pin_reset_required", false);
    expect(appUsersEq6).toHaveBeenCalledWith("employees.status", "active");
  });

  it("Admin Foundation milestone fix: a deactivated employee cannot verify their PIN even if app_users.is_active was left true", async () => {
    // Before this fix, verifyPinCore only ever checked app_users.is_active
    // -- an employee deactivated via Admin (employees.status = 'inactive')
    // whose app_users row was somehow left is_active=true could still pass
    // PIN verification. The employees!inner + .eq("employees.status",
    // "active") filter means Postgrest itself excludes such a row, so the
    // real query returns no match -- exactly the same "no row" shape the
    // lookupData: null fixture above already represents.
    const { client, appUsersEq6 } = createFakeSupabase({ lookupData: null });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: "1234" });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(appUsersEq6).toHaveBeenCalledWith("employees.status", "active");
  });

  it("forced-reset transition: a legacy six-digit/reset-required account's PIN cannot authenticate -- the same generic reason as no match at all", async () => {
    // A legacy account is filtered out by the lookup query itself
    // (kiosk_pin_format_version <> 'FOUR_DIGIT' or kiosk_pin_reset_required
    // = true), so this is observably identical to lookupData: null -- the
    // real behavioral proof (query-level exclusion) lives in the first
    // test above; this test documents the intent explicitly.
    const { client } = createFakeSupabase({ lookupData: null });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: "1234" });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(runDummyPinVerification).toHaveBeenCalledTimes(1);
  });

  it("credential-integrity mismatch (pin_lookup_hash matched but Argon2 fails): calls verifyPinHash once, never runDummyPinVerification, and fails closed", async () => {
    // A pin_hash that does NOT correspond to the submitted PIN, even though
    // the lookup already matched this app_user by pin_lookup_hash -- only
    // reachable in practice via account data corruption, never a plain
    // mistyped PIN (see the top-of-file comment).
    const mismatchedHash = await hashPinForStorage("9999");
    const { client } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: mismatchedHash,
        employee_id: "emp-1",
        employees: { first_name: "Test", last_name: "Employee" },
      },
    });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: "1111" });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(verifyPinHash).toHaveBeenCalledTimes(1);
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
  });

  it("correct PIN for a real, active, current-format app_user: calls verifyPinHash once, never runDummyPinVerification, and issues a kiosk token", async () => {
    const realPin = "4242";
    const realHash = await hashPinForStorage(realPin);
    const { client } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: realHash,
        employee_id: "emp-1",
        employees: { first_name: "Test", last_name: "Employee" },
      },
    });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: realPin });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appUserId).toBe("app-user-1");
    }
    expect(verifyPinHash).toHaveBeenCalledTimes(1);
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
  });

  it("a leading-zero PIN round-trips correctly (never coerced to a number)", async () => {
    const realPin = "0042";
    const realHash = await hashPinForStorage(realPin);
    const { client } = createFakeSupabase({
      lookupData: {
        id: "app-user-1",
        pin_hash: realHash,
        employee_id: "emp-1",
        employees: { first_name: "Test", last_name: "Employee" },
      },
    });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: realPin });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed PIN (not exactly 4 digits) before ever querying app_users", async () => {
    const { client, from } = createFakeSupabase({ lookupData: null });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: "123456" });

    expect(result).toEqual({ ok: false, reason: "invalid_pin" });
    expect(from).not.toHaveBeenCalledWith("app_users");
    expect(verifyPinHash).toHaveBeenCalledTimes(0);
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
  });

  it("no returned reason distinguishes 'no such PIN' from a credential-integrity mismatch -- both report the same generic reason", async () => {
    const notFound = await verifyPinCore(createFakeSupabase({ lookupData: null }).client, { ...BASE_INPUT, pin: "1234" });

    const mismatchedHash = await hashPinForStorage("9999");
    const credentialMismatch = await verifyPinCore(
      createFakeSupabase({
        lookupData: {
          id: "app-user-2",
          pin_hash: mismatchedHash,
          employee_id: "emp-2",
          employees: { first_name: "Test", last_name: "Employee" },
        },
      }).client,
      { ...BASE_INPUT, pin: "1111" }
    );

    expect(notFound).toEqual(credentialMismatch);
    expect(notFound).toEqual({ ok: false, reason: "invalid_pin" });
  });
});

describe("verifyPinCore rate-limit outcome recording", () => {
  it("atomically registers a failure across device/ip/org for an invalid-format PIN", async () => {
    await verifyPinCore(createFakeSupabase({ lookupData: null }).client, { ...BASE_INPUT, pin: "123456" });
    expect(registerPinFailureAcrossScopes).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.anything());
    expect(resetDeviceScopeOnSuccess).not.toHaveBeenCalled();
  });

  it("atomically registers a failure across device/ip/org for a no-match PIN", async () => {
    await verifyPinCore(createFakeSupabase({ lookupData: null }).client, { ...BASE_INPUT, pin: "1234" });
    expect(registerPinFailureAcrossScopes).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.anything());
    expect(resetDeviceScopeOnSuccess).not.toHaveBeenCalled();
  });

  it("atomically registers a failure across device/ip/org for a credential-integrity mismatch (matched lookup, wrong Argon2 hash), via the SAME path as the no-match case", async () => {
    const mismatchedHash = await hashPinForStorage("9999");
    await verifyPinCore(
      createFakeSupabase({
        lookupData: { id: "app-user-1", pin_hash: mismatchedHash, employee_id: "emp-1", employees: { first_name: "Test", last_name: "Employee" } },
      }).client,
      { ...BASE_INPUT, pin: "1111" }
    );
    expect(registerPinFailureAcrossScopes).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.anything());
    expect(resetDeviceScopeOnSuccess).not.toHaveBeenCalled();
  });

  it("a success never calls registerPinFailureAcrossScopes -- only resets the device scope", async () => {
    const realPin = "4242";
    const realHash = await hashPinForStorage(realPin);
    await verifyPinCore(
      createFakeSupabase({
        lookupData: { id: "app-user-1", pin_hash: realHash, employee_id: "emp-1", employees: { first_name: "Test", last_name: "Employee" } },
      }).client,
      { ...BASE_INPUT, pin: realPin }
    );
    expect(registerPinFailureAcrossScopes).not.toHaveBeenCalled();
    expect(resetDeviceScopeOnSuccess).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.anything());
  });

  it("PROVES THE ORDERING FIX: once registerPinFailureAcrossScopes reports the request is no longer permitted, a no-match PIN returns rate_limited WITHOUT ever running dummy Argon2 verification", async () => {
    vi.mocked(registerPinFailureAcrossScopes).mockResolvedValueOnce({ allowed: false });

    const result = await verifyPinCore(createFakeSupabase({ lookupData: null }).client, { ...BASE_INPUT, pin: "1234" });

    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(runDummyPinVerification).toHaveBeenCalledTimes(0);
  });

  it("once permitted, a no-match PIN still registers the failure BEFORE running dummy Argon2 (call-order proof, not just call-count)", async () => {
    const callOrder: string[] = [];
    vi.mocked(registerPinFailureAcrossScopes).mockImplementationOnce(async () => {
      callOrder.push("register");
      return { allowed: true };
    });
    vi.mocked(runDummyPinVerification).mockImplementationOnce(async () => {
      callOrder.push("dummy-argon2");
    });

    await verifyPinCore(createFakeSupabase({ lookupData: null }).client, { ...BASE_INPUT, pin: "1234" });

    expect(callOrder).toEqual(["register", "dummy-argon2"]);
  });

  it("a credential-integrity mismatch returns rate_limited (not invalid_pin) once the failure registration reports the request is no longer permitted", async () => {
    vi.mocked(registerPinFailureAcrossScopes).mockResolvedValueOnce({ allowed: false });
    const mismatchedHash = await hashPinForStorage("9999");

    const result = await verifyPinCore(
      createFakeSupabase({
        lookupData: { id: "app-user-1", pin_hash: mismatchedHash, employee_id: "emp-1", employees: { first_name: "Test", last_name: "Employee" } },
      }).client,
      { ...BASE_INPUT, pin: "1111" }
    );

    expect(result).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("verifyPinCore stationAccess on success (kiosk station assignment enforcement, 20260811100130)", () => {
  it("blocked: zero active station assignments -- never falls back to any station", async () => {
    const realPin = "4242";
    const realHash = await hashPinForStorage(realPin);
    const { client, rpc } = createFakeSupabase({
      lookupData: { id: "app-user-1", pin_hash: realHash, employee_id: "emp-1", employees: { first_name: "Sam", last_name: "T." } },
      assignmentRows: [],
    });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: realPin });

    expect(result).toEqual({
      ok: true,
      appUserId: "app-user-1",
      organizationId: ORG_ID,
      employeeDisplayName: "Sam T.",
      employeeFirstName: "Sam",
      kioskToken: expect.any(String),
      stationAccess: { kind: "blocked" },
    });
    expect(rpc).toHaveBeenCalledWith("list_employee_station_assignments", { p_organization_id: ORG_ID, p_employee_id: "emp-1" });
  });

  it("single: exactly one active station assignment auto-selects it", async () => {
    const realPin = "4242";
    const realHash = await hashPinForStorage(realPin);
    const { client } = createFakeSupabase({
      lookupData: { id: "app-user-1", pin_hash: realHash, employee_id: "emp-1", employees: { first_name: "Maria", last_name: "G." } },
      assignmentRows: [{ out_station_id: "station-1", out_station_name: "Grill", out_station_code: null }],
    });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: realPin });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stationAccess).toEqual({ kind: "single", stationId: "station-1", stationName: "Grill" });
    }
  });

  it("multiple: two or more active station assignments require the picker -- the full list is fetched separately, not embedded here", async () => {
    const realPin = "4242";
    const realHash = await hashPinForStorage(realPin);
    const { client } = createFakeSupabase({
      lookupData: { id: "app-user-1", pin_hash: realHash, employee_id: "emp-1", employees: { first_name: "Jordan", last_name: "K." } },
      assignmentRows: [
        { out_station_id: "station-1", out_station_name: "Grill", out_station_code: null },
        { out_station_id: "station-2", out_station_name: "Prep", out_station_code: null },
      ],
    });

    const result = await verifyPinCore(client, { ...BASE_INPUT, pin: realPin });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stationAccess).toEqual({ kind: "multiple" });
    }
  });
});
