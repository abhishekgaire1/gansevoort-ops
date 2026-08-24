import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI-safe: no network, no Deno/browser runtime. Proves the static Phone
 * Capture shell page (supabase/storage-assets/phone-capture/capture-
 * shell.html, deployed to Netlify by scripts/deployPhoneCaptureShellToNetlify.ts)
 * is a real, well-formed HTML document -- never JSON-stringified, never
 * missing UTF-8 -- and that it never embeds a server secret, only the
 * public placeholders a deploy substitutes with the publishable key and the
 * Supabase API base.
 *
 * Regression coverage for a real bug: after the shell moved from
 * *.supabase.co to Netlify, `functionUrl = window.location.origin + "/functions/v1/phone-capture"`
 * silently pointed every request at Netlify's own domain (where no such
 * route exists) instead of the Supabase Edge Function -- the initial
 * status call rejected with an unhandled promise, leaving the page stuck
 * on "Loading..." forever. Fixed by injecting a fixed API base at deploy
 * time and never deriving it from window.location, plus making every
 * failure path (including a network/timeout failure) explicitly transition
 * the UI away from "Loading...".
 */

const SHELL_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "../supabase/storage-assets/phone-capture/capture-shell.html"),
  "utf8"
);

describe("phone-capture shell page -- real HTML, correct charset", () => {
  it("begins with a real <!doctype html> document, not a JSON envelope", () => {
    expect(SHELL_SOURCE.trimStart().startsWith("<!doctype html>")).toBe(true);
  });

  it("declares utf-8 explicitly, never relying on browser charset guessing", () => {
    expect(SHELL_SOURCE).toMatch(/<meta charset="utf-8">/);
  });

  it("contains the real UTF-8 ellipsis/checkmark characters, not escaped/mojibake sequences", () => {
    expect(SHELL_SOURCE).toContain("Loading…");
    expect(SHELL_SOURCE).toContain("✓ Photo Sent");
    expect(SHELL_SOURCE).not.toContain("â€¦");
  });
});

describe("phone-capture shell page -- no server secret embedded", () => {
  it("contains only the placeholder for the publishable key -- never a hardcoded literal key value", () => {
    expect(SHELL_SOURCE).toContain("__PHONE_CAPTURE_PUBLISHABLE_KEY__");
    expect(SHELL_SOURCE).not.toMatch(/sb_publishable_[A-Za-z0-9_-]+/);
    expect(SHELL_SOURCE).not.toMatch(/sb_secret_/);
    expect(SHELL_SOURCE).not.toMatch(/service_role/i);
  });

  it("never bakes the capture token into the page itself -- it's read from the page's own URL at load time", () => {
    expect(SHELL_SOURCE).toMatch(/URLSearchParams\(window\.location\.search\)\.get\("token"\)/);
    expect(SHELL_SOURCE).not.toMatch(/capture-init/);
  });
});

describe("phone-capture shell page -- API base is a fixed, injected value, NEVER derived from window.location", () => {
  it("contains the API base placeholder, substituted at deploy time -- never window.location.origin/href", () => {
    expect(SHELL_SOURCE).toContain('var functionUrl = "__PHONE_CAPTURE_API_BASE__"');
  });

  it("never derives functionUrl from window.location -- the frontend (Netlify) and API (Supabase) are different origins", () => {
    expect(SHELL_SOURCE).not.toMatch(/functionUrl\s*=\s*window\.location/);
    expect(SHELL_SOURCE).not.toMatch(/window\.location\.origin\s*\+\s*"\/functions/);
    expect(SHELL_SOURCE).not.toMatch(/window\.location\.href\.split/);
  });

  it("contains the required phone-facing copy (Photograph Invoice / Take Photo / Retake / Use Photo / Photo Sent)", () => {
    expect(SHELL_SOURCE).toContain("Photograph Invoice");
    expect(SHELL_SOURCE).toContain("Take Photo");
    expect(SHELL_SOURCE).toContain("Retake");
    expect(SHELL_SOURCE).toContain("Use Photo");
    expect(SHELL_SOURCE).toContain("You can return to the computer.");
  });

  it("never shows any Receiving/Inventory/Admin business UI -- the phone stays camera-only", () => {
    for (const forbidden of ["Receiving Queue", "Inventory", "Admin", "Verify", "Post"]) {
      expect(SHELL_SOURCE).not.toContain(forbidden);
    }
  });
});

describe("phone-capture shell page -- deploy script substitutes both placeholders from public, non-secret env vars", () => {
  const DEPLOY_SCRIPT = readFileSync(path.resolve(import.meta.dirname, "../scripts/deployPhoneCaptureShellToNetlify.ts"), "utf8");

  it("substitutes the API base from SUPABASE_URL, never a hardcoded developer-specific value", () => {
    expect(DEPLOY_SCRIPT).toMatch(/requireEnv\("SUPABASE_URL"\)/);
    expect(DEPLOY_SCRIPT).toContain("/functions/v1/phone-capture");
  });

  it("substitutes the publishable key from SUPABASE_PUBLISHABLE_KEY, never the secret key", () => {
    expect(DEPLOY_SCRIPT).toMatch(/requireEnv\("SUPABASE_PUBLISHABLE_KEY"\)/);
    expect(DEPLOY_SCRIPT).not.toMatch(/SUPABASE_SECRET_KEY/);
  });
});

describe("phone-capture shell page -- no infinite Loading state", () => {
  it("the initial status call always has a .catch() -- a rejected promise can never leave the UI on Loading forever", () => {
    const loadStatusMatch = SHELL_SOURCE.match(/function loadStatus\(\)[\s\S]*?\n  }/);
    expect(loadStatusMatch).not.toBeNull();
    expect(loadStatusMatch![0]).toMatch(/\.catch\(/);
  });

  it("a network/timeout failure transitions to a distinct, actionable network-error state, never silently stays on loading", () => {
    expect(SHELL_SOURCE).toContain('showStep("network-error")');
    expect(SHELL_SOURCE).toContain("Unable to Connect to Gansevoort Ops");
  });

  it("uses an AbortController with a bounded (10-15s range) timeout on every call, not an unbounded fetch", () => {
    expect(SHELL_SOURCE).toMatch(/new AbortController\(\)/);
    expect(SHELL_SOURCE).toMatch(/signal:\s*controller\.signal/);
    const timeoutMatch = SHELL_SOURCE.match(/STATUS_TIMEOUT_MS\s*=\s*(\d+)/);
    expect(timeoutMatch).not.toBeNull();
    const timeoutMs = Number(timeoutMatch![1]);
    expect(timeoutMs).toBeGreaterThanOrEqual(10000);
    expect(timeoutMs).toBeLessThanOrEqual(15000);
  });

  it("a network-level failure is distinguished from a well-formed API response before being surfaced -- never conflates 'couldn't reach the server' with 'the server said invalid'", () => {
    expect(SHELL_SOURCE).toMatch(/networkError:\s*true/);
    expect(SHELL_SOURCE).toMatch(/contentType\.indexOf\("application\/json"\)/);
  });

  it("the network-error state has a retry button wired to reload status, so a transient failure is always recoverable without rescanning the QR", () => {
    expect(SHELL_SOURCE).toContain('id="network-retry-btn"');
    expect(SHELL_SOURCE).toMatch(/network-retry-btn"\)\.addEventListener\("click",\s*loadStatus\)/);
  });

  it("begin-upload/finish-upload go through the SAME call() helper (and therefore the same fixed API base) as the initial status check", () => {
    expect(SHELL_SOURCE).toMatch(/call\("begin-upload"/);
    expect(SHELL_SOURCE).toMatch(/call\("finish-upload"/);
  });
});
