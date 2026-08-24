# Scanner Bridge Security Model

## Threat model

The bridge listens on `127.0.0.1:8765` on the receiving-office Mac. The
concern is NOT "can this computer's own user reach it" (they can, by
design) -- it's **"can an arbitrary web page the operator happens to have
open in another tab, or a malicious site, drive the scanner or read scan
results."** Any page can attempt a `fetch()` to `http://127.0.0.1:8765/...`;
the defenses below assume that will happen and are why the bridge is
still safe when it does.

## Defenses

1. **Loopback-only bind.** `NWListener` is constructed with
   `requiredLocalEndpoint = 127.0.0.1:8765`, never `0.0.0.0`. No other
   computer on the LAN can reach it at all, regardless of application-
   layer checks.

2. **Strict Origin allowlist, on every route including `/health`.**
   `OriginPolicy` rejects (403, no CORS headers) any request whose
   `Origin` header isn't exactly `http://localhost:3000` (dev) or a
   configured production origin (`GANSEVOORT_SCANNER_BRIDGE_ALLOWED_ORIGINS`).
   Never a wildcard `Access-Control-Allow-Origin: *`. Even if a
   malicious page's request technically reaches the server, the
   response carries no CORS header for a disallowed origin, so the
   browser refuses to let that page's script read it.

3. **Short-lived, unpredictable session tokens.** `POST /pair` mints a
   256-bit random token (via `SecRandomCopyBytes`), held only in the
   bridge's memory (never written to disk), expiring after 30 minutes of
   inactivity. Every route beyond `/health`/`/pair` requires
   `Authorization: Bearer <token>`. This is layered ON TOP of the Origin
   check, not instead of it -- neither alone is sufficient.

4. **No server secrets, ever.** This package has no dependency on and no
   knowledge of `SUPABASE_SECRET_KEY`, any `service_role` credential,
   `GEMINI_API_KEY`, `PIN_PEPPER`, `KIOSK_TOKEN_SECRET`, or any other
   Gansevoort Ops server-only secret. The bridge's job ends at producing
   a local PDF file; the browser (already holding a real, short-lived
   Supabase Auth session as an authenticated manager) is solely
   responsible for the actual authenticated upload into Supabase
   Storage via the existing signed-upload flow.

5. **Narrow, enumerated API surface.** No arbitrary filesystem browsing,
   no arbitrary path reads, no shell execution, no generic file upload,
   no arbitrary URL fetching. Every route is a fixed, hand-written
   handler in `BridgeRouter.swift` -- there is no route that takes a
   client-supplied filesystem path.

6. **No document-content logging.** `Logging.swift` is the only logging
   surface in this package, and every call site passes short, safe
   key/value pairs (jobId, page count, byte size, scanner name, timing,
   error codes) -- never PDF bytes, image data, or OCR/business-document
   content. Logs go to `os_log` (local to this Mac, viewable only via
   Console.app/`log stream`), never over the network.

7. **Temporary, bounded-lifetime files only.** Scan output lives in
   `$TMPDIR/gansevoort-scanner-bridge/<jobId>/` and is deleted on
   cancel, immediately after the manager downloads the finalized PDF, on
   a 15-minute inactivity sweep, and best-effort on process shutdown
   (SIGINT/SIGTERM). Nothing here is a permanent purchase document or
   Storage object -- that only exists once the EXISTING, already-audited
   Gansevoort Ops upload/finalize pipeline creates it.

## What this bridge deliberately does NOT do

- It does not authenticate against Supabase or verify the caller is a
  real logged-in manager. It can't -- it holds no Supabase credentials.
  Its only guarantee is "this request came from the Gansevoort Ops
  origin, running as JS in whatever browser tab has it open" -- the
  actual authorization boundary (is this person allowed to upload
  invoices) is enforced, as always, by `requireManagerOrAdmin()` on the
  Next.js server when the resulting PDF is uploaded through the existing
  pipeline.
- It does not implement enterprise device management, mutual TLS, or
  certificate pinning. That would be disproportionate for a single-Mac,
  single-scanner local helper; the Origin+session model above is
  deliberately proportionate to the actual risk (a stray malicious tab),
  not a nation-state adversary with LAN access.
