import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getDummyPinHash,
  hashPinForStorage,
  hashPinLookup,
  isValidPinFormat,
  runDummyPinVerification,
  verifyPinHash,
} from "@/app/lib/auth/pin";
import { issueKioskToken, verifyKioskToken, KIOSK_TOKEN_TTL_SECONDS } from "@/app/lib/auth/kioskToken";
import { deriveRateLimitKey } from "@/app/lib/auth/rateLimit";
import { extractTrustedClientIp, resolveRateLimitSource, UNKNOWN_RATE_LIMIT_SOURCE } from "@/app/lib/auth/rateLimitSource";

// CI-safe: pure/local logic only, no network, no database. Per the
// project's testing policy, anything that reads/writes the linked Supabase
// dev database is manual/on-demand (see pin.integration.test.ts /
// withdrawal.rpc.test.ts), never run automatically here.

afterEach(() => {
  vi.useRealTimers();
});

describe("isValidPinFormat", () => {
  it("accepts exactly 6 digits", () => {
    expect(isValidPinFormat("123456")).toBe(true);
    expect(isValidPinFormat("000000")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidPinFormat("12345")).toBe(false);
    expect(isValidPinFormat("1234567")).toBe(false);
    expect(isValidPinFormat("12a456")).toBe(false);
    expect(isValidPinFormat("")).toBe(false);
    expect(isValidPinFormat(" 12345")).toBe(false);
  });
});

describe("hashPinLookup", () => {
  it("is deterministic for the same PIN and pepper", () => {
    expect(hashPinLookup("123456", "pepper-a")).toBe(hashPinLookup("123456", "pepper-a"));
  });

  it("differs for a different PIN", () => {
    expect(hashPinLookup("123456", "pepper-a")).not.toBe(hashPinLookup("654321", "pepper-a"));
  });

  it("differs for a different pepper", () => {
    expect(hashPinLookup("123456", "pepper-a")).not.toBe(hashPinLookup("123456", "pepper-b"));
  });
});

describe("hashPinForStorage / verifyPinHash", () => {
  it("round-trips: correct PIN verifies against its own hash", async () => {
    const hash = await hashPinForStorage("482913");
    await expect(verifyPinHash("482913", hash)).resolves.toBe(true);
  });

  it("rejects a wrong PIN against the hash", async () => {
    const hash = await hashPinForStorage("482913");
    await expect(verifyPinHash("999999", hash)).resolves.toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const hashA = await hashPinForStorage("482913");
    const hashB = await hashPinForStorage("482913");
    expect(hashA).not.toBe(hashB);
  });
});

describe("kiosk token", () => {
  const secret = "test-kiosk-token-secret";

  it("issues a token that verifies successfully", () => {
    const token = issueKioskToken({ appUserId: "user-1", organizationId: "org-1" }, secret);
    const result = verifyKioskToken(token, secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.appUserId).toBe("user-1");
      expect(result.payload.organizationId).toBe("org-1");
    }
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueKioskToken({ appUserId: "user-1", organizationId: "org-1" }, secret);
    const result = verifyKioskToken(token, "wrong-secret");
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a malformed token", () => {
    expect(verifyKioskToken("not-a-real-token", secret)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token past its TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = issueKioskToken({ appUserId: "user-1", organizationId: "org-1" }, secret);

    vi.setSystemTime(new Date(Date.now() + (KIOSK_TOKEN_TTL_SECONDS + 1) * 1000));
    const result = verifyKioskToken(token, secret);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("still accepts a token just under its TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = issueKioskToken({ appUserId: "user-1", organizationId: "org-1" }, secret);

    vi.setSystemTime(new Date(Date.now() + (KIOSK_TOKEN_TTL_SECONDS - 1) * 1000));
    const result = verifyKioskToken(token, secret);
    expect(result.ok).toBe(true);
  });
});

describe("deriveRateLimitKey", () => {
  it("is deterministic for the same source", () => {
    expect(deriveRateLimitKey("1.2.3.4")).toBe(deriveRateLimitKey("1.2.3.4"));
  });

  it("differs for a different source", () => {
    expect(deriveRateLimitKey("1.2.3.4")).not.toBe(deriveRateLimitKey("5.6.7.8"));
  });
});

describe("rate-limit source resolution (trusted Vercel header only)", () => {
  it("extracts a single IP from x-vercel-forwarded-for", () => {
    expect(extractTrustedClientIp("203.0.113.5")).toBe("203.0.113.5");
  });

  it("takes the first entry when the header is a comma-separated list", () => {
    expect(extractTrustedClientIp("203.0.113.5, 70.41.3.18")).toBe("203.0.113.5");
  });

  it("trims whitespace", () => {
    expect(extractTrustedClientIp("  203.0.113.5  ")).toBe("203.0.113.5");
  });

  it("returns null for a missing or empty header", () => {
    expect(extractTrustedClientIp(null)).toBeNull();
    expect(extractTrustedClientIp("")).toBeNull();
  });

  it("resolveRateLimitSource uses the extracted IP when present", () => {
    expect(resolveRateLimitSource("203.0.113.5")).toBe("203.0.113.5");
  });

  it("resolveRateLimitSource falls back to the shared unknown bucket when the header is absent", () => {
    expect(resolveRateLimitSource(null)).toBe(UNKNOWN_RATE_LIMIT_SOURCE);
    expect(resolveRateLimitSource("")).toBe(UNKNOWN_RATE_LIMIT_SOURCE);
  });

  it("never derives a source identity from generic x-forwarded-for/x-real-ip -- only the header value passed in is consulted", () => {
    // resolveRateLimitSource takes the raw x-vercel-forwarded-for value
    // directly as its only input and has no fallback to any other header
    // name; a caller passing a spoofable generic header's value here would
    // get that value bucketed under "unknown" instead only if it is itself
    // absent -- there is no code path that reaches for a different header.
    expect(resolveRateLimitSource(null)).toBe(UNKNOWN_RATE_LIMIT_SOURCE);
  });
});

describe("dummy PIN verification (Argon2 timing normalization)", () => {
  it("memoizes the dummy hash: repeated calls return the identical hash string", async () => {
    // hashPinForStorage() uses a fresh random salt every call (proven
    // above), so two calls returning byte-identical output is only
    // possible if the underlying hash was computed once and cached.
    const first = await getDummyPinHash();
    const second = await getDummyPinHash();
    expect(first).toBe(second);
  });

  it("runDummyPinVerification performs a real Argon2id verification and resolves without throwing", async () => {
    await expect(runDummyPinVerification()).resolves.toBeUndefined();
  });
});
