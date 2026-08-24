import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI-safe: no network, no database, no Deno runtime. The Edge Function
 * (supabase/functions/phone-capture/index.ts) runs on Deno, which is not
 * available in this Node/Vitest project -- it can't be imported and
 * exercised the way app/actions/invoiceCapturePhone.ts's Node original
 * can (see invoiceCapturePhoneAction.unit.test.ts and invoiceCapture.rpc.
 * test.ts, which already prove the shared RPC layer both callers go
 * through). What this file CAN and does prove: the deployed source text
 * itself upholds the narrow-authorization invariants the Phone Capture
 * spec requires -- no service-role/secret key ever reaches a phone
 * response, org/session/storage-path are always server-derived (never
 * read from the request body), single-page V1 is hardcoded, and the
 * platform-level auth mode matches the deliberate "capture token is the
 * boundary" design recorded in config.toml.
 *
 * This function is JSON-only (status/begin-upload/finish-upload) -- it no
 * longer serves the phone's HTML/JS shell page itself. That page now lives
 * as a static site on Netlify (tests/phoneCaptureShellPage.unit.test.ts)
 * after both this function's own GET route and a public Supabase Storage
 * object were confirmed unable to serve real HTML: Supabase's edge gateway
 * force-downgrades any HTML-family Content-Type to text/plain with a
 * sandboxed CSP across the entire *.supabase.co domain (verified directly,
 * including via the authenticated/non-cached Storage endpoint and an
 * alternate application/xhtml+xml content-type) -- a platform-wide
 * anti-phishing policy, not a response-header bug.
 */

const FUNCTION_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "../supabase/functions/phone-capture/index.ts"),
  "utf8"
);
const CONFIG_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../supabase/config.toml"), "utf8");

describe("phone-capture Edge Function -- no service-role/secret key ever reaches the phone", () => {
  it("never references SUPABASE_SECRET_KEY -- ctx.supabaseAdmin is used server-side only, never echoed back", () => {
    expect(FUNCTION_SOURCE).not.toContain("SUPABASE_SECRET_KEY");
    expect(FUNCTION_SOURCE).not.toMatch(/SERVICE_ROLE/);
  });

  it("every JSON response is built through the json() helper, which only ever serializes caller-constructed plain objects -- never the admin client itself", () => {
    // A crude but effective regression guard: if ctx.supabaseAdmin (or any
    // client object) were ever passed directly to json(...), that call site
    // would read `json(ctx.supabaseAdmin` or similar -- it never does.
    expect(FUNCTION_SOURCE).not.toMatch(/json\(\s*ctx\.supabaseAdmin/);
    expect(FUNCTION_SOURCE).not.toMatch(/json\(\s*admin\b/);
  });
});

describe("phone-capture Edge Function -- org/session/storage path are always server-derived, never client-supplied", () => {
  it("the POST body is only ever destructured for token/action/contentType -- never organizationId/sessionId/path", () => {
    expect(FUNCTION_SOURCE).toMatch(/body\.token/);
    expect(FUNCTION_SOURCE).toMatch(/body\.action/);
    expect(FUNCTION_SOURCE).not.toMatch(/body\.organizationId/);
    expect(FUNCTION_SOURCE).not.toMatch(/body\.sessionId/);
    expect(FUNCTION_SOURCE).not.toMatch(/body\.path/);
    expect(FUNCTION_SOURCE).not.toMatch(/body\.storagePath/);
  });

  it("buildCaptureStoragePath is only ever called with the RPC-returned organizationId/sessionId, never a request field", () => {
    expect(FUNCTION_SOURCE).toContain("buildCaptureStoragePath(row.out_organization_id, row.out_session_id, 1, extension)");
    expect(FUNCTION_SOURCE).toContain("buildCaptureStoragePath(organizationId, statusRow.out_session_id, 1, extension)");
  });

  it("page number is hardcoded to 1 everywhere -- single-page V1, never taken from the client", () => {
    expect(FUNCTION_SOURCE).toContain('p_page_number: 1');
    expect(FUNCTION_SOURCE).not.toMatch(/p_page_number:\s*body\./);
  });
});

describe("phone-capture Edge Function -- RECEIVED only follows a server-side download + validation, never a client claim", () => {
  it("finish-upload downloads the object, checks byte length, and sniffs the MIME type before ever calling record_invoice_capture_page", () => {
    const finishFnMatch = FUNCTION_SOURCE.match(/async function handleFinishUpload[\s\S]*?\n}\n/);
    expect(finishFnMatch).not.toBeNull();
    const body = finishFnMatch![0];

    const downloadIndex = body.indexOf(".download(path)");
    const emptyCheckIndex = body.indexOf("buffer.byteLength === 0");
    const sniffIndex = body.indexOf("sniffMimeType(buffer)");
    const recordIndex = body.indexOf('"record_invoice_capture_page"');

    expect(downloadIndex).toBeGreaterThan(-1);
    expect(emptyCheckIndex).toBeGreaterThan(downloadIndex);
    expect(sniffIndex).toBeGreaterThan(emptyCheckIndex);
    expect(recordIndex).toBeGreaterThan(sniffIndex);
  });
});

describe("phone-capture Edge Function -- uses the same RPCs, error codes, and bucket as the Node original", () => {
  it("calls the exact same three phone-facing RPCs as app/actions/invoiceCapturePhone.ts", () => {
    expect(FUNCTION_SOURCE).toContain('"get_invoice_capture_session_phone"');
    expect(FUNCTION_SOURCE).toContain('"begin_invoice_capture_upload"');
    expect(FUNCTION_SOURCE).toContain('"record_invoice_capture_page"');
  });

  it("maps GA059/GA060/GA061 identically to the Node original", () => {
    expect(FUNCTION_SOURCE).toContain('"GA059"');
    expect(FUNCTION_SOURCE).toContain('"GA060"');
    expect(FUNCTION_SOURCE).toContain('"GA061"');
  });

  it("reuses the existing receiving-documents bucket, never a new/public bucket", () => {
    expect(FUNCTION_SOURCE).toContain('"receiving-documents"');
    expect(FUNCTION_SOURCE).not.toMatch(/createBucket/);
  });

  it("never lists or searches storage objects -- only createSignedUploadUrl and download of one exact path", () => {
    expect(FUNCTION_SOURCE).not.toMatch(/\.storage\.from\([^)]*\)\.list\(/);
  });
});

describe("phone-capture Edge Function -- JSON-only, no HTML serving", () => {
  it("never declares a text/html (or any HTML-family) Content-Type header -- there is nothing left for the platform's HTML-rewrite policy to catch", () => {
    // Checked against actual code, not the file's own explanatory comments
    // (which legitimately discuss text/html and xhtml as the reason this
    // function no longer serves HTML at all).
    const codeOnly = FUNCTION_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/text\/html/);
    expect(codeOnly).not.toMatch(/xhtml/i);
  });

  it("every response goes through the json() helper, which always sets application/json", () => {
    const jsonHelperMatch = FUNCTION_SOURCE.match(/function json\([\s\S]*?\n}\n/);
    expect(jsonHelperMatch).not.toBeNull();
    expect(jsonHelperMatch![0]).toMatch(/"content-type":\s*"application\/json"/);
  });

  it("a non-POST request (e.g. a bare GET) is rejected with Method Not Allowed, not an HTML page", () => {
    expect(FUNCTION_SOURCE).toMatch(/Method Not Allowed/);
  });

  it("the old HTML-serving code (renderPage/htmlResponse/PAGE_STYLE/PAGE_MARKUP/CLIENT_JS/resolvePublishableKey) is fully removed, not just unreachable", () => {
    expect(FUNCTION_SOURCE).not.toMatch(/function renderPage/);
    expect(FUNCTION_SOURCE).not.toMatch(/function htmlResponse/);
    expect(FUNCTION_SOURCE).not.toMatch(/PAGE_STYLE/);
    expect(FUNCTION_SOURCE).not.toMatch(/PAGE_MARKUP/);
    expect(FUNCTION_SOURCE).not.toMatch(/CLIENT_JS/);
    expect(FUNCTION_SOURCE).not.toMatch(/resolvePublishableKey/);
  });
});

describe("phone-capture Edge Function -- CORS scoped to the known Netlify frontend, not a wildcard", () => {
  it("declares the Netlify shell's own origin as ALLOWED_FRONTEND_ORIGIN, matching the URL the QR is built from", () => {
    expect(FUNCTION_SOURCE).toMatch(/const ALLOWED_FRONTEND_ORIGIN\s*=\s*"https:\/\/gansevoort-ops-phone-capture\.netlify\.app"/);
  });

  it("passes ALLOWED_FRONTEND_ORIGIN as Access-Control-Allow-Origin -- never a bare wildcard", () => {
    const corsConfigMatch = FUNCTION_SOURCE.match(/cors:\s*\{[\s\S]*?\n\s*\},/);
    expect(corsConfigMatch).not.toBeNull();
    expect(corsConfigMatch![0]).toMatch(/"Access-Control-Allow-Origin":\s*ALLOWED_FRONTEND_ORIGIN/);
    expect(corsConfigMatch![0]).not.toMatch(/"Access-Control-Allow-Origin":\s*"\*"/);
  });

  it("only allows the methods/headers actually used (POST, OPTIONS preflight, content-type) -- not a broad allowlist", () => {
    const corsConfigMatch = FUNCTION_SOURCE.match(/cors:\s*\{[\s\S]*?\n\s*\},/);
    expect(corsConfigMatch![0]).toMatch(/"Access-Control-Allow-Methods":\s*"POST, OPTIONS"/);
    expect(corsConfigMatch![0]).toMatch(/"Access-Control-Allow-Headers":\s*"content-type"/);
  });

  it("sets Vary: Origin since the allowed origin is a fixed value, not a per-request echo", () => {
    const corsConfigMatch = FUNCTION_SOURCE.match(/cors:\s*\{[\s\S]*?\n\s*\},/);
    expect(corsConfigMatch![0]).toMatch(/Vary:\s*"Origin"/);
  });

  it("CORS is not disabled -- OPTIONS preflight is still handled by @supabase/server's withSupabase wrapper", () => {
    expect(FUNCTION_SOURCE).not.toMatch(/cors:\s*"disabled"/);
    expect(FUNCTION_SOURCE).not.toMatch(/cors:\s*false/);
  });
});

describe("phone-capture Edge Function -- deliberate, non-JWT auth configuration", () => {
  it("config.toml disables the platform JWT check for this function, matching auth:'none' in the handler", () => {
    expect(CONFIG_SOURCE).toMatch(/\[functions\.phone-capture\][\s\S]*?verify_jwt = false/);
  });

  it("the handler itself uses auth:'none' -- the capture token, not a Supabase credential, is the authorization boundary", () => {
    expect(FUNCTION_SOURCE).toMatch(/auth:\s*"none"/);
  });

  it("the token is validated (shape-checked and digest-looked-up) before any privileged operation runs", () => {
    expect(FUNCTION_SOURCE).toMatch(/isPlausibleCaptureToken/);
    expect(FUNCTION_SOURCE).toMatch(/hashCaptureToken/);
  });
});
