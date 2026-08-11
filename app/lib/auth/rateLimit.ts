import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side rate limiting for PIN verification attempts, in front of the
 * app_users.failed_pin_attempts counter. That counter alone can't blunt
 * brute-forcing the 6-digit PIN space itself, because a guessed PIN that
 * matches no employee has no app_users row to attach a counter to. Backed
 * by the pin_verify_rate_limits table (serverless deployment rules out an
 * in-memory limiter). Takes an already-authenticated service-role
 * SupabaseClient as a parameter rather than constructing its own -- keeps
 * this module framework-agnostic and directly testable.
 */

const WINDOW_SECONDS = 300;
const MAX_ATTEMPTS_PER_WINDOW = 20;

/** Opaque, server-derived identifier for a request source (e.g. a hashed
 * source IP). Never client-supplied. Scoping by source (not just
 * organization) means one bad source can't lock out an entire org. */
export function deriveRateLimitKey(sourceIdentifier: string): string {
  return crypto.createHash("sha256").update(sourceIdentifier).digest("hex");
}

export type PinRateLimitResult = { allowed: true } | { allowed: false };

export async function checkAndIncrementPinRateLimit(
  supabase: SupabaseClient,
  organizationId: string,
  rateLimitKey: string
): Promise<PinRateLimitResult> {
  const { data, error } = await supabase.rpc("increment_pin_rate_limit", {
    p_organization_id: organizationId,
    p_rate_limit_key: rateLimitKey,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (error) {
    throw new Error(`pin rate limit check failed: ${error.message}`);
  }

  const attemptCount = data as number;
  return attemptCount <= MAX_ATTEMPTS_PER_WINDOW ? { allowed: true } : { allowed: false };
}
