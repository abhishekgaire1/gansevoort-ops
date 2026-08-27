// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

/**
 * Phone-to-Desktop Invoice Capture -- PUBLIC phone-facing JSON API.
 *
 * This function exists for exactly one reason: a phone on cellular/Wi-Fi
 * can never reach a developer's `localhost:3000`. The desktop Next.js app
 * (app/actions/invoiceCaptureDesktop.ts, app/manager/(app)/receiving/
 * _components/TakePhotoWithPhoneFlow.tsx) is completely unchanged and stays
 * at localhost -- it never needs to be publicly reachable. Only the narrow
 * phone-facing slice moves here, to a URL that's public by construction
 * (`https://<project-ref>.supabase.co/functions/v1/phone-capture`).
 *
 * This function is JSON-only (status / begin-upload / finish-upload). It
 * used to also serve the phone's HTML/JS shell page directly from its own
 * GET route, but that was found to be undeployable: Supabase's edge
 * gateway force-downgrades any GET response with a text/html-family
 * Content-Type to text/plain with a locked-down sandboxed CSP, for EVERY
 * *.supabase.co surface (confirmed against both this function's own GET
 * route and a public Storage object, including via the authenticated,
 * non-cached Storage endpoint, and even under an alternate
 * application/xhtml+xml content-type) -- a platform-wide anti-phishing
 * policy that only lifts with a custom domain. The shell page now lives as
 * a small static site on Netlify instead (see
 * supabase/storage-assets/phone-capture/capture-shell.html and
 * scripts/deployPhoneCaptureShellToNetlify.ts) and calls this function's
 * JSON endpoints via a normal cross-origin fetch(); this function's own
 * job shrinks to exactly what it always was underneath: the narrow,
 * token-authorized API, nothing about rendering.
 *
 * This is a Deno port of app/actions/invoiceCapturePhone.ts, not a
 * redesign: same RPCs (get_invoice_capture_session_phone,
 * begin_invoice_capture_upload, record_invoice_capture_page, plus
 * delete_invoice_capture_page/reorder_invoice_capture_pages added by
 * 20260811100127 for multi-page support), same token-digest authorization
 * model, same storage bucket/path convention, same validation order and
 * error mapping (GA059/GA060/GA061/GA072). A Next.js Server Action can't
 * run inside a Deno Edge Function's runtime, so the logic is duplicated
 * here in Deno rather than shared -- but it must stay behaviorally
 * identical to the Node original, which remains the audited, tested
 * reference implementation (and would still work unchanged if the Next.js
 * app itself is ever deployed publicly -- see that file's tests).
 *
 * Multi-page (100127): pageNumber is now read from the request body for
 * begin-upload/finish-upload, and delete-page/reorder-pages are new
 * actions -- but this is the ONE deliberate exception to "the body is
 * never trusted for identity": a page number is just an integer position
 * within a session already resolved from the token digest, never an
 * organization/session/storage-path, and every RPC that consumes it
 * independently re-derives and enforces sequencing/permutation validity
 * server-side regardless of what the client claims.
 *
 * Auth mode is 'none' (see supabase/config.toml's `verify_jwt = false` for
 * this function): the phone (via the Netlify-hosted shell) never has a
 * Supabase apikey/JWT of its own. The capture token IS the authorization
 * boundary here -- every operation below hashes the caller-supplied token
 * and resolves (or refuses) a single capture session from that digest
 * alone. The phone can never choose an organization, a session, or a
 * storage path; every one of those is server-derived from the token
 * digest, exactly as in the Node original. `ctx.supabaseAdmin`
 * (service-role) never leaves this function -- the phone only ever
 * receives a narrowly-scoped signed upload URL for the exact expected
 * object, never a credential.
 *
 * CORS is scoped to ALLOWED_FRONTEND_ORIGIN (the one known Netlify shell
 * deployment), not a wildcard -- the real authorization boundary is the
 * capture token regardless of CORS, but there is exactly one legitimate
 * caller origin, so there is no reason to accept fetch() calls from
 * arbitrary web pages. Update this constant (and redeploy) if the shell is
 * ever redeployed under a different Netlify site.
 */

const ALLOWED_FRONTEND_ORIGIN = "https://gansevoort-ops-phone-capture.netlify.app";

const RECEIVING_DOCUMENTS_BUCKET = "receiving-documents";
const CAPTURE_MAX_FILE_BYTES = 20 * 1024 * 1024;
const CAPTURE_MAX_FILE_MB = CAPTURE_MAX_FILE_BYTES / (1024 * 1024);
const CAPTURE_ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png"];
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,50}$/;

function isPlausibleCaptureToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hashCaptureToken(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

function buildCaptureStoragePath(organizationId: string, sessionId: string, pageNumber: number, extension: string): string {
  return `org/${organizationId}/captures/${sessionId}/page-${pageNumber}.${extension}`;
}

function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

type CaptureFailureReason = "invalid" | "expired" | "unavailable" | "not_found" | "invalid_file_type" | "misconfigured";
interface CaptureFailure {
  ok: false;
  reason: CaptureFailureReason;
  message: string;
}

const INVALID: CaptureFailure = { ok: false, reason: "invalid", message: "This capture link is not valid." };
const EXPIRED: CaptureFailure = { ok: false, reason: "expired", message: "This capture link has expired." };
const UNAVAILABLE: CaptureFailure = { ok: false, reason: "unavailable", message: "This capture session is no longer available." };
const PAGE_NOT_FOUND: CaptureFailure = { ok: false, reason: "not_found", message: "That page no longer exists in this capture session." };
const MISCONFIGURED: CaptureFailure = { ok: false, reason: "misconfigured", message: "Something went wrong. Try again." };

function mapRpcError(error: { code?: string; message?: string }): CaptureFailure {
  if (error.code === "GA059") return INVALID;
  if (error.code === "GA060") return EXPIRED;
  if (error.code === "GA061") return UNAVAILABLE;
  if (error.code === "GA072") return PAGE_NOT_FOUND;
  return MISCONFIGURED;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
type AdminClient = any;

async function handleStatus(admin: AdminClient, token: string): Promise<Response> {
  if (!isPlausibleCaptureToken(token)) return json(INVALID);

  const digest = await hashCaptureToken(token);
  const { data, error } = await admin.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
  if (error) return json(MISCONFIGURED);
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_status: string; out_page_count: number } | undefined;
  if (!row) return json(INVALID);

  return json({ ok: true, status: row.out_status, pageCount: row.out_page_count });
}

// Multi-page (100127): pageNumber is caller-supplied (the phone's own
// running page count + 1) but is never trusted as an identity --
// begin_invoice_capture_upload independently re-derives and enforces that
// it is exactly the next sequential page for THIS session server-side (out
// of sequence or over the 20-page cap raises GA061), so a client can never
// skip pages or exceed the cap merely by passing a different number.
async function handleBeginUpload(admin: AdminClient, token: string, declaredContentType: string, pageNumber: number): Promise<Response> {
  if (!isPlausibleCaptureToken(token)) return json(INVALID);
  if (!CAPTURE_ACCEPTED_MIME_TYPES.includes(declaredContentType)) {
    return json({ ok: false, reason: "invalid_file_type", message: "Unsupported photo format." });
  }

  const digest = await hashCaptureToken(token);
  const { data, error } = await admin.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: pageNumber });
  if (error) return json(mapRpcError(error));
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_organization_id: string } | undefined;
  if (!row) return json(INVALID);

  const extension = declaredContentType === "image/png" ? "png" : "jpg";
  const path = buildCaptureStoragePath(row.out_organization_id, row.out_session_id, pageNumber, extension);

  const { data: uploadUrlData, error: uploadUrlError } = await admin.storage.from(RECEIVING_DOCUMENTS_BUCKET).createSignedUploadUrl(path);
  if (uploadUrlError || !uploadUrlData) {
    return json({ ok: false, reason: "misconfigured", message: "Could not start the upload. Try again." });
  }

  return json({ ok: true, path, signedUrl: uploadUrlData.signedUrl, uploadToken: uploadUrlData.token });
}

async function handleFinishUpload(admin: AdminClient, token: string, declaredContentType: string, pageNumber: number): Promise<Response> {
  if (!isPlausibleCaptureToken(token)) return json(INVALID);
  const digest = await hashCaptureToken(token);

  const { data: statusData, error: statusError } = await admin.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
  if (statusError) return json(MISCONFIGURED);
  const statusRow = (Array.isArray(statusData) ? statusData[0] : statusData) as { out_session_id: string; out_status: string } | undefined;
  if (!statusRow) return json(INVALID);
  if (statusRow.out_status === "EXPIRED") return json(EXPIRED);
  // Multi-page (100127): a session may legitimately already be RECEIVED
  // (page 1+ already recorded) while still accepting the next page --
  // only CANCELLED/CONTINUED genuinely refuse further uploads here.
  if (statusRow.out_status !== "WAITING" && statusRow.out_status !== "RECEIVED") return json(UNAVAILABLE);

  // Re-derive the storage path server-side from the session's own org --
  // never trusts a client-supplied path (same rule as the Node original).
  const { data: sessionOrgData } = await admin.from("invoice_capture_sessions").select("organization_id").eq("id", statusRow.out_session_id).single();
  const organizationId = sessionOrgData?.organization_id as string | undefined;
  if (!organizationId) return json(INVALID);

  const extension = declaredContentType === "image/png" ? "png" : "jpg";
  const path = buildCaptureStoragePath(organizationId, statusRow.out_session_id, pageNumber, extension);

  const { data: blob, error: downloadError } = await admin.storage.from(RECEIVING_DOCUMENTS_BUCKET).download(path);
  if (downloadError || !blob) {
    return json({ ok: false, reason: "misconfigured", message: "The uploaded photo could not be found. Try again." });
  }

  const buffer = new Uint8Array(await blob.arrayBuffer());
  if (buffer.byteLength === 0) {
    return json({ ok: false, reason: "invalid_file_type", message: "The photo appears to be empty. Try again." });
  }
  if (buffer.byteLength > CAPTURE_MAX_FILE_BYTES) {
    return json({ ok: false, reason: "invalid_file_type", message: `Photos must be ${CAPTURE_MAX_FILE_MB} MB or smaller.` });
  }

  const sniffedMimeType = sniffMimeType(buffer);
  if (!sniffedMimeType || !CAPTURE_ACCEPTED_MIME_TYPES.includes(sniffedMimeType)) {
    return json({ ok: false, reason: "invalid_file_type", message: "Unsupported photo format." });
  }

  const contentHash = await sha256Hex(buffer);

  // record_invoice_capture_page is idempotent -- a retry with the same
  // token/page is a true no-op (out_already_recorded: true), never a
  // duplicate row or a duplicate PHONE_CAPTURE_RECEIVED audit event.
  const { error: recordError } = await admin.rpc("record_invoice_capture_page", {
    p_token_digest: digest,
    p_page_number: pageNumber,
    p_storage_path: path,
    p_content_type: sniffedMimeType,
    p_byte_size: buffer.byteLength,
    p_content_hash: contentHash,
  });
  if (recordError) return json(mapRpcError(recordError));

  return json({ ok: true });
}

async function handleDeletePage(admin: AdminClient, token: string, pageNumber: number): Promise<Response> {
  if (!isPlausibleCaptureToken(token)) return json(INVALID);

  const digest = await hashCaptureToken(token);
  const { data, error } = await admin.rpc("delete_invoice_capture_page", { p_token_digest: digest, p_page_number: pageNumber });
  if (error) return json(mapRpcError(error));
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_remaining_page_count: number } | undefined;
  if (!row) return json(INVALID);

  return json({ ok: true, remainingPageCount: row.out_remaining_page_count });
}

async function handleReorderPages(admin: AdminClient, token: string, newPageOrder: number[]): Promise<Response> {
  if (!isPlausibleCaptureToken(token)) return json(INVALID);

  const digest = await hashCaptureToken(token);
  const { error } = await admin.rpc("reorder_invoice_capture_pages", { p_token_digest: digest, p_new_page_order: newPageOrder });
  if (error) return json(mapRpcError(error));

  return json({ ok: true });
}

export default {
  fetch: withSupabase(
    {
      auth: "none",
      cors: {
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_FRONTEND_ORIGIN,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
          Vary: "Origin",
        },
      },
    },
    async (req, ctx) => {
      if (req.method === "POST") {
        // pageNumber/newPageOrder are read here alongside token/action/
        // contentType -- unlike organizationId/sessionId/storagePath (which
        // this function NEVER reads from the body, always server-deriving
        // them from the token digest instead), a page number is just an
        // integer POSITION, not an identity, and every RPC that consumes it
        // independently re-validates it server-side (sequential-next-page,
        // 20-page cap, exact-permutation-of-existing-pages) -- see each
        // handler's own comments.
        let body: { action?: string; token?: string; contentType?: string; pageNumber?: number; newPageOrder?: number[] };
        try {
          body = await req.json();
        } catch {
          return json({ ok: false, reason: "misconfigured", message: "Malformed request." }, 400);
        }

        const token = body.token;
        if (!token) return json(INVALID);

        if (body.action === "status") return handleStatus(ctx.supabaseAdmin, token);
        if (body.action === "begin-upload") return handleBeginUpload(ctx.supabaseAdmin, token, body.contentType ?? "", body.pageNumber ?? 1);
        if (body.action === "finish-upload") return handleFinishUpload(ctx.supabaseAdmin, token, body.contentType ?? "", body.pageNumber ?? 1);
        if (body.action === "delete-page") return handleDeletePage(ctx.supabaseAdmin, token, body.pageNumber ?? 0);
        if (body.action === "reorder-pages") return handleReorderPages(ctx.supabaseAdmin, token, body.newPageOrder ?? []);
        return json({ ok: false, reason: "misconfigured", message: "Unknown action." }, 400);
      }

      return new Response("Method Not Allowed", { status: 405 });
    }
  ),
};
