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

type CaptureFailureReason = "invalid" | "expired" | "unavailable" | "invalid_file_type" | "misconfigured";
type CaptureFailure = { ok: false; reason: CaptureFailureReason; message: string };

const INVALID: CaptureFailure = { ok: false, reason: "invalid", message: "This capture link is not valid." };
const EXPIRED: CaptureFailure = { ok: false, reason: "expired", message: "This capture link has expired." };
const UNAVAILABLE: CaptureFailure = { ok: false, reason: "unavailable", message: "This capture session is no longer available." };

function mapRpcError(error: { code?: string; message: string }): CaptureFailure {
  if (error.code === "GA059") return INVALID;
  if (error.code === "GA060") return EXPIRED;
  if (error.code === "GA061") return UNAVAILABLE;
  return { ok: false, reason: "misconfigured", message: "Something went wrong. Try again." };
}

export type CapturePhoneStatus = "WAITING" | "RECEIVED" | "CANCELLED" | "CONTINUED" | "EXPIRED";

export type GetCapturePhoneStatusResult = { ok: true; status: CapturePhoneStatus } | CaptureFailure;

export async function getCapturePhoneStatusAction(token: string): Promise<GetCapturePhoneStatusResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;

  const { data, error } = await getServiceRoleClient().rpc("get_invoice_capture_session_phone", { p_token_digest: hashCaptureToken(token) });
  if (error) return { ok: false, reason: "misconfigured", message: "Something went wrong. Try again." };
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_status: string } | undefined;
  if (!row) return INVALID;

  return { ok: true, status: row.out_status as CapturePhoneStatus };
}

export type BeginCaptureUploadResult = { ok: true; path: string; signedUrl: string; uploadToken: string } | CaptureFailure;

/** Mints a signed upload URL scoped to the EXACT expected staging object
 * for this session's single page (Part 31) -- never a broader bucket
 * grant. declaredContentType is validated against the narrow phone-
 * capture allowlist before a URL is ever minted (server-authoritative,
 * never trusting the browser's File.type alone at finalize time -- see
 * finishCaptureUploadAction below, which re-sniffs the actual bytes). */
export async function beginCaptureUploadAction(token: string, declaredContentType: string): Promise<BeginCaptureUploadResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;
  if (!(CAPTURE_ACCEPTED_MIME_TYPES as readonly string[]).includes(declaredContentType)) {
    return { ok: false, reason: "invalid_file_type", message: "Unsupported photo format." };
  }

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.rpc("begin_invoice_capture_upload", { p_token_digest: hashCaptureToken(token), p_page_number: 1 });
  if (error) return mapRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_session_id: string; out_organization_id: string } | undefined;
  if (!row) return INVALID;

  const extension = declaredContentType === "image/png" ? "png" : "jpg";
  const path = buildCaptureStoragePath(row.out_organization_id, row.out_session_id, 1, extension);

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
export async function finishCaptureUploadAction(token: string, declaredContentType: string): Promise<FinishCaptureUploadResult> {
  if (!isPlausibleCaptureToken(token)) return INVALID;

  const supabase = getServiceRoleClient();
  const digest = hashCaptureToken(token);

  const { data: statusData, error: statusError } = await supabase.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
  if (statusError) return { ok: false, reason: "misconfigured", message: "Something went wrong. Try again." };
  const statusRow = (Array.isArray(statusData) ? statusData[0] : statusData) as { out_session_id: string; out_status: string } | undefined;
  if (!statusRow) return INVALID;
  if (statusRow.out_status === "EXPIRED") return EXPIRED;
  if (statusRow.out_status !== "WAITING") return UNAVAILABLE;

  // Re-derive the exact same path the signed upload URL was scoped to --
  // never trusts a client-supplied path.
  const { data: sessionOrgData } = await supabase.from("invoice_capture_sessions").select("organization_id").eq("id", statusRow.out_session_id).single();
  const organizationId = sessionOrgData?.organization_id as string | undefined;
  if (!organizationId) return INVALID;

  const extension = declaredContentType === "image/png" ? "png" : "jpg";
  const path = buildCaptureStoragePath(organizationId, statusRow.out_session_id, 1, extension);

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
    p_page_number: 1,
    p_storage_path: path,
    p_content_type: sniffedMimeType,
    p_byte_size: buffer.byteLength,
    p_content_hash: contentHash,
  });
  if (recordError) return mapRpcError(recordError);

  return { ok: true };
}
