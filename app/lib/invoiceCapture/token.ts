import "server-only";
import { randomBytes, createHash } from "node:crypto";

/**
 * Phone-to-Desktop Invoice Capture milestone -- the capture token is the
 * ONLY credential a phone browser ever holds (Part 5-7/30). 256 bits of
 * cryptographically random entropy (node:crypto's CSPRNG, not Math.random),
 * base64url-encoded so it's compact and URL-safe for the QR payload.
 *
 * The raw token is NEVER persisted (Part 7) -- only its SHA-256 digest,
 * looked up by exact equality against a unique-indexed column. This is
 * intentionally not a hand-rolled constant-time string comparison: with
 * 256 bits of entropy hashed before storage, a timing side-channel on the
 * digest lookup itself gives an attacker no practical path to the
 * original token (there is nothing to iteratively narrow down -- unlike,
 * say, a short PIN). A Postgres unique-index equality lookup is the
 * appropriate mechanism here, matching how every other credential-shaped
 * lookup in this schema already works (e.g. vendor/category duplicate
 * checks), not a novel security primitive.
 */

const TOKEN_BYTES = 32; // 256 bits
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,50}$/; // base64url of 32 bytes is 43 chars, no padding

export interface GeneratedCaptureToken {
  /** The raw bearer token -- goes into the QR URL only, never stored. */
  token: string;
  /** SHA-256 hex digest -- what actually gets persisted/looked up. */
  digest: string;
}

export function generateCaptureToken(): GeneratedCaptureToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, digest: hashCaptureToken(token) };
}

export function hashCaptureToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Fails fast on an obviously malformed token (wrong shape/length) before
 * ever touching the database -- a cheap, structural check, not a security
 * boundary by itself (the real boundary is the digest lookup finding no
 * matching row). */
export function isPlausibleCaptureToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
