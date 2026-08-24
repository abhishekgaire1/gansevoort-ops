import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";

/**
 * Resolves the manager/admin calling a manager-only server action, via
 * their Supabase Auth session (browser, not the shared kiosk). Only this
 * resolve/authorize helper is in scope this slice -- no login page.
 *
 * The auth-session client only proves *who* is asking (their auth.users id
 * -> app_users row). Looking up their app_user row and roles still goes
 * through the service-role client, matching the deny-by-default RLS
 * posture used everywhere else in this schema: an authenticated Supabase
 * Auth session grants no direct table access on its own.
 *
 * ============================================================
 * Reports 429 fix (auth request fan-out)
 * ============================================================
 * This function used to be called independently, unmemoized, 3-7 times
 * per single report page render, each call doing auth.getUser() -- which
 * ALWAYS makes a network request to Supabase Auth to revalidate the JWT,
 * every single time, by design (it deliberately never trusts a
 * client-suppliable session without asking the Auth server). Under rapid
 * Reports navigation this produced enough concurrent Auth traffic from
 * ONE manager to trip Supabase's own `over_request_rate_limit` (429),
 * which then got misclassified as "not authenticated" by the caller.
 *
 * Two independent, compounding fixes:
 *
 * 1. auth.getClaims() instead of auth.getUser() -- confirmed appropriate
 *    for THIS project specifically (not assumed): the linked project's
 *    JWT signing key discovery endpoint
 *    (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) was queried
 *    directly and returns a real ES256 (asymmetric, elliptic-curve) key,
 *    not an empty keyset. getClaims() verifies an asymmetrically-signed
 *    JWT LOCALLY via the WebCrypto API once the signing key is cached
 *    (one JWKS fetch, reused after) -- no per-call network request to
 *    Supabase Auth at all, unlike getUser(). (The SDK's own getClaims()
 *    doc comment is explicit that for a SYMMETRIC-signed project it falls
 *    back to a getUser()-shaped network call every time -- that is NOT
 *    this project, confirmed above, which is why this switch is safe and
 *    actually effective here rather than a blind swap.) claims.sub is the
 *    verified authenticated auth.users id, the same identity getUser()'s
 *    user.id provided -- used identically below to resolve app_user/
 *    organization/roles, which remain 100% database-authoritative,
 *    exactly as before. getSession().user is never used as authorization
 *    authority; only the cryptographically-verified claims are trusted.
 *
 * 2. React cache() -- request-scoped memoization (React 19, used exactly
 *    as documented/established for Next.js App Router "resolve the
 *    current user once per request" helpers). Verified directly, not
 *    assumed: react-server's cache() (node_modules/react/cjs/
 *    react.react-server.development.js) stores its memoized result on a
 *    cache root obtained from `ReactSharedInternals.A` -- the CURRENT
 *    request/render's active dispatcher, which Next.js's App Router
 *    server runtime allocates fresh per request. There is no
 *    module-level/global map inside cache() itself: if no request
 *    dispatcher is active (e.g. this function were ever called outside a
 *    real render), cache() safely falls back to calling straight through
 *    with no memoization at all, rather than caching into some shared
 *    fallback store -- so there is no code path by which one request's
 *    result could be written into a slot another request could read. This
 *    function's own identity resolution is also independently keyed off
 *    next/headers' cookies(), itself already strictly request-scoped by
 *    the framework -- so even two different Managers' requests
 *    interleaved on the same server process each read their OWN request's
 *    cookies and dispatcher, and therefore never share a cached result. No
 *    global/process-level cache, no cross-user contamination, no cache
 *    TTL beyond the single request -- a role change by an Admin is
 *    visible on the very next request, since nothing here persists past
 *    one render.
 *
 * A rate-limited (or otherwise transiently failing) Auth verification is
 * explicitly distinguished from a genuine "no session" condition (Section
 * 11) -- see AuthInfrastructureError below. It is thrown, never folded
 * into `{ ok: false, reason: "not_authenticated" }`, and access is never
 * granted on it (fail closed): every existing `if (!auth.ok)` call site
 * throughout the app is completely unaffected (still only ever sees the
 * same two existing reasons), and the thrown error propagates to
 * whichever error boundary already exists for that surface (for Reports,
 * the error.tsx built in the previous pass, which already renders a safe,
 * generic, recoverable "couldn't load this report -- Try Again" state
 * with no internal detail exposed).
 */

export interface AuthorizedManager {
  appUserId: string;
  organizationId: string;
  authUserId: string;
  roles: string[];
}

export type ManagerAuthResult =
  | { ok: true; manager: AuthorizedManager }
  | { ok: false; reason: "not_authenticated" | "not_authorized" };

const AUTHORIZED_ROLE_NAMES = ["manager", "admin"];

/** Supabase Auth itself failed transiently (rate limited, 5xx) -- NOT
 * evidence the user is logged out. Thrown rather than returned so it can
 * never be silently folded into "not_authenticated" by a caller that only
 * checks `.ok`. */
export class AuthInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthInfrastructureError";
  }
}

/** Duck-typed rather than imported from @supabase/auth-js's internals
 * (not re-exported from the top-level @supabase/supabase-js package) --
 * matches the exact, confirmed shape of AuthApiError (name/status/code),
 * including the real 429/over_request_rate_limit evidence captured
 * during this investigation. */
function isTransientAuthInfraError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, status } = error as { name?: unknown; status?: unknown };
  if (name !== "AuthApiError") return false;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function shortCorrelationId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * TEMPORARY diagnostic instrumentation (Reports rapid-navigation
 * investigation) -- pure logging alongside the real fix above. With
 * request-scoped memoization in place, this should now log ONCE per
 * report render (not 3-7 times) -- the correlation id + stage timings
 * let that be confirmed directly from server output. Remove once the
 * investigation concludes.
 */
export const requireManagerOrAdmin = cache(async function requireManagerOrAdmin(): Promise<ManagerAuthResult> {
  const correlationId = shortCorrelationId();
  const startedAt = Date.now();
  console.log(`[auth:${correlationId}] START requireManagerOrAdmin (memoized per request)`);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  const cookieStore = await cookies();
  const supabaseAuthClient = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      // Read-only usage: this helper only resolves the caller's identity,
      // it never needs to refresh/write auth cookies itself.
      setAll: () => {},
    },
  });

  const verifyStartedAt = Date.now();
  let authUserId: string | null = null;
  try {
    const { data, error } = await supabaseAuthClient.auth.getClaims();
    if (error) {
      if (isTransientAuthInfraError(error)) {
        console.log(`[auth:${correlationId}] STAGE=AUTH_VERIFY duration=${Date.now() - verifyStartedAt}ms TRANSIENT_INFRA_FAILURE error=${error.message}`);
        throw new AuthInfrastructureError(`Supabase Auth verification temporarily unavailable: ${error.message}`);
      }
      console.log(`[auth:${correlationId}] STAGE=AUTH_VERIFY duration=${Date.now() - verifyStartedAt}ms found=false error=${error.message}`);
    } else {
      authUserId = data?.claims?.sub ?? null;
      console.log(`[auth:${correlationId}] STAGE=AUTH_VERIFY duration=${Date.now() - verifyStartedAt}ms found=${Boolean(authUserId)}`);
    }
  } catch (err) {
    if (err instanceof AuthInfrastructureError) throw err;
    console.log(`[auth:${correlationId}] STAGE=AUTH_VERIFY duration=${Date.now() - verifyStartedAt}ms THREW error=${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  if (!authUserId) {
    console.log(`[auth:${correlationId}] DONE outcome=not_authenticated totalDuration=${Date.now() - startedAt}ms`);
    return { ok: false, reason: "not_authenticated" };
  }

  const serviceClient = getServiceRoleClient();

  const appUserStartedAt = Date.now();
  const { data: appUser, error: appUserError } = await serviceClient
    .from("app_users")
    .select("id, organization_id")
    .eq("auth_user_id", authUserId)
    .eq("is_active", true)
    .maybeSingle();
  console.log(`[auth:${correlationId}] STAGE=APP_USER_LOOKUP duration=${Date.now() - appUserStartedAt}ms error=${appUserError ? appUserError.message : "none"}`);

  if (appUserError) {
    console.log(`[auth:${correlationId}] DONE outcome=THREW totalDuration=${Date.now() - startedAt}ms`);
    throw new Error(`failed to resolve app_user for auth session: ${appUserError.message}`);
  }
  if (!appUser) {
    console.log(`[auth:${correlationId}] DONE outcome=not_authorized(no app_user) totalDuration=${Date.now() - startedAt}ms`);
    return { ok: false, reason: "not_authorized" };
  }

  const roleStartedAt = Date.now();
  const { data: roleRows, error: roleError } = await serviceClient
    .from("user_roles")
    .select("roles(name)")
    .eq("app_user_id", appUser.id);
  console.log(`[auth:${correlationId}] STAGE=ROLE_LOOKUP duration=${Date.now() - roleStartedAt}ms error=${roleError ? roleError.message : "none"}`);

  if (roleError) {
    console.log(`[auth:${correlationId}] DONE outcome=THREW totalDuration=${Date.now() - startedAt}ms`);
    throw new Error(`failed to resolve roles for app_user ${appUser.id}: ${roleError.message}`);
  }

  const roles = (roleRows ?? [])
    .map((row) => (row as unknown as { roles: { name: string } | null }).roles?.name)
    .filter((name): name is string => Boolean(name));

  if (!roles.some((role) => AUTHORIZED_ROLE_NAMES.includes(role))) {
    console.log(`[auth:${correlationId}] DONE outcome=not_authorized(no manager/admin role) totalDuration=${Date.now() - startedAt}ms`);
    return { ok: false, reason: "not_authorized" };
  }

  console.log(`[auth:${correlationId}] DONE outcome=ok organizationId=${appUser.organization_id} totalDuration=${Date.now() - startedAt}ms`);
  return {
    ok: true,
    manager: {
      appUserId: appUser.id,
      organizationId: appUser.organization_id,
      authUserId,
      roles,
    },
  };
});

/**
 * Admin Foundation milestone -- every Admin route/mutation must enforce
 * this server-side (hiding the sidebar entry is not sufficient, Part 5).
 * Reuses requireManagerOrAdmin() unchanged (same auth-session resolution,
 * same deny-by-default app_user/role lookup, and now the same request-
 * scoped memoization) and adds exactly one additional check: the caller's
 * roles must include "admin" -- the role already exists in the seeded
 * roles table and is already returned by requireManagerOrAdmin(), so this
 * needs no new query of its own.
 */
export type AdminAuthResult = ManagerAuthResult;

export async function requireAdmin(): Promise<AdminAuthResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return auth;
  if (!auth.manager.roles.includes("admin")) {
    return { ok: false, reason: "not_authorized" };
  }
  return auth;
}
