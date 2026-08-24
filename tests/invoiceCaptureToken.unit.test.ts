import { describe, expect, it } from "vitest";
import { generateCaptureToken, hashCaptureToken, isPlausibleCaptureToken } from "@/app/lib/invoiceCapture/token";

// CI-safe: no network, no database. Proves the phone's ONLY credential
// (Part 5-7/30 of the Phone-to-Desktop Invoice Capture spec) is
// cryptographically random, never persisted in raw form, and that the
// cheap structural pre-check can't be satisfied by a guessable/short value.

describe("generateCaptureToken", () => {
  it("returns a base64url token distinct from its digest", () => {
    const { token, digest } = generateCaptureToken();
    expect(token).not.toBe(digest);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a digest equal to hashCaptureToken(token) -- the two never drift apart", () => {
    const { token, digest } = generateCaptureToken();
    expect(hashCaptureToken(token)).toBe(digest);
  });

  it("never repeats across calls (256 bits of CSPRNG entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { token } = generateCaptureToken();
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  it("always satisfies isPlausibleCaptureToken -- the generator and the validator agree on shape", () => {
    for (let i = 0; i < 20; i++) {
      const { token } = generateCaptureToken();
      expect(isPlausibleCaptureToken(token)).toBe(true);
    }
  });
});

describe("hashCaptureToken", () => {
  it("is deterministic -- the same raw token always hashes to the same digest", () => {
    const token = "abcDEF123_-abcDEF123abcDEF123abcDEF123abc";
    expect(hashCaptureToken(token)).toBe(hashCaptureToken(token));
  });

  it("produces a 64-character lowercase hex SHA-256 digest", () => {
    const digest = hashCaptureToken("abcDEF123_-abcDEF123abcDEF123abcDEF123abc");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a single-character difference in the token produces a completely different digest", () => {
    const a = hashCaptureToken("abcDEF123_-abcDEF123abcDEF123abcDEF123abc");
    const b = hashCaptureToken("abcDEF123_-abcDEF123abcDEF123abcDEF123abD");
    expect(a).not.toBe(b);
  });
});

describe("isPlausibleCaptureToken", () => {
  it("accepts a realistic 43-character base64url token (32 bytes, no padding)", () => {
    expect(isPlausibleCaptureToken("A".repeat(43))).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isPlausibleCaptureToken("")).toBe(false);
  });

  it("rejects a too-short guess (e.g. a short PIN-like value)", () => {
    expect(isPlausibleCaptureToken("123456")).toBe(false);
  });

  it("rejects a too-long value", () => {
    expect(isPlausibleCaptureToken("A".repeat(51))).toBe(false);
  });

  it("rejects values containing characters outside the base64url alphabet", () => {
    expect(isPlausibleCaptureToken("A".repeat(42) + "!")).toBe(false);
    expect(isPlausibleCaptureToken("A".repeat(42) + "/")).toBe(false);
    expect(isPlausibleCaptureToken("A".repeat(42) + "+")).toBe(false);
  });

  it("rejects a SQL-injection-shaped or path-traversal-shaped string", () => {
    expect(isPlausibleCaptureToken("' OR 1=1 --")).toBe(false);
    expect(isPlausibleCaptureToken("../../../etc/passwd")).toBe(false);
  });
});
