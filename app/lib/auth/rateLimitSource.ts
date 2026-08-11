/**
 * Trusted client-IP resolution for PIN-verification rate limiting.
 *
 * Deliberately narrow: only Vercel's platform-set x-vercel-forwarded-for is
 * trusted. Vercel's edge network sets/overwrites this header to the actual
 * client IP; a client cannot spoof it the way it can a generic
 * x-forwarded-for or x-real-ip, which may pass through an attacker-supplied
 * value untouched depending on the proxy chain -- those are intentionally
 * NOT consulted here.
 *
 * If the trusted header is absent, callers fall back to a fixed, shared
 * UNKNOWN_RATE_LIMIT_SOURCE bucket rather than trusting any
 * browser-suppliable header. Grouping every "we don't know the source"
 * request into one shared bucket means omitting/stripping the header can't
 * be used to mint a fresh rate-limit budget per request.
 *
 * Kept as a single, narrow module so a future registered kiosk/device
 * identifier can replace or augment IP-based resolution without touching
 * any other call site.
 */

export const UNKNOWN_RATE_LIMIT_SOURCE = "unknown";

/** Parses the raw x-vercel-forwarded-for header value into a single
 * normalized client IP, or null if it's missing/empty. */
export function extractTrustedClientIp(vercelForwardedForHeader: string | null): string | null {
  if (!vercelForwardedForHeader) {
    return null;
  }
  const [firstIp] = vercelForwardedForHeader.split(",");
  const normalized = firstIp?.trim();
  return normalized ? normalized : null;
}

/** The identifier to feed into deriveRateLimitKey() -- never the raw IP
 * itself is persisted anywhere; this is only the pre-hash input. */
export function resolveRateLimitSource(vercelForwardedForHeader: string | null): string {
  return extractTrustedClientIp(vercelForwardedForHeader) ?? UNKNOWN_RATE_LIMIT_SOURCE;
}
