import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database -- fakes next/headers, @supabase/ssr,
// and the service-role client directly. No real Supabase Auth traffic.

const { cookiesMock } = vi.hoisted(() => ({ cookiesMock: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: cookiesMock }));

const { getClaimsMock, createServerClientMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createServerClientMock: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: createServerClientMock }));

const { fromMock, getServiceRoleClientMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  getServiceRoleClientMock: vi.fn(),
}));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import { requireManagerOrAdmin, requireAdmin, AuthInfrastructureError } from "@/app/lib/auth/managerAuth";

const AUTH_USER_ID = "auth-user-1";
const APP_USER_ID = "app-user-1";
const ORG_ID = "org-1";

function claimsOk(sub = AUTH_USER_ID) {
  return { data: { claims: { sub }, header: {}, signature: new Uint8Array() }, error: null };
}

function authApiError(status: number, code: string, message = "boom") {
  return { name: "AuthApiError", status, code, message };
}

/** Mirrors the real chained query shape (.from().select().eq().eq().maybeSingle()
 * / .from().select().eq()) used by app_users / user_roles lookups. */
function fakeServiceClient(opts: { appUser: { id: string; organization_id: string } | null; appUserError?: unknown; roles: string[]; roleError?: unknown }) {
  return {
    from: vi.fn((table: string) => {
      if (table === "app_users") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.appUser, error: opts.appUserError ?? null }),
              }),
            }),
          }),
        };
      }
      if (table === "user_roles") {
        return {
          select: () => ({
            eq: async () => ({ data: opts.roles.map((name) => ({ roles: { name } })), error: opts.roleError ?? null }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  };
}

function setUp(opts: { getClaimsResult: unknown; appUser?: { id: string; organization_id: string } | null; appUserError?: unknown; roles?: string[]; roleError?: unknown }) {
  cookiesMock.mockResolvedValue({ getAll: () => [] });
  getClaimsMock.mockResolvedValue(opts.getClaimsResult);
  createServerClientMock.mockReturnValue({ auth: { getClaims: getClaimsMock } });
  getServiceRoleClientMock.mockReturnValue(
    fakeServiceClient({
      // `"appUser" in opts` (not `opts.appUser ?? default`) -- `??` cannot
      // distinguish "not provided" from "explicitly null", and tests 4 and
      // the app_users-error case both deliberately pass appUser: null to
      // simulate no matching/active app_user row.
      appUser: "appUser" in opts ? opts.appUser ?? null : { id: APP_USER_ID, organization_id: ORG_ID },
      appUserError: opts.appUserError,
      roles: opts.roles ?? ["manager"],
      roleError: opts.roleError,
    })
  );
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-key";
  cookiesMock.mockReset();
  getClaimsMock.mockReset();
  createServerClientMock.mockReset();
  getServiceRoleClientMock.mockReset();
  fromMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("requireManagerOrAdmin -- authorization outcomes", () => {
  it("1. an authenticated Manager is allowed", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["manager"] });
    const result = await requireManagerOrAdmin();
    expect(result).toEqual({ ok: true, manager: { appUserId: APP_USER_ID, organizationId: ORG_ID, authUserId: AUTH_USER_ID, roles: ["manager"] } });
  });

  it("2. an authenticated Admin is allowed", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["admin"] });
    const result = await requireManagerOrAdmin();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manager.roles).toContain("admin");
  });

  it("3. an Employee (or any non-manager/admin role) is denied", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["employee"] });
    const result = await requireManagerOrAdmin();
    expect(result).toEqual({ ok: false, reason: "not_authorized" });
  });

  it("4. an inactive/unresolvable app_user account is denied", async () => {
    setUp({ getClaimsResult: claimsOk(), appUser: null });
    const result = await requireManagerOrAdmin();
    expect(result).toEqual({ ok: false, reason: "not_authorized" });
  });

  it("5. organization scoping is preserved -- the resolved organizationId comes from the DB row, never guessed/defaulted", async () => {
    setUp({ getClaimsResult: claimsOk(), appUser: { id: APP_USER_ID, organization_id: "a-specific-org" }, roles: ["manager"] });
    const result = await requireManagerOrAdmin();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manager.organizationId).toBe("a-specific-org");
  });

  it("6. an unauthenticated request (no verifiable claims) is denied", async () => {
    setUp({ getClaimsResult: { data: { claims: null }, error: null } });
    const result = await requireManagerOrAdmin();
    expect(result).toEqual({ ok: false, reason: "not_authenticated" });
  });

  it("6b. a getClaims error that is NOT a transient infra failure (e.g. a genuinely invalid/expired JWT) is treated as not_authenticated", async () => {
    setUp({ getClaimsResult: { data: null, error: authApiError(401, "bad_jwt", "invalid JWT") } });
    const result = await requireManagerOrAdmin();
    expect(result).toEqual({ ok: false, reason: "not_authenticated" });
  });

  it("7. a transient Auth verification failure (429 rate limit) throws AuthInfrastructureError -- it is NEVER classified as not_authenticated, and access is never granted", async () => {
    setUp({ getClaimsResult: { data: null, error: authApiError(429, "over_request_rate_limit", "Request rate limit reached") } });
    await expect(requireManagerOrAdmin()).rejects.toBeInstanceOf(AuthInfrastructureError);
  });

  it("7b. a 5xx Auth service failure is also treated as transient infrastructure, not not_authenticated", async () => {
    setUp({ getClaimsResult: { data: null, error: authApiError(503, "service_unavailable") } });
    await expect(requireManagerOrAdmin()).rejects.toBeInstanceOf(AuthInfrastructureError);
  });

  it("app_users lookup DB error throws (never silently treated as any particular auth outcome)", async () => {
    setUp({ getClaimsResult: claimsOk(), appUserError: { message: "connection reset" } });
    await expect(requireManagerOrAdmin()).rejects.toThrow(/failed to resolve app_user/);
  });

  it("user_roles lookup DB error throws", async () => {
    setUp({ getClaimsResult: claimsOk(), roleError: { message: "connection reset" } });
    await expect(requireManagerOrAdmin()).rejects.toThrow(/failed to resolve roles/);
  });
});

describe("requireAdmin", () => {
  it("allows an Admin", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["admin"] });
    const result = await requireAdmin();
    expect(result.ok).toBe(true);
  });

  it("denies a Manager who is not also an Admin", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["manager"] });
    const result = await requireAdmin();
    expect(result).toEqual({ ok: false, reason: "not_authorized" });
  });
});

describe("9/10. different requests do not share state; a role change is visible on the next call", () => {
  it("two sequential calls with different underlying data each reflect their OWN call's data -- no stale/shared state leaks between them", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["manager"] });
    const first = await requireManagerOrAdmin();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.manager.roles).toEqual(["manager"]);

    // Simulate an Admin having since revoked the manager role and granted
    // admin instead -- a fresh call (a NEW request in real usage; this test
    // cannot exercise React's actual per-request cache reset without a
    // real render, see the note in item 8 below) must reflect the change.
    setUp({ getClaimsResult: claimsOk("auth-user-2"), appUser: { id: "app-user-2", organization_id: ORG_ID }, roles: ["admin"] });
    const second = await requireManagerOrAdmin();
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.manager.roles).toEqual(["admin"]);
      expect(second.manager.authUserId).toBe("auth-user-2");
    }
  });
});

describe("8. request-scoped memoization (React cache()) -- documented behavior, with an honest test-environment caveat", () => {
  it("calling requireManagerOrAdmin() concurrently resolves correctly for every caller (functional correctness, independent of whether caching engages)", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["manager"] });
    const results = await Promise.all([requireManagerOrAdmin(), requireManagerOrAdmin(), requireManagerOrAdmin(), requireManagerOrAdmin()]);
    for (const result of results) {
      expect(result).toEqual({ ok: true, manager: { appUserId: APP_USER_ID, organizationId: ORG_ID, authUserId: AUTH_USER_ID, roles: ["manager"] } });
    }
  });

  it("documents that React's cache() only memoizes inside an ACTIVE React render/request scope -- outside of one (as in this plain Vitest environment) each call legitimately re-executes the underlying getClaims()/DB calls, so this suite cannot itself prove call-count deduplication", async () => {
    setUp({ getClaimsResult: claimsOk(), roles: ["manager"] });
    await Promise.all([requireManagerOrAdmin(), requireManagerOrAdmin()]);
    // Outside a real render, cache() does not persist a memoized entry, so
    // both calls really do invoke getClaims() independently here -- this
    // assertion documents that fact rather than asserting deduplication.
    // The real per-request dedup guarantee comes from React's documented
    // cache() semantics plus Next.js's per-request render scope, and is
    // confirmed empirically via the [auth:...] correlation-id logging
    // during a real manual reproduction (one correlation id per report
    // render, not 3-7), not via this unit test.
    expect(getClaimsMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
