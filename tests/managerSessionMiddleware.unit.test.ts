import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// CI-safe: no network, no database, no real Supabase Auth traffic.
// createServerClient is mocked; its provided cookies.setAll callback is
// invoked directly from the mocked getClaims() implementation to simulate
// exactly what @supabase/ssr does internally when a session is refreshed --
// this lets us test middleware's OWN request/response cookie plumbing
// without needing real JWTs, WebCrypto, or a live Supabase project.

type CapturedCookies = {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: { name: string; value: string; options?: Record<string, unknown> }[]) => void;
};

const { createServerClientMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: createServerClientMock }));

function setUp(opts: { getClaimsImpl: (cookies: CapturedCookies) => Promise<unknown> }) {
  createServerClientMock.mockImplementation((_url: string, _key: string, options: { cookies: CapturedCookies }) => {
    return { auth: { getClaims: () => opts.getClaimsImpl(options.cookies) } };
  });
}

function requestFor(pathname: string, cookieHeader = ""): NextRequest {
  return new NextRequest(new URL(pathname, "https://example.com"), {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-key";
  createServerClientMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("manager session middleware", () => {
  it("1. valid, non-near-expiry session: request passes through, no cookies rewritten", async () => {
    setUp({ getClaimsImpl: async () => ({ data: { claims: { sub: "auth-user-1" } }, error: null }) });
    const { proxy: middleware } = await import("@/proxy");
    const request = requestFor("/manager/reports/purchasing", "sb-auth-token=valid-session");
    const response = await middleware(request);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("2 & 3. near-expiry session: refresh occurs, rotated cookies written to BOTH request and response", async () => {
    setUp({
      getClaimsImpl: async (cookies) => {
        cookies.setAll([
          { name: "sb-auth-token", value: "rotated-value-B", options: { path: "/", sameSite: "lax", secure: true, httpOnly: false, maxAge: 3600 } },
        ]);
        return { data: { claims: { sub: "auth-user-1" } }, error: null };
      },
    });
    const { proxy: middleware } = await import("@/proxy");
    const request = requestFor("/manager/reports/purchasing", "sb-auth-token=near-expiry-A");
    const response = await middleware(request);

    // 4. downstream Server Components read cookies off the SAME request
    // object middleware mutated -- assert it reflects the rotated value.
    expect(request.cookies.get("sb-auth-token")?.value).toBe("rotated-value-B");

    // 3. the browser-facing response carries the rotated cookie too.
    const setCookieHeader = response.headers.get("set-cookie");
    expect(setCookieHeader).toContain("sb-auth-token=rotated-value-B");
  });

  it("7. cookie attributes supplied by the Supabase library are preserved verbatim, never replaced", async () => {
    setUp({
      getClaimsImpl: async (cookies) => {
        cookies.setAll([
          {
            name: "sb-refresh-token",
            value: "rotated-refresh-B",
            options: { path: "/manager", sameSite: "strict", secure: true, httpOnly: true, maxAge: 400 * 24 * 60 * 60 },
          },
        ]);
        return { data: { claims: { sub: "auth-user-1" } }, error: null };
      },
    });
    const { proxy: middleware } = await import("@/proxy");
    const request = requestFor("/manager/reports/purchasing", "sb-refresh-token=old-refresh-A");
    const response = await middleware(request);

    const setCookieHeader = response.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("Path=/manager");
    expect(setCookieHeader.toLowerCase()).toContain("samesite=strict");
    expect(setCookieHeader).toContain("Secure");
    expect(setCookieHeader).toContain("HttpOnly");
  });

  it("5. missing session: middleware passes through safely -- no cookies written, no error thrown, no access decision made", async () => {
    setUp({ getClaimsImpl: async () => ({ data: { claims: null }, error: null }) });
    const { proxy: middleware } = await import("@/proxy");
    const request = requestFor("/manager/reports/purchasing");
    const response = await middleware(request);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("6. invalid/revoked refresh token: getClaims resolves with an error, no cookies written, no access granted by middleware", async () => {
    setUp({ getClaimsImpl: async () => ({ data: null, error: { name: "AuthApiError", status: 400, code: "refresh_token_not_found", message: "Invalid Refresh Token" } }) });
    const { proxy: middleware } = await import("@/proxy");
    const request = requestFor("/manager/reports/purchasing", "sb-auth-token=stale;sb-refresh-token=already-used");
    const response = await middleware(request);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.status).toBe(200); // middleware itself never redirects/denies -- that stays requireManagerOrAdmin()'s job
  });

  it("6b. invalid refresh token calls the underlying auth check exactly once -- no retry loop", async () => {
    const claimsSpy = vi.fn(async () => ({ data: null, error: { name: "AuthApiError", status: 400, code: "refresh_token_not_found", message: "Invalid Refresh Token" } }));
    setUp({ getClaimsImpl: claimsSpy });
    const { proxy: middleware } = await import("@/proxy");
    await middleware(requestFor("/manager/reports/purchasing"));
    expect(claimsSpy).toHaveBeenCalledTimes(1);
  });

  it("9/13. a transient Auth infrastructure failure (thrown, not returned) never blocks or grants -- request still continues, no retry", async () => {
    const claimsSpy = vi.fn(async () => {
      throw Object.assign(new Error("Request rate limit reached"), { name: "AuthApiError", status: 429 });
    });
    setUp({ getClaimsImpl: claimsSpy });
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(requestFor("/manager/reports/purchasing"));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(claimsSpy).toHaveBeenCalledTimes(1);
  });

  it("10. sign-out state: no session cookies present, middleware writes nothing that could fight signOutManager's own cookie-clearing", async () => {
    setUp({ getClaimsImpl: async () => ({ data: { claims: null }, error: null }) });
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(requestFor("/manager/login"));
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("8. matcher scopes to Manager routes only", async () => {
    const { config } = await import("@/proxy");
    expect(config.matcher).toEqual(["/manager/:path*"]);
  });
});
