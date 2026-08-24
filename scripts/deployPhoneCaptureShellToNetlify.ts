import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Deploys the Phone Capture static shell page (the phone's entire camera
 * UI) to Netlify as a standalone static site, separate from this Next.js
 * app and from Supabase.
 *
 * Why this exists, and why NOT on Supabase: both the phone-capture Edge
 * Function's own GET route and a public Supabase Storage object were tried
 * and confirmed (by inspecting response headers via the AUTHENTICATED,
 * non-cached Storage endpoint, and by testing an alternate
 * application/xhtml+xml content-type) to be rewritten to text/plain with a
 * sandboxed CSP -- a platform-wide anti-phishing policy Cloudflare applies
 * in front of the entire *.supabase.co domain, not something fixable by
 * response headers. Supabase's own documented fix is a custom domain; this
 * script implements the alternative the user chose instead: host the
 * inert HTML/JS shell (zero secrets beyond the already-public publishable
 * key, zero business logic) on Netlify, while every real operation
 * (token validation, signed uploads, RPCs) stays exactly on the existing
 * supabase/functions/phone-capture Edge Function, called via a genuinely
 * cross-origin fetch() -- the Edge Function's CORS is scoped to this one
 * known frontend origin (see ALLOWED_FRONTEND_ORIGIN in that function).
 * Frontend (Netlify) and backend API (Supabase) are deliberately two
 * separate, fixed URLs -- see apiBase below -- never derived from each
 * other or from window.location.
 *
 * Re-runnable any time the shell page's source changes. Requires the
 * Netlify CLI to already be authenticated (`netlify login`, done
 * interactively once by a human -- this script never handles credentials
 * itself). Requires `NETLIFY_SITE_ID` in .env.local after the first run
 * (printed by this script) so subsequent runs update the SAME site instead
 * of creating a new one each time.
 *
 * Run manually: `npx tsx scripts/deployPhoneCaptureShellToNetlify.ts`.
 */

const SOURCE_FILE = "supabase/storage-assets/phone-capture/capture-shell.html";
const PUBLISHABLE_KEY_PLACEHOLDER = "__PHONE_CAPTURE_PUBLISHABLE_KEY__";
const API_BASE_PLACEHOLDER = "__PHONE_CAPTURE_API_BASE__";
const SITE_NAME = "gansevoort-ops-phone-capture";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function substitutePlaceholder(template: string, placeholder: string, value: string): string {
  if (!template.includes(placeholder)) {
    throw new Error(`${SOURCE_FILE} no longer contains the expected placeholder "${placeholder}" -- refusing to deploy unsubstituted content.`);
  }
  return template.split(placeholder).join(value);
}

async function main() {
  const publishableKey = requireEnv("SUPABASE_PUBLISHABLE_KEY");
  // The frontend (Netlify) and backend API (Supabase) are different
  // origins -- the shell's JS must never derive its API base from
  // window.location (a real regression: after moving off *.supabase.co,
  // that assumption silently pointed every request at Netlify's own
  // domain, leaving the page stuck on "Loading..." forever). Injected
  // here as a fixed, public URL instead, same category as SUPABASE_URL.
  const apiBase = `${requireEnv("SUPABASE_URL")}/functions/v1/phone-capture`;

  let html = readFileSync(SOURCE_FILE, "utf8");
  html = substitutePlaceholder(html, PUBLISHABLE_KEY_PLACEHOLDER, publishableKey);
  html = substitutePlaceholder(html, API_BASE_PLACEHOLDER, apiBase);

  // CRITICAL: the Netlify CLI auto-detects a framework (Next.js, etc.) from
  // its OWN process.cwd(), not from --dir -- running it with this repo as
  // cwd previously caused it to silently build and deploy the ENTIRE
  // Next.js Manager app (a real, if brief, production exposure -- caught
  // and torn down immediately). `cwd: stagingDir` below puts a directory
  // with nothing in it but index.html in front of that detection, and
  // --no-build is kept as defense in depth on top of that.
  const stagingDir = mkdtempSync(path.join(tmpdir(), "phone-capture-shell-"));
  writeFileSync(path.join(stagingDir, "index.html"), html, "utf8");

  const existingSiteId = process.env.NETLIFY_SITE_ID;
  const args = ["deploy", "--prod", "--dir", ".", "--no-build", "--json"];
  if (existingSiteId) {
    args.push("--site", existingSiteId);
  } else {
    args.push("--site-name", SITE_NAME);
  }

  console.log(`Deploying ${SOURCE_FILE} (publishable key + apiBase=${apiBase} substituted) to Netlify${existingSiteId ? ` (site ${existingSiteId})` : ` as a new site "${SITE_NAME}"`}, isolated in ${stagingDir}...`);
  const output = execFileSync("netlify", args, { encoding: "utf8", cwd: stagingDir });
  rmSync(stagingDir, { recursive: true, force: true });

  const result = JSON.parse(output) as { site_id?: string; url?: string; deploy_url?: string };
  console.log("\nDeployed.");
  console.log(`Site URL: ${result.url}`);
  if (!existingSiteId && result.site_id) {
    console.log(`\nAdd this to .env.local so future runs update the SAME site:\nNETLIFY_SITE_ID=${result.site_id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
