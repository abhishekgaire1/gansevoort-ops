import crypto from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

/**
 * Pure PIN hashing/verification helpers. Deliberately framework-agnostic
 * (no Supabase client, no env var reads, no "server-only" marker) so they
 * can be unit tested directly under plain Node/Vitest with no database and
 * no special module resolution. Secrets (the HMAC pepper) are always passed
 * in by the caller, never read from process.env here -- that boundary
 * belongs to the Server Action layer.
 *
 * Argon2id (not native argon2) because this app targets Vercel/serverless,
 * where native N-API bindings cannot load.
 */

const PIN_PATTERN = /^\d{4}$/;

export function isValidPinFormat(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

/** HMAC-SHA256(pin, pepper), hex-encoded. Used only to look up which
 * app_user row a typed PIN might belong to -- never for verification. */
export function hashPinLookup(pin: string, pepper: string): string {
  return crypto.createHmac("sha256", pepper).update(pin).digest("hex");
}

// OWASP-baseline argon2id parameters. Not env-configurable: no operational
// need to tune per-environment yet, and hardcoding avoids a misconfigured
// deployment silently weakening the hash.
const ARGON2ID_PARALLELISM = 1;
const ARGON2ID_ITERATIONS = 3;
const ARGON2ID_MEMORY_SIZE_KIB = 19456; // ~19 MiB
const ARGON2ID_HASH_LENGTH = 32;
const ARGON2ID_SALT_LENGTH = 16;

/** Argon2id hash of the PIN with a fresh random salt. This is the value
 * stored in app_users.pin_hash and is what verification checks against. */
export async function hashPinForStorage(pin: string): Promise<string> {
  const salt = crypto.randomBytes(ARGON2ID_SALT_LENGTH);
  return argon2id({
    password: pin,
    salt,
    parallelism: ARGON2ID_PARALLELISM,
    iterations: ARGON2ID_ITERATIONS,
    memorySize: ARGON2ID_MEMORY_SIZE_KIB,
    hashLength: ARGON2ID_HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifyPinHash(pin: string, pinHash: string): Promise<boolean> {
  return argon2Verify({ password: pin, hash: pinHash });
}

// Fixed input for the precomputed dummy hash below -- its value is
// arbitrary and never a real credential; what matters is that it's stable.
const DUMMY_PIN_FOR_TIMING = "0000";

// Computed once, lazily, on first use, and cached for the life of the
// process -- never regenerated per request. Generating a fresh dummy hash
// per request would itself be the expensive operation timing-normalization
// is trying to keep off the "no match" path, so it must be precomputed
// exactly once, not on demand per call.
let dummyHashPromise: Promise<string> | null = null;

/** Exposed (not just internal) so tests can verify memoization directly by
 * value: since hashPinForStorage() never produces the same output twice for
 * the same input (fresh random salt every call), two calls returning an
 * identical string is only possible if the underlying hash was computed
 * once and cached. */
export function getDummyPinHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPinForStorage(DUMMY_PIN_FOR_TIMING);
  }
  return dummyHashPromise;
}

/**
 * Runs a real Argon2id verification against a precomputed dummy hash, so
 * that the "no matching PIN" code path in verifyPinCore costs comparable
 * time to the real-verification path, instead of returning immediately and
 * leaking that no match was found through response latency.
 *
 * The boolean result is meaningless (it will always be true, since the
 * dummy hash was derived from this same fixed PIN) and MUST NOT be used
 * for any decision -- callers only await this for its timing cost, then
 * return their own predetermined result.
 */
export async function runDummyPinVerification(): Promise<void> {
  const dummyHash = await getDummyPinHash();
  await verifyPinHash(DUMMY_PIN_FOR_TIMING, dummyHash);
}
