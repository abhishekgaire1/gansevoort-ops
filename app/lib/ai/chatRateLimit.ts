import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ask Gansevoort rate limiting -- reuses the EXISTING durable,
 * server-authoritative, multi-instance-safe counter
 * (pin_verify_rate_limits / increment_pin_rate_limit, 20260811100009)
 * rather than adding a new migration, per this feature's explicit
 * instruction to "prefer an existing durable limiter over a new
 * migration."
 *
 * That table's SCHEMA is generic -- (organization_id, an opaque
 * rate_limit_key text, window_start, attempt_count) -- nothing in its
 * columns is PIN-specific; only its original doc comment and name were
 * scoped to PIN verification. This reuse is a deliberate, documented
 * judgment call: a distinct key NAMESPACE ("askg:user:"/"askg:org:",
 * never overlapping with PIN's own IP-hash keys) keeps the two features'
 * counters fully independent within the same physical table, with zero
 * schema change. An in-memory counter would not be authoritative across
 * Vercel's multiple serverless instances, which is exactly why this table
 * exists in the first place.
 *
 * Identity is always the authenticated appUserId/organizationId already
 * resolved by requireManagerOrAdmin() -- never a client-supplied user id,
 * organization id, or IP header.
 */

const USER_WINDOW_SECONDS = 300;
const USER_MAX_PER_WINDOW = 10;
const ORG_WINDOW_SECONDS = 300;
const ORG_MAX_PER_WINDOW = 40;

export type AskGansevoortRateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function secondsRemainingInWindow(windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000;
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  return Math.max(1, Math.ceil(windowStart + windowSeconds - nowSeconds));
}

async function incrementCounter(supabase: SupabaseClient, organizationId: string, rateLimitKey: string, windowSeconds: number): Promise<number> {
  const { data, error } = await supabase.rpc("increment_pin_rate_limit", {
    p_organization_id: organizationId,
    p_rate_limit_key: rateLimitKey,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    throw new Error(`ask-gansevoort rate limit check failed: ${error.message}`);
  }
  return data as number;
}

export async function checkAskGansevoortRateLimit(supabase: SupabaseClient, organizationId: string, appUserId: string): Promise<AskGansevoortRateLimitResult> {
  const [userCount, orgCount] = await Promise.all([
    incrementCounter(supabase, organizationId, `askg:user:${appUserId}`, USER_WINDOW_SECONDS),
    incrementCounter(supabase, organizationId, `askg:org:${organizationId}`, ORG_WINDOW_SECONDS),
  ]);

  if (userCount > USER_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: secondsRemainingInWindow(USER_WINDOW_SECONDS) };
  }
  if (orgCount > ORG_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: secondsRemainingInWindow(ORG_WINDOW_SECONDS) };
  }
  return { allowed: true };
}
