import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI-safe: no network. Regression guard for a real incident: an earlier
 * version of this script ran `netlify deploy` with this repo as its
 * working directory, and the Netlify CLI auto-detects a framework
 * (Next.js, etc.) from its OWN process.cwd() regardless of --dir -- it
 * silently built and deployed the ENTIRE Gansevoort Manager app (Receiving,
 * Admin, Inventory, a bundled server-functions handler) to a public
 * Netlify site. Caught immediately and torn down, but the fix must never
 * silently regress: the deploy MUST run with its cwd pointed at an empty
 * staging directory containing nothing but the one static file, with
 * --no-build as defense in depth.
 */

const SCRIPT_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../scripts/deployPhoneCaptureShellToNetlify.ts"), "utf8");

describe("deployPhoneCaptureShellToNetlify.ts -- never deploys this repo itself", () => {
  it("invokes the netlify CLI with cwd set to the isolated staging directory, never the repo root", () => {
    const execCallMatch = SCRIPT_SOURCE.match(/execFileSync\([\s\S]*?\)/);
    expect(execCallMatch).not.toBeNull();
    expect(execCallMatch![0]).toMatch(/cwd:\s*stagingDir/);
  });

  it("passes --no-build as defense in depth, even with cwd isolation already in place", () => {
    expect(SCRIPT_SOURCE).toMatch(/"--no-build"/);
  });

  it("the staging directory contains nothing but the one substituted index.html -- no package.json/next.config that could be auto-detected", () => {
    const stagingSetup = SCRIPT_SOURCE.match(/mkdtempSync[\s\S]*?writeFileSync\([^)]*\)/);
    expect(stagingSetup).not.toBeNull();
    expect(stagingSetup![0]).toContain("index.html");
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*package\.json/);
  });

  it("the staging directory is always cleaned up after the deploy call", () => {
    expect(SCRIPT_SOURCE).toMatch(/rmSync\(stagingDir/);
  });
});
