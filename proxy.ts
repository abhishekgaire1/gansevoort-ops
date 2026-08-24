import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session lifecycle audit fix -- SESSION MAINTENANCE ONLY.
 *
 * Prior to this file, nothing in the request pipeline had both (a)
 * permission to write response cookies and (b) ran proactively on every
 * Manager navigation before Server Components rendered. Server Components
 * can only read cookies; Server Actions can write them but only run for an
 * explicit action invocation, not a plain GET. That gap meant
 * getClaims()'s internal lazy refresh (see app/lib/auth/managerAuth.ts)
 * could succeed against Supabase Auth on a near-expiry access token, but
 * the rotated refresh token was never persisted back to the browser
 * (requireManagerOrAdmin()'s cookie jar is deliberately read-only) --
 * silently burning the one-time-use rotated refresh token, so the very
 * next request would fail to refresh and the Manager was logged out with
 * no warning, roughly once per access-token lifetime of continuous use.
 *
 * This file closes exactly that gap and nothing else:
 *   read cookies -> let Supabase refresh if the token is near expiry ->
 *   persist any resulting cookies to BOTH the request (so downstream
 *   Server Components in THIS render see them) and the response (so the
 *   browser has them for the NEXT request) -> continue.
 *
 * It does NOT authorize. It never decides Manager vs Admin, organization
 * membership, app_users.is_active, or any application permission, and it
 * never queries app_users/user_roles/vendors/reports/organization tables
 * -- only the Supabase Auth session client is used here. All of that
 * remains exclusively requireManagerOrAdmin()'s job
 * (app/lib/auth/managerAuth.ts), unchanged by this file. It also never
 * itself grants or denies access: on no session, an invalid/revoked
 * refresh token, or a transient Auth infrastructure failure, this
 * middleware just continues the request unmodified (or with whatever
 * partial cookie state it already had) and lets the existing
 * layout/requireManagerOrAdmin() fail-closed logic decide what happens,
 * exactly as before this file existed.
 */

function shortCorrelationId(): string {
  return Math.random().toString(36).slice(2, 8);
}

const isDev = process.env.NODE_ENV !== "production";

export async function proxy(request: NextRequest) {
  const correlationId = shortCorrelationId();
  const startedAt = Date.now();
  if (isDev) console.log(`[session:${correlationId}] START ${request.nextUrl.pathname}`);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    // Session maintenance can't run without config -- fail safe by doing
    // nothing. requireManagerOrAdmin() throws its own clear error for the
    // same missing env vars, so this is never silently swallowed.
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  let refreshed = false;

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        refreshed = true;
        // Update the request-side cookies so downstream Server Components
        // rendered for THIS request see the refreshed session...
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        // ...then rebuild the response from the updated request and set
        // the SAME cookies (with their full library-supplied options --
        // path/expires/sameSite/secure/httpOnly -- never overridden here)
        // on it, so the browser receives the rotated session too.
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  try {
    // getClaims() (not getUser()) -- consistent with
    // app/lib/auth/managerAuth.ts: for this project's confirmed asymmetric
    // (ES256) signing, this verifies locally after a one-time-per-isolate
    // cached JWKS fetch, and only reaches Supabase Auth over the network
    // when the stored session is missing, near expiry (triggering the
    // lazy refresh this file exists to persist), or genuinely invalid.
    // The result is intentionally unused: this call exists purely to
    // trigger session load/refresh as a side effect via setAll above, not
    // to make an authorization decision -- that stays exclusively
    // requireManagerOrAdmin()'s job, called again, independently, once
    // Server Component rendering begins.
    const { error } = await supabase.auth.getClaims();
    if (isDev) {
      console.log(
        `[session:${correlationId}] AUTH_VERIFY duration=${Date.now() - startedAt}ms REFRESHED=${refreshed} error=${error ? error.message : "none"}`
      );
    }
  } catch (err) {
    // A thrown error here means Supabase Auth itself is unreachable/erroring
    // (e.g. a transient infrastructure failure) -- never grant or deny
    // access from middleware, never retry, just continue the request as-is
    // and let requireManagerOrAdmin()'s own getClaims() call and
    // AuthInfrastructureError handling decide the outcome downstream.
    if (isDev) {
      console.log(`[session:${correlationId}] AUTH_VERIFY threw error=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (isDev) console.log(`[session:${correlationId}] DONE duration=${Date.now() - startedAt}ms`);

  return response;
}

export const config = {
  // Manager application routes only -- this is session maintenance for the
  // Manager auth cookie lifecycle, not a public-site concern. The Manager
  // login route is included deliberately: it's harmless (no session yet,
  // or a stale one worth refreshing before the login form itself decides
  // whether to redirect an already-authenticated Manager).
  matcher: ["/manager/:path*"],
};
