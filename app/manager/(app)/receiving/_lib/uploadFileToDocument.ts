import { createBrowserClient } from "@supabase/ssr";
import {
  initiateDocumentUpload,
  finalizeDocumentUpload,
  type InitiateDocumentUploadResult,
  type FinalizeDocumentUploadResult,
  type DeclaredDocumentType,
} from "@/app/actions/documentUpload";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storageConstants";

/**
 * The shared "a File becomes a real, extraction-ready document" sequence
 * (Direct Scanner Intake milestone, Part 14: "The scanner result should
 * enter THIS existing flow... Do not bypass file validation, MIME/
 * magic-byte validation, hashing, private Storage, finalization RPC,
 * extraction attempt creation, idempotency, audit"). Extracted from
 * UploadDocumentForm so the Scan Invoice flow can call the EXACT same
 * initiate -> browser-PUT -> finalize sequence a manually-picked file
 * already goes through -- never a parallel/duplicate pipeline. Once a
 * File exists (whether from <input type=file> or from downloading the
 * scanner bridge's assembled PDF), everything from here down is
 * identical.
 */

export type InitiatedUpload = Extract<InitiateDocumentUploadResult, { ok: true }>;

export async function sha256Hex(file: File): Promise<string | undefined> {
  try {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Only used for a non-blocking duplicate hint -- safe to skip.
    return undefined;
  }
}

export async function initiateUpload(
  file: File,
  vendorId: string,
  documentType: DeclaredDocumentType
): Promise<InitiateDocumentUploadResult> {
  const clientComputedSha256 = await sha256Hex(file);
  return initiateDocumentUpload({
    filename: file.name,
    declaredContentType: file.type,
    vendorId,
    declaredDocumentType: documentType,
    clientComputedSha256,
  });
}

export async function uploadAndFinalize(
  file: File,
  initiated: InitiatedUpload,
  vendorId: string,
  documentType: DeclaredDocumentType,
  supabaseUrl: string,
  supabasePublishableKey: string
): Promise<FinalizeDocumentUploadResult | { ok: false; reason: "upload_failed"; message: string }> {
  const supabase = createBrowserClient(supabaseUrl, supabasePublishableKey);
  const { error: uploadError } = await supabase.storage.from(RECEIVING_DOCUMENTS_BUCKET).uploadToSignedUrl(initiated.path, initiated.token, file);

  if (uploadError) {
    return { ok: false, reason: "upload_failed", message: "Upload failed. Try again." };
  }

  return finalizeDocumentUpload({
    documentId: initiated.documentId,
    declaredContentType: file.type,
    originalFilename: file.name,
    vendorId,
    declaredDocumentType: documentType,
  });
}
