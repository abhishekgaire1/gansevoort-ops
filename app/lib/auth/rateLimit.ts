import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Layered, DB-backed rate limiting for PIN verification (approved-plan
 * §8). A four-digit PIN space (10,000 values) needs meaningfully tighter
 * protection than the six-digit design's single 20-per-5-minutes-per-
 * source-IP limiter -- this module replaces that with THREE independent
 * FAILED-ATTEMPT security scopes plus one separate ALL-ATTEMPTS CPU/
 * volume throttle, backed by pin_verify_rate_limits (20260811100118
 * generalizes the existing table with a `scope` column rather than
 * duplicating it four times).
 *
 * ============================================================
 * FAILED-ATTEMPT SECURITY SCOPES vs. THE CPU/ALL-ATTEMPTS THROTTLE
 * ============================================================
 * These are deliberately two different mechanisms, never conflated:
 *
 *  - device/ip/org (this module's *_FAILURE constants) count ONLY failed
 *    PIN attempts. A successful login never calls
 *    registerPinFailureAcrossScopes at all (so it never increments any of
 *    them), and on success the DEVICE scope's current window is
 *    explicitly reset (resetDeviceScopeOnSuccess below) -- the wrong-PIN
 *    mistakes a single employee made moments before logging in
 *    successfully don't linger against them. The IP and ORG scopes are
 *    NEVER reset on success (nothing here ever touches them for a
 *    "success" outcome) -- a distributed attacker who eventually guesses
 *    a real PIN once must never erase the organization-wide evidence of
 *    every failure that came before it.
 *
 *  - ip_all_attempts (CPU_THROTTLE_* constants) counts EVERY attempt,
 *    success or failure, keyed by source IP. Its only job is bounding
 *    total Argon2/CPU work from one network -- it is intentionally much
 *    higher-volume than the security scopes so that many real kiosks on
 *    one shared public IP, all logging in successfully throughout a
 *    shift, are never blocked by it in ordinary operation.
 *
 * ============================================================
 * RESOLVING AN APPARENT CONTRADICTION: "the CPU throttle counts every
 * attempt" vs. "successful attempts never consume quota"
 * ============================================================
 * Both are true, about TWO DIFFERENT quotas:
 *   - A successful PIN verification DOES consume one point of the
 *     ip_all_attempts CPU-throttle quota -- that quota's entire job is
 *     bounding total compute from one source, which a success spent
 *     exactly as much of as a failure did (one Argon2 verification
 *     either way). It is never reset by a success.
 *   - A successful PIN verification NEVER consumes the device/ip/org
 *     FAILURE quotas -- those exist only to bound wrong-PIN guessing,
 *     and a success is definitionally not a wrong guess.
 * The two are backed by the same table/RPCs but are independent counters
 * (different `scope` values, different rate_limit_key hashes -- see
 * deriveRateLimitKey below), so consuming one has no effect on the other.
 *
 * ============================================================
 * WHAT IS, AND IS NOT, PROVABLY ATOMIC HERE
 * ============================================================
 * The COUNTER INCREMENT ITSELF (increment_pin_rate_limit's / this
 * module's registerPinVerificationFailure's single
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement) is fully
 * atomic and race-free under Postgres's own MVCC/row-locking guarantees --
 * no concurrent caller can ever lose an update or read a torn value. The
 * ip_all_attempts CPU throttle (checkAndIncrementCpuThrottle) uses ONLY
 * this atomic increment, with no separate read step, so it is atomic
 * end-to-end: "check and increment" are the same single database
 * round-trip, and a parallel flood of requests is counted exactly, with
 * no possibility of more than the true number of requests being admitted
 * before the ceiling trips.
 *
 * The device/ip/org FAILURE scopes now use exactly the same pattern (see
 * registerPinVerificationFailure / register_pin_verification_failure,
 * 20260811100118 §5). A prior design (checkPinRateLimits, now removed)
 * read the current count BEFORE verification, separately from a LATER
 * increment once the outcome was known -- that two-step "check, then act"
 * was genuinely non-atomic: concurrent requests could all read the same
 * stale count and all be admitted before any of their increments landed.
 * This was previously believed to be "bounded, not unlimited" because
 * every request also passes through the separately-atomic
 * ip_all_attempts CPU throttle first -- but that throttle is keyed PER
 * SOURCE IP, so it does not bound a DISTRIBUTED attack spread across many
 * IPs at all: each IP gets its own unexhausted CPU budget, so the ORG
 * scope (shared by every request in an organization regardless of source
 * IP) had no database-enforced bound under concurrent, multi-IP failures.
 * The fix collapses "read current count" and "increment on failure" into
 * ONE atomic statement that also returns whether the just-incremented
 * count is still within the ceiling -- since increment and comparison
 * happen against the SAME value from the SAME statement, and Postgres
 * serializes concurrent ON CONFLICT DO UPDATE writes to the same row, at
 * most exactly the configured maximum number of callers can ever observe
 * "permitted" for a given scope/key/window, regardless of source IP or
 * device diversity.
 */

export const WINDOW_SECONDS_DEVICE = 300; // 5 minutes
export const MAX_FAILURES_DEVICE = 5;

export const WINDOW_SECONDS_IP = 900; // 15 minutes
export const MAX_FAILURES_IP = 20;

export const WINDOW_SECONDS_ORG = 3600; // 60 minutes
export const MAX_FAILURES_ORG = 50;

// Deliberately higher-volume and a SEPARATE mechanism from the three
// failure scopes above -- see this module's own doc comment.
export const WINDOW_SECONDS_CPU_THROTTLE = 300; // 5 minutes
export const MAX_ATTEMPTS_CPU_THROTTLE = 100;

export type PinRateLimitScope = "device" | "ip" | "org" | "ip_all_attempts";

/** Opaque, server-derived identifier for a request source (a device id, a
 * hashed source IP, or an organization id). Never client-supplied
 * directly -- callers always resolve the raw input from a trusted source
 * first (deviceId.ts, rateLimitSource.ts, kioskOrg.ts).
 *
 * `scope` is hashed IN, not appended alongside it -- this is what
 * guarantees two different scopes can never collide on the same
 * rate_limit_key value for the same raw identifier (e.g. a source IP
 * used for both the "ip" failure scope and the separate "ip_all_attempts"
 * CPU throttle must never land on the same counter row). This is load-
 * bearing: pin_verify_rate_limits' primary key deliberately does NOT
 * include `scope` (see 20260811100118's own comment on why), so
 * collision-freedom across scopes depends entirely on every caller
 * routing through this one function rather than hashing a raw identifier
 * directly. The scope parameter is required (not optional/defaulted) so
 * this cannot be accidentally bypassed. */
export function deriveRateLimitKey(scope: PinRateLimitScope, sourceIdentifier: string): string {
  return crypto.createHash("sha256").update(`${scope}:${sourceIdentifier}`).digest("hex");
}

/** Mirrors increment_pin_rate_limit's own bucketing formula exactly, so a
 * plain read here always lands on the SAME window row the RPC would
 * write to. */
function computeWindowStartIso(windowSeconds: number): string {
  const bucketSeconds = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  return new Date(bucketSeconds * 1000).toISOString();
}

/** Read-only: the current window's attempt count for one (organization,
 * scope, key), or 0 if no row exists yet. Never mutates -- used only for
 * the pre-verification "is this scope already exhausted" check. */
export async function getCurrentPinRateLimitCount(
  supabase: SupabaseClient,
  organizationId: string,
  scope: PinRateLimitScope,
  rateLimitKey: string,
  windowSeconds: number
): Promise<number> {
  const windowStart = computeWindowStartIso(windowSeconds);
  const { data, error } = await supabase
    .from("pin_verify_rate_limits")
    .select("attempt_count")
    .eq("organization_id", organizationId)
    .eq("scope", scope)
    .eq("rate_limit_key", rateLimitKey)
    .eq("window_start", windowStart)
    .maybeSingle();

  if (error) {
    throw new Error(`pin rate limit read failed: ${error.message}`);
  }
  return (data?.attempt_count as number | undefined) ?? 0;
}

/** Atomic check-and-increment for one (organization, scope, key, window)
 * -- race-free regardless of concurrency (see increment_pin_rate_limit's
 * own comment, 20260811100009/20260811100118). Returns the new count. */
export async function incrementPinRateLimit(
  supabase: SupabaseClient,
  organizationId: string,
  scope: PinRateLimitScope,
  rateLimitKey: string,
  windowSeconds: number
): Promise<number> {
  const { data, error } = await supabase.rpc("increment_pin_rate_limit", {
    p_organization_id: organizationId,
    p_rate_limit_key: rateLimitKey,
    p_window_seconds: windowSeconds,
    p_scope: scope,
  });

  if (error) {
    throw new Error(`pin rate limit increment failed: ${error.message}`);
  }
  return data as number;
}

/** Clears one scope's CURRENT window counter. Callers must only ever pass
 * scope: "device" -- resetting "ip" or "org" here would erase
 * organization-wide attack evidence on a single success, which the
 * approved plan explicitly forbids. Enforced by convention/review, not by
 * this function's own type (the underlying RPC is intentionally generic;
 * see its own comment) -- resetDeviceScopeOnSuccess below is the ONLY
 * caller and is deliberately the one place this rule must be honored. */
async function resetPinRateLimitScope(
  supabase: SupabaseClient,
  organizationId: string,
  scope: PinRateLimitScope,
  rateLimitKey: string,
  windowSeconds: number
): Promise<void> {
  const { error } = await supabase.rpc("reset_pin_rate_limit_scope", {
    p_organization_id: organizationId,
    p_scope: scope,
    p_rate_limit_key: rateLimitKey,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    throw new Error(`pin rate limit reset failed: ${error.message}`);
  }
}

export interface PinRateLimitKeys {
  deviceKey: string;
  ipKey: string;
  orgKey: string;
}

export type PinRateLimitCheckResult = { allowed: true } | { allowed: false };

/** Atomic "reserve a failure slot and report whether it's still permitted"
 * for ONE scope -- see register_pin_verification_failure's own comment
 * (20260811100118 §5) for why this single INSERT ... ON CONFLICT
 * DO UPDATE ... RETURNING statement is race-free even under many
 * concurrent callers sharing the same key (e.g. every request in an
 * organization sharing the same org key, regardless of source IP). */
async function registerPinVerificationFailure(
  supabase: SupabaseClient,
  organizationId: string,
  scope: PinRateLimitScope,
  rateLimitKey: string,
  windowSeconds: number,
  maxAttempts: number
): Promise<{ attemptCount: number; permitted: boolean }> {
  const { data, error } = await supabase.rpc("register_pin_verification_failure", {
    p_organization_id: organizationId,
    p_scope: scope,
    p_rate_limit_key: rateLimitKey,
    p_window_seconds: windowSeconds,
    p_max_attempts: maxAttempts,
  });

  if (error) {
    throw new Error(`pin failure registration failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { out_attempt_count: number; out_permitted: boolean };
  return { attemptCount: row.out_attempt_count, permitted: row.out_permitted };
}

/** Atomically registers a FAILED verification attempt across all three
 * failed-attempt scopes at once (one authoritative database round trip
 * per scope, each individually race-free) and reports whether the request
 * remains permitted -- i.e. whether every scope is still at or under its
 * own ceiling after this failure was counted. Callers must gate any
 * further Argon2 work (dummy or real) on `allowed` being true. Never call
 * this for a successful verification -- a success must not consume any of
 * these three quotas at all (see this module's own doc comment); the
 * caller simply never invokes this function on the success path. */
export async function registerPinFailureAcrossScopes(
  supabase: SupabaseClient,
  organizationId: string,
  keys: PinRateLimitKeys
): Promise<PinRateLimitCheckResult> {
  const [device, ip, org] = await Promise.all([
    registerPinVerificationFailure(supabase, organizationId, "device", keys.deviceKey, WINDOW_SECONDS_DEVICE, MAX_FAILURES_DEVICE),
    registerPinVerificationFailure(supabase, organizationId, "ip", keys.ipKey, WINDOW_SECONDS_IP, MAX_FAILURES_IP),
    registerPinVerificationFailure(supabase, organizationId, "org", keys.orgKey, WINDOW_SECONDS_ORG, MAX_FAILURES_ORG),
  ]);

  return device.permitted && ip.permitted && org.permitted ? { allowed: true } : { allowed: false };
}

/** Resets ONLY the device scope's current window -- called once a
 * verification attempt SUCCEEDS. IP/org are deliberately never reset here
 * (see this module's own doc comment): a distributed attacker who
 * eventually guesses a real PIN must never erase the organization-wide
 * evidence of every failure that came before it. A success never calls
 * registerPinFailureAcrossScopes at all, so it never consumes any of the
 * three failure quotas in the first place -- there is nothing to "undo". */
export async function resetDeviceScopeOnSuccess(supabase: SupabaseClient, organizationId: string, deviceKey: string): Promise<void> {
  await resetPinRateLimitScope(supabase, organizationId, "device", deviceKey, WINDOW_SECONDS_DEVICE);
}

/** The separate, higher-volume all-attempts CPU/compute throttle (see
 * this module's own doc comment) -- counts every call regardless of
 * outcome, keyed by source IP. Returns false once the ceiling for this
 * window is exceeded. */
export async function checkAndIncrementCpuThrottle(supabase: SupabaseClient, organizationId: string, ipKey: string): Promise<PinRateLimitCheckResult> {
  const count = await incrementPinRateLimit(supabase, organizationId, "ip_all_attempts", ipKey, WINDOW_SECONDS_CPU_THROTTLE);
  return count <= MAX_ATTEMPTS_CPU_THROTTLE ? { allowed: true } : { allowed: false };
}

export interface OrgPinRateLimitStatus {
  attemptCount: number;
  isLockedOut: boolean;
  windowExpiresAt: string;
}

/** Manager/admin-facing, read-only status for the ORG failed-attempt
 * scope only -- the one scope that can lock out an entire organization's
 * kiosks regardless of which device/IP is used. Deliberately reports only
 * a count/boolean/timestamp -- never the underlying rate_limit_key, any
 * source IP, or any employee/PIN data (see get_org_pin_rate_limit_status's
 * own comment, 20260811100118 §6). */
export async function getOrgPinRateLimitStatus(supabase: SupabaseClient, organizationId: string): Promise<OrgPinRateLimitStatus> {
  const orgKey = deriveRateLimitKey("org", organizationId);
  const { data, error } = await supabase.rpc("get_org_pin_rate_limit_status", {
    p_organization_id: organizationId,
    p_rate_limit_key: orgKey,
    p_window_seconds: WINDOW_SECONDS_ORG,
    p_max_attempts: MAX_FAILURES_ORG,
  });
  if (error) {
    throw new Error(`pin rate limit status read failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    out_attempt_count: number;
    out_is_locked_out: boolean;
    out_window_expires_at: string;
  };
  return { attemptCount: row.out_attempt_count, isLockedOut: row.out_is_locked_out, windowExpiresAt: row.out_window_expires_at };
}

/** Manager/admin-facing recovery action: clears every PIN rate-limit
 * record (all four scopes) for ONE organization, resolved from the
 * caller's own trusted server session -- never client-supplied. Restores
 * kiosk login ATTEMPTS only; never reads, writes, or references any
 * app_users PIN/hash/kiosk-token data. Writes exactly one audit event
 * (see unlock_org_pin_rate_limits's own comment). */
export async function unlockOrgPinRateLimits(supabase: SupabaseClient, organizationId: string, actorAppUserId: string): Promise<void> {
  const { error } = await supabase.rpc("unlock_org_pin_rate_limits", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
  });
  if (error) {
    throw new Error(`pin rate limit unlock failed: ${error.message}`);
  }
}
