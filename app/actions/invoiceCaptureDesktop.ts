"use server";

import QRCode from "qrcode";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { generateCaptureToken } from "@/app/lib/invoiceCapture/token";
import { CAPTURE_SESSION_EXPIRY_MINUTES } from "@/app/lib/invoiceCapture/constants";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/invoiceCapture/storagePath";

/**
 * Phone-to-Desktop Invoice Capture milestone -- desktop-side (fully
 * authenticated Manager/Admin) Server Actions. Every function here gates
 * on requireManagerOrAdmin() exactly like every other Receiving action;
 * the phone-side counterparts (app/actions/invoiceCapturePhone.ts) are a
 * deliberately separate file with NO such gate, token-authorized only
 * (Part 6/30) -- never mixed into this one.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export type CaptureSessionStatus = "WAITING" | "RECEIVED" | "CANCELLED" | "CONTINUED" | "EXPIRED";

export interface CaptureSessionState {
  sessionId: string;
  status: CaptureSessionStatus;
  expiresAt: string;
  documentId: string | null;
  pageCount: number;
}

function mapSessionRow(row: { out_session_id: string; out_status: string; out_expires_at: string; out_document_id: string | null; out_page_count: number }): CaptureSessionState {
  return {
    sessionId: row.out_session_id,
    status: row.out_status as CaptureSessionStatus,
    expiresAt: row.out_expires_at,
    documentId: row.out_document_id,
    pageCount: Number(row.out_page_count),
  };
}

export type CreateCaptureSessionResult =
  | { ok: true; session: CaptureSessionState; captureUrl: string; qrCodeDataUri: string }
  | AuthFailure
  | { ok: false; reason: "misconfigured"; message: string };

/** Mints a fresh, cryptographically random token (Part 5/7), stores only
 * its digest, and returns the public phone-capture URL plus a
 * server-generated QR image for it (Part 36: a local package, never an
 * external QR-rendering service that would see the capture URL) -- the
 * raw token exists in memory just long enough to build this one URL and
 * is never logged (Part 70; see also logUploadDiagnostic's own "never log
 * secrets" convention in documentUpload.ts).
 *
 * The QR deliberately does NOT point at this desktop app's own origin
 * (never derived from window.location/request Host/localhost) -- a phone
 * on cellular/Wi-Fi can never reach a developer's `localhost:3000`, and
 * the desktop does not need to become publicly reachable to fix that.
 *
 * It points at PHONE_CAPTURE_SHELL_URL, a small static site
 * (supabase/storage-assets/phone-capture/capture-shell.html, deployed via
 * scripts/deployPhoneCaptureShellToNetlify.ts) whose own inline JS calls
 * the public Supabase Edge Function (supabase/functions/phone-capture/
 * index.ts) for every actual operation (status/begin-upload/finish-
 * upload). The shell is NOT hosted directly on Supabase: both the Edge
 * Function's own GET route and a public Storage object were tried and
 * confirmed (including via the authenticated, non-cached Storage endpoint,
 * and under an alternate application/xhtml+xml content-type) to be
 * force-downgraded to text/plain with a sandboxed CSP -- a platform-wide
 * anti-phishing policy Cloudflare applies across all of *.supabase.co, only
 * lifted by a custom domain. PHONE_CAPTURE_SHELL_URL is public
 * configuration (just a URL, no secret), same category as SUPABASE_URL. */
export async function createCaptureSessionAction(): Promise<CreateCaptureSessionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const shellUrl = process.env.PHONE_CAPTURE_SHELL_URL;
  if (!shellUrl) {
    return { ok: false, reason: "misconfigured", message: "Could not start a phone capture session. Try again." };
  }

  const { token, digest } = generateCaptureToken();
  const expiresAt = new Date(Date.now() + CAPTURE_SESSION_EXPIRY_MINUTES * 60_000).toISOString();

  const { data, error } = await getServiceRoleClient().rpc("create_invoice_capture_session", {
    p_organization_id: auth.manager.organizationId,
    p_actor_app_user_id: auth.manager.appUserId,
    p_token_digest: digest,
    p_expires_at: expiresAt,
  });
  if (error) {
    return { ok: false, reason: "misconfigured", message: "Could not start a phone capture session. Try again." };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string } | undefined;
  if (!row) {
    return { ok: false, reason: "misconfigured", message: "Could not start a phone capture session. Try again." };
  }

  const captureUrl = `${shellUrl}?token=${token}`;
  const qrCodeDataUri = await QRCode.toDataURL(captureUrl, { margin: 1, width: 260 });

  return {
    ok: true,
    session: { sessionId: row.out_session_id, status: "WAITING", expiresAt, documentId: null, pageCount: 0 },
    captureUrl,
    qrCodeDataUri,
  };
}

export type GetCaptureSessionResult = { ok: true; session: CaptureSessionState | null } | AuthFailure;

export async function getCaptureSessionStatusAction(sessionId: string): Promise<GetCaptureSessionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const { data, error } = await getServiceRoleClient().rpc("get_invoice_capture_session_desktop", {
    p_organization_id: auth.manager.organizationId,
    p_session_id: sessionId,
  });
  if (error) return { ok: true, session: null };
  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_session_id: string; out_status: string; out_expires_at: string; out_document_id: string | null; out_page_count: number }
    | undefined;
  return { ok: true, session: row ? mapSessionRow(row) : null };
}

/** Refresh-recovery (Part 27): the most recent still-open session this
 * Manager created, if any, so an accidental desktop reload can restore
 * "Waiting for photo..."/"Photo received" without relying on client-only
 * React state. */
export async function getActiveCaptureSessionAction(): Promise<GetCaptureSessionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const { data, error } = await getServiceRoleClient().rpc("get_active_invoice_capture_session_for_manager", {
    p_organization_id: auth.manager.organizationId,
    p_created_by_app_user_id: auth.manager.appUserId,
  });
  if (error) return { ok: true, session: null };
  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_session_id: string; out_status: string; out_expires_at: string; out_document_id: string | null; out_page_count: number }
    | undefined;
  return { ok: true, session: row ? mapSessionRow(row) : null };
}

export type CancelCaptureSessionResult = { ok: true } | AuthFailure | { ok: false; reason: "misconfigured"; message: string };

export async function cancelCaptureSessionAction(sessionId: string): Promise<CancelCaptureSessionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const { error } = await getServiceRoleClient().rpc("cancel_invoice_capture_session", {
    p_organization_id: auth.manager.organizationId,
    p_actor_app_user_id: auth.manager.appUserId,
    p_session_id: sessionId,
  });
  if (error) {
    return { ok: false, reason: "misconfigured", message: "Could not cancel the capture session." };
  }
  return { ok: true };
}

export type GetCaptureImageResult = { ok: true; downloadUrl: string; contentType: string } | AuthFailure | { ok: false; reason: "not_found"; message: string };

/** Mints a short-lived signed READ URL for the received page's bytes
 * (Part 67: never a permanent public URL) so the desktop browser can
 * fetch() it into a Blob and hand it to the EXISTING initiateUpload/
 * uploadAndFinalize pipeline as a plain File -- exactly how
 * ScanInvoiceFlow.tsx already turns a downloaded Blob into a File today. */
export async function getCaptureImageDownloadUrlAction(sessionId: string): Promise<GetCaptureImageResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data: page } = await supabase
    .from("invoice_capture_pages")
    .select("storage_path, content_type")
    .eq("organization_id", auth.manager.organizationId)
    .eq("capture_session_id", sessionId)
    .eq("page_number", 1)
    .maybeSingle();

  if (!page) {
    return { ok: false, reason: "not_found", message: "No photo has been received for this session yet." };
  }

  const { data: signed, error } = await supabase.storage.from(RECEIVING_DOCUMENTS_BUCKET).createSignedUrl(page.storage_path as string, 300);
  if (error || !signed) {
    return { ok: false, reason: "not_found", message: "Could not load the received photo. Try again." };
  }

  return { ok: true, downloadUrl: signed.signedUrl, contentType: page.content_type as string };
}

export interface CapturedPageSummary {
  pageNumber: number;
  downloadUrl: string;
  contentType: string;
}

export type ListCaptureSessionPagesResult = { ok: true; pages: CapturedPageSummary[] } | AuthFailure | { ok: false; reason: "misconfigured"; message: string };

/** Multi-page (100127): enumerates EVERY page this session has received,
 * in order, each with its own short-lived signed read URL -- the bridge
 * to the real upload pipeline (below) downloads each in turn and feeds
 * them into finalizeDocumentUpload (page 1) / addDocumentPageRpc (page
 * 2+) so all pages become ONE document, never separate ones. Org-scoped
 * exactly like list_invoice_capture_pages_desktop itself -- a session
 * belonging to a different organization is invisible here, same as every
 * other desktop action in this file. */
export async function listCaptureSessionPagesAction(sessionId: string): Promise<ListCaptureSessionPagesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.rpc("list_invoice_capture_pages_desktop", {
    p_organization_id: auth.manager.organizationId,
    p_session_id: sessionId,
  });
  if (error) {
    return { ok: false, reason: "misconfigured", message: "Could not load the captured pages. Try again." };
  }

  const rows = (data ?? []) as { out_page_number: number; out_storage_path: string; out_content_type: string }[];
  const pages: CapturedPageSummary[] = [];
  for (const row of rows) {
    const { data: signed, error: signError } = await supabase.storage.from(RECEIVING_DOCUMENTS_BUCKET).createSignedUrl(row.out_storage_path, 300);
    if (signError || !signed) {
      return { ok: false, reason: "misconfigured", message: "Could not load one of the captured pages. Try again." };
    }
    pages.push({ pageNumber: row.out_page_number, downloadUrl: signed.signedUrl, contentType: row.out_content_type });
  }

  return { ok: true, pages };
}

export type ContinueCaptureSessionResult = { ok: true } | AuthFailure | { ok: false; reason: "misconfigured"; message: string };

/** Called AFTER the desktop has already run the downloaded image through
 * initiateUpload/uploadAndFinalize and holds a real documentId -- this
 * action never creates a document itself (Part 23), it only closes the
 * token and records provenance (Part 29-30). */
export async function continueCaptureSessionAction(sessionId: string, documentId: string): Promise<ContinueCaptureSessionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const { error } = await getServiceRoleClient().rpc("continue_invoice_capture_session", {
    p_organization_id: auth.manager.organizationId,
    p_actor_app_user_id: auth.manager.appUserId,
    p_session_id: sessionId,
    p_document_id: documentId,
  });
  if (error) {
    return { ok: false, reason: "misconfigured", message: "Could not finish linking the captured photo. The invoice was still uploaded successfully." };
  }
  return { ok: true };
}
