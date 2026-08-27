"use server";

import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { hashCaptureToken, isPlausibleCaptureToken } from "@/app/lib/invoiceCapture/token";
import { buildCaptureStoragePath, RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/invoiceCapture/storagePath";
import { CAPTURE_ACCEPTED_MIME_TYPES, CAPTURE_MAX_FILE_BYTES, CAPTURE_MAX_FILE_MB } from "@/app/lib/invoiceCapture/constants";
import { sniffMimeType } from "@/app/lib/files/sniffMimeType";

/**
 * Phone-to-Desktop Invoice Capture milestone -- the ONLY Server Actions
 * an unauthenticated phone browser ever calls. Deliberately NOT gated by
 * requireManagerOrAdmin() (Part 6) -- the phone never logs in. Instead,
 * every function here takes the raw bearer token, hashes it, and resolves
 * the session FROM that digest -- the phone can never supply an
 * organization_id/session_id directly (Part 32), and can perform ONLY
 * these three narrow operations (Part 30): read display state, request an
 * upload slot, confirm a completed upload. No other capability exists in
 * this file.
 */

type CaptureFailureReason = "invalid" | "expired" | "unavailable" | "not_found" | "invalid_file_type" | "misconfigured";
type CaptureFailure = { ok: false; reason: CaptureFailureReason; message: string };

const INVALID: CaptureFailure = { ok: false, reason: "invalid", message: "This capture link is not valid." };
const EXPIRED: CaptureFailure = { ok: false, reason: "expired", message: "This capture link has expired." };
const UNAVAILABLE: CaptureFailure = { ok: false, reason: "unavailable", message: "This capture session is no longer available." };
const PAGE_NOT_FOUND: CaptureFailure = { ok: false, reason: "not_found", message: "That page no longer exists in this capture session." };

function mapRpcError(error: { code?: string; message: string }): CaptureFailure {
  if (error.code === "GA059") return INVALID;
  if (error.code === "GA060") return EXPIRED;
  if (error.code === "GA061") return UNAVAILABLE;
  if (error.code === "GA072") return PAGE_NOT_FOUND;
  return { ok: false, reason: "misconfigured", message: "Something went wrong. Try again." };
}

export type CapturePhoneStatus = "WAITING" | "RECEIVED" | "CANCELLED" | "CONTINUED" | "EXPIRED";

export type GetCapturePhoneStatusResult = { ok: true; status: CapturePhoneStatus; pageCount: number } | CaptureFailure;

export async function getCapturePhoneStatusAction(token: string): Promise<GetCapturePhoneStatusResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;

  const { data, error } = await getServiceRoleClient().rpc("get_invoice_capture_session_phone", { p_token_digest: hashCaptureToken(token) });
  if (error) return { ok: false, reason: "misconfigured", message: "Something went wrong. Try again." };
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_status: string; out_page_count: number } | undefined;
  if (!row) return INVALID;

  return { ok: true, status: row.out_status as CapturePhoneStatus, pageCount: Number(row.out_page_count) };
}

export type BeginCaptureUploadResult = { ok: true; path: string; signedUrl: string; uploadToken: string } | CaptureFailure;

/** Mints a signed upload URL scoped to the EXACT expected staging object
 * for this session's page (Part 31) -- never a broader bucket grant.
 * declaredContentType is validated against the narrow phone-capture
 * allowlist before a URL is ever minted (server-authoritative, never
 * trusting the browser's File.type alone at finalize time -- see
 * finishCaptureUploadAction below, which re-sniffs the actual bytes).
 *
 * Multi-page (100127): pageNumber is caller-supplied (the client's own
 * running page count + 1), but it is never trusted as an identity --
 * begin_invoice_capture_upload independently re-derives and enforces that
 * it is exactly the next sequential page for THIS session server-side
 * (out of sequence or over the 20-page cap raises GA061), so a client
 * cannot skip pages or exceed the cap merely by passing a different
 * number. */
export async function beginCaptureUploadAction(token: string, declaredContentType: string, pageNumber: number): Promise<BeginCaptureUploadResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;
  if (!(CAPTURE_ACCEPTED_MIME_TYPES as readonly string[]).includes(declaredContentType)) {
    return { ok: false, reason: "invalid_file_type", message: "Unsupported photo format." };
  }

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.rpc("begin_invoice_capture_upload", { p_token_digest: hashCaptureToken(token), p_page_number: pageNumber });
  if (error) return mapRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_organization_id: string } | undefined;
  if (!row) return INVALID;

  const extension = declaredContentType === "image/png" ? "png" : "jpg";
  const path = buildCaptureStoragePath(row.out_organization_id, row.out_session_id, pageNumber, extension);

  const { data: uploadUrlData, error: uploadUrlError } = await supabase.storage.from(RECEIVING_DOCUMENTS_BUCKET).createSignedUploadUrl(path);
  if (uploadUrlError || !uploadUrlData) {
    return { ok: false, reason: "misconfigured", message: "Could not start the upload. Try again." };
  }

  return { ok: true, path, signedUrl: uploadUrlData.signedUrl, uploadToken: uploadUrlData.token };
}

export type FinishCaptureUploadResult = { ok: true } | CaptureFailure;

/** The durable-receipt confirmation (Part 13/45): downloads the
 * just-uploaded object server-side and re-validates it exactly as
 * rigorously as the desktop pipeline's own finalizeDocumentUpload does
 * (size limit, magic-byte MIME sniff -- never trusting the client's
 * declared type alone), computes the authoritative SHA-256, and records
 * the page. This is where phone "success" actually happens -- before AI
 * extraction, before any business processing (Part 45), because none of
 * that runs from here; it only runs later, after the desktop clicks
 * Continue and the image enters the normal upload pipeline. */
export async function finishCaptureUploadAction(token: string, declaredContentType: string, pageNumber: number): Promise<FinishCaptureUploadResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;

  const supabase = getServiceRoleClient();
  const digest = hashCaptureToken(token);

  const { data: statusData, error: statusError } = await supabase.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
  if (statusError) return { ok: false, reason: "misconfigured", message: "Something went wrong. Try again." };
  const statusRow = (Array.isArray(statusData) ? statusData[0] : statusData) as { out_session_id: string; out_status: string } | undefined;
  if (!statusRow) return INVALID;
  if (statusRow.out_status === "EXPIRED") return EXPIRED;
  // Multi-page (100127): a session may legitimately be RECEIVED already
  // (page 1+ already recorded) while still accepting the NEXT page -- only
  // CANCELLED/CONTINUED genuinely refuse further uploads here.
  if (statusRow.out_status !== "WAITING" && statusRow.out_status !== "RECEIVED") return UNAVAILABLE;

  // Re-derive the exact same path the signed upload URL was scoped to --
  // never trusts a client-supplied path.
  const { data: sessionOrgData } = await supabase.from("invoice_capture_sessions").select("organization_id").eq("id", statusRow.out_session_id).single();
  const organizationId = sessionOrgData?.organization_id as string | undefined;
  if (!organizationId) return INVALID;

  const extension = declaredContentType === "image/png" ? "png" : "jpg";
  const path = buildCaptureStoragePath(organizationId, statusRow.out_session_id, pageNumber, extension);

  const { data: blob, error: downloadError } = await supabase.storage.from(RECEIVING_DOCUMENTS_BUCKET).download(path);
  if (downloadError || !blob) {
    return { ok: false, reason: "misconfigured", message: "The uploaded photo could not be found. Try again." };
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  if (buffer.byteLength === 0) {
    return { ok: false, reason: "invalid_file_type", message: "The photo appears to be empty. Try again." };
  }
  if (buffer.byteLength > CAPTURE_MAX_FILE_BYTES) {
    return { ok: false, reason: "invalid_file_type", message: `Photos must be ${CAPTURE_MAX_FILE_MB} MB or smaller.` };
  }

  const sniffedMimeType = sniffMimeType(buffer);
  if (!sniffedMimeType || !(CAPTURE_ACCEPTED_MIME_TYPES as readonly string[]).includes(sniffedMimeType)) {
    return { ok: false, reason: "invalid_file_type", message: "Unsupported photo format." };
  }

  const { createHash } = await import("node:crypto");
  const contentHash = createHash("sha256").update(buffer).digest("hex");

  const { error: recordError } = await supabase.rpc("record_invoice_capture_page", {
    p_token_digest: digest,
    p_page_number: pageNumber,
    p_storage_path: path,
    p_content_type: sniffedMimeType,
    p_byte_size: buffer.byteLength,
    p_content_hash: contentHash,
  });
  if (recordError) return mapRpcError(recordError);

  return { ok: true };
}

export type DeleteCapturePageResult = { ok: true; remainingPageCount: number } | CaptureFailure;

/** Retake/delete (Part: mobile multi-page capture) -- only while the
 * session is still open for editing (delete_invoice_capture_page itself
 * enforces WAITING/RECEIVED, raising GA061 otherwise); renumbers
 * subsequent pages down by one server-side so the phone's own page count
 * never drifts from the authoritative one. */
export async function deleteCapturePageAction(token: string, pageNumber: number): Promise<DeleteCapturePageResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;

  const { data, error } = await getServiceRoleClient().rpc("delete_invoice_capture_page", {
    p_token_digest: hashCaptureToken(token),
    p_page_number: pageNumber,
  });
  if (error) return mapRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_remaining_page_count: number } | undefined;
  if (!row) return INVALID;

  return { ok: true, remainingPageCount: Number(row.out_remaining_page_count) };
}

export type ReorderCapturePagesResult = { ok: true } | CaptureFailure;

/** newPageOrder is the CURRENT page numbers listed in their NEW desired
 * order -- reorder_invoice_capture_pages itself validates it is exactly a
 * permutation of the session's existing pages (GA072 otherwise). */
export async function reorderCapturePagesAction(token: string, newPageOrder: number[]): Promise<ReorderCapturePagesResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;

  const { error } = await getServiceRoleClient().rpc("reorder_invoice_capture_pages", {
    p_token_digest: hashCaptureToken(token),
    p_new_page_order: newPageOrder,
  });
  if (error) return mapRpcError(error);

  return { ok: true };
}
