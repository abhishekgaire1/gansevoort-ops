"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/invoiceCapture/storagePath";
import { CAPTURE_MAX_FILE_BYTES, CAPTURE_MAX_FILE_MB } from "@/app/lib/invoiceCapture/constants";
import { sniffMimeType } from "@/app/lib/files/sniffMimeType";
import { addDocumentPageRpc } from "@/app/lib/documents/addDocumentPageRpc";

/**
 * Multi-page (100127) desktop bridge, part 2: once page 1 of a phone
 * capture session has already gone through the normal initiateUpload/
 * finalizeDocumentUpload pipeline and a real documentId exists (see
 * TakePhotoWithPhoneFlow.tsx's handleContinue), every ADDITIONAL captured
 * page is added to that SAME document via this action -- never a second
 * document, never a client round-trip of the actual bytes (the desktop
 * browser only ever sees signed URLs; this reads the already-uploaded
 * capture-staging bytes directly, server-side, exactly once per page).
 *
 * Deliberately its own file, not documentUpload.ts -- addDocumentPageRpc
 * and the rest of the extraction/backend pipeline are owned elsewhere in
 * this same change; this file only bridges capture-staging bytes into
 * that RPC with the same rigor finalizeDocumentUpload already applies to
 * a directly-uploaded file (size limit, magic-byte sniff, SHA-256 -- never
 * trusting the phone's originally-declared content type alone twice).
 */

type BridgeFailureReason = "not_authorized" | "not_found" | "invalid_file_type" | "misconfigured";
export type AddCapturedPageToDocumentResult = { ok: true; pageId: string; replayed: boolean } | { ok: false; reason: BridgeFailureReason; message: string };

function buildPageStoragePath(organizationId: string, documentId: string, pageNumber: number, extension: string): string {
  return `org/${organizationId}/documents/${documentId}/page-${pageNumber}.${extension}`;
}

export async function addCapturedPageToDocumentAction(sessionId: string, documentId: string, pageNumber: number): Promise<AddCapturedPageToDocumentResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

  const supabase = getServiceRoleClient();
  const organizationId = auth.manager.organizationId;

  const { data: page } = await supabase
    .from("invoice_capture_pages")
    .select("storage_path")
    .eq("organization_id", organizationId)
    .eq("capture_session_id", sessionId)
    .eq("page_number", pageNumber)
    .maybeSingle();

  if (!page) {
    return { ok: false, reason: "not_found", message: "That captured page could not be found." };
  }

  const { data: blob, error: downloadError } = await supabase.storage.from(RECEIVING_DOCUMENTS_BUCKET).download(page.storage_path as string);
  if (downloadError || !blob) {
    return { ok: false, reason: "misconfigured", message: "Could not load the captured page. Try again." };
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  if (buffer.byteLength === 0) {
    return { ok: false, reason: "invalid_file_type", message: "The captured page appears to be empty." };
  }
  if (buffer.byteLength > CAPTURE_MAX_FILE_BYTES) {
    return { ok: false, reason: "invalid_file_type", message: `Photos must be ${CAPTURE_MAX_FILE_MB} MB or smaller.` };
  }

  const sniffedMimeType = sniffMimeType(buffer);
  if (!sniffedMimeType || (sniffedMimeType !== "image/jpeg" && sniffedMimeType !== "image/png")) {
    return { ok: false, reason: "invalid_file_type", message: "Unsupported photo format." };
  }

  const extension = sniffedMimeType === "image/png" ? "png" : "jpg";
  const path = buildPageStoragePath(organizationId, documentId, pageNumber, extension);

  const { createHash } = await import("node:crypto");
  const fileSha256 = createHash("sha256").update(buffer).digest("hex");

  const { error: uploadError } = await supabase.storage.from(RECEIVING_DOCUMENTS_BUCKET).upload(path, buffer, { contentType: sniffedMimeType, upsert: false });
  if (uploadError && !uploadError.message?.toLowerCase().includes("already exists")) {
    return { ok: false, reason: "misconfigured", message: "Could not save the captured page. Try again." };
  }

  try {
    const result = await addDocumentPageRpc(supabase, {
      organizationId,
      documentId,
      appUserId: auth.manager.appUserId,
      pageNumber,
      storagePath: path,
      contentType: sniffedMimeType,
      byteSize: buffer.byteLength,
      fileSha256,
    });
    return { ok: true, pageId: result.pageId, replayed: result.replayed };
  } catch {
    return { ok: false, reason: "misconfigured", message: "Could not add the captured page to the document. Try again." };
  }
}
