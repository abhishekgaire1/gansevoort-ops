"use server";

import { after } from "next/server";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { buildStoragePath, RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storagePath";
import { runDocumentExtractionAttempt } from "@/app/lib/documents/runDocumentExtractionAttempt";
import {
  finalizeDocumentUploadRpc,
  DocumentIdentityConflictError,
  type FinalizeDocumentUploadRpcResult,
} from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { resolveGeminiModel } from "@/app/lib/ai/config";
import { ACCEPTED_MIME_TYPES, extensionForMimeType, sniffMimeType } from "@/app/lib/files/sniffMimeType";
import { VendorNotActiveError } from "@/app/lib/purchaseDocuments/errors";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DeclaredDocumentType = "INVOICE" | "RECEIPT" | "CREDIT_MEMO";

/** Shared by initiate and finalize -- a plain active/same-org check, no
 * RPC needed for a single-table read. finalize_document_upload itself
 * re-validates at insert time as the authoritative gate; this is purely
 * fail-fast so a manager finds out before minting a signed upload URL. */
async function isVendorActiveInOrganization(
  serviceClient: SupabaseClient,
  vendorId: string,
  organizationId: string
): Promise<boolean> {
  const { data } = await serviceClient
    .from("vendors")
    .select("id")
    .eq("id", vendorId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  return !!data;
}

/**
 * Direct browser-to-Storage upload (not a Server Action body upload): the
 * browser never receives the service-role key, only a path-scoped,
 * single-use signed upload token minted here after auth. A `documents` row
 * is inserted only at finalize, never here -- "a documents row exists"
 * always means "this upload was verified and completed," no half-finished
 * rows to reason about.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);

/**
 * TEMPORARY diagnostic logging (investigating a real /manager/receiving
 * upload failure) -- remove once resolved. Server-side only (this whole
 * file is "use server"), so nothing here ever reaches the browser.
 *
 * Deliberately logs ONLY: stage name, a safe error code/message, documentId,
 * and boolean success/reached flags. Never the service-role key, Gemini API
 * key, signed upload token, signed URLs, passwords/PINs, or file bytes --
 * none of those are ever passed into `info`.
 */
function logUploadDiagnostic(stage: string, info: Record<string, string | number | boolean | null | undefined>): void {
  console.log(`[document-upload:${stage}]`, info);
}

/** Extracts only a code + message from an unknown error value -- works for
 * PostgrestError (.code/.message), Supabase StorageError (.message,
 * sometimes .status/.statusCode), and plain Error/thrown values alike.
 * Never logs the full error object (which could carry request/response
 * internals), only these two safe string fields. */
function describeError(error: unknown): { code: string | null; message: string | null } {
  if (!error || typeof error !== "object") {
    return { code: null, message: null };
  }
  const err = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const code =
    typeof err.code === "string"
      ? err.code
      : typeof err.status === "number" || typeof err.status === "string"
        ? String(err.status)
        : typeof err.statusCode === "number" || typeof err.statusCode === "string"
          ? String(err.statusCode)
          : null;
  return { code, message: typeof err.message === "string" ? err.message : null };
}

export interface InitiateDocumentUploadInput {
  filename: string;
  declaredContentType: string;
  /** Declared by the manager BEFORE the file picker -- vendor-first
   * intake. Must be an active vendor in the manager's own organization. */
  vendorId: string;
  /** Declared by the manager BEFORE the file picker, alongside vendorId. */
  declaredDocumentType: DeclaredDocumentType;
  /** Optional client-computed hint (crypto.subtle.digest), used ONLY for a
   * non-blocking "possible duplicate" prompt -- never trusted for the
   * authoritative record, which is always recomputed server-side at
   * finalize from the actually-downloaded bytes. */
  clientComputedSha256?: string;
}

export interface PossibleDuplicateDocument {
  documentId: string;
  uploadedAt: string;
}

export type InitiateDocumentUploadResult =
  | {
      ok: true;
      documentId: string;
      path: string;
      signedUrl: string;
      token: string;
      possibleDuplicate: PossibleDuplicateDocument | null;
    }
  | { ok: false; reason: "not_authorized" | "invalid_file_type" | "invalid_vendor" | "misconfigured"; message: string };

export async function initiateDocumentUpload(input: InitiateDocumentUploadInput): Promise<InitiateDocumentUploadResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  if (!ACCEPTED_MIME_TYPES.has(input.declaredContentType)) {
    return {
      ok: false,
      reason: "invalid_file_type",
      message: "Unsupported file type. Only JPEG, PNG, and PDF are accepted.",
    };
  }

  const serviceClient = getServiceRoleClient();

  if (!(await isVendorActiveInOrganization(serviceClient, input.vendorId, auth.manager.organizationId))) {
    return { ok: false, reason: "invalid_vendor", message: "Select an active vendor before uploading." };
  }

  const documentId = crypto.randomUUID();
  const path = buildStoragePath(auth.manager.organizationId, documentId, extensionForMimeType(input.declaredContentType));

  const { data: uploadUrlData, error: uploadUrlError } = await serviceClient.storage
    .from(RECEIVING_DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path);

  {
    const { code, message } = describeError(uploadUrlError);
    logUploadDiagnostic("signed_upload_creation", {
      documentId,
      success: !uploadUrlError && !!uploadUrlData,
      errorCode: code,
      errorMessage: message,
    });
  }

  if (uploadUrlError || !uploadUrlData) {
    return { ok: false, reason: "misconfigured", message: "Could not start the upload. Try again." };
  }

  let possibleDuplicate: PossibleDuplicateDocument | null = null;
  const hashHint = input.clientComputedSha256?.toLowerCase();
  if (hashHint && /^[0-9a-f]{64}$/.test(hashHint)) {
    const { data: existing } = await serviceClient
      .from("documents")
      .select("id, created_at")
      .eq("organization_id", auth.manager.organizationId)
      .eq("file_sha256", hashHint)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      possibleDuplicate = { documentId: existing.id, uploadedAt: existing.created_at };
    }
  }

  return {
    ok: true,
    documentId,
    path,
    signedUrl: uploadUrlData.signedUrl,
    token: uploadUrlData.token,
    possibleDuplicate,
  };
}

export interface FinalizeDocumentUploadInput {
  documentId: string;
  declaredContentType: string;
  originalFilename: string;
  /** Re-supplied here (initiate doesn't persist anything) and re-validated
   * by finalize_document_upload itself as the authoritative gate. */
  vendorId: string;
  declaredDocumentType: DeclaredDocumentType;
}

export type FinalizeDocumentUploadResult =
  | { ok: true; documentId: string; replayed: boolean }
  | {
      ok: false;
      reason: "not_authorized" | "invalid_file_type" | "invalid_vendor" | "not_found" | "conflict" | "misconfigured";
      message: string;
    };

export async function finalizeDocumentUpload(input: FinalizeDocumentUploadInput): Promise<FinalizeDocumentUploadResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  if (!ACCEPTED_MIME_TYPES.has(input.declaredContentType)) {
    return { ok: false, reason: "invalid_file_type", message: "Unsupported file type." };
  }

  // Re-derived server-side, exactly as at initiate -- the client's `path`
  // is never accepted as input here.
  const path = buildStoragePath(auth.manager.organizationId, input.documentId, extensionForMimeType(input.declaredContentType));

  const serviceClient = getServiceRoleClient();

  // Tracks whether the atomic DB finalization (the finalize_document_upload
  // RPC, which inserts documents + its first document_extractions row in
  // ONE transaction) has already succeeded. Once true, this function must
  // NEVER delete the Storage object on a later failure -- the document is
  // already durably persisted at that point, and Storage cleanup is only
  // ever appropriate for a genuinely invalid/abandoned upload that never
  // became a real document.
  let dbFinalized = false;
  let rpcResult: FinalizeDocumentUploadRpcResult;

  // Tracks which stage is in flight so the catch block below can attribute
  // an unexpected exception to the right stage without guessing. TEMPORARY,
  // alongside the diagnostic logging itself.
  let currentStage = "finalize_storage_download";

  try {
    const { data: blob, error: downloadError } = await serviceClient.storage.from(RECEIVING_DOCUMENTS_BUCKET).download(path);
    {
      const { code, message } = describeError(downloadError);
      // A failure here is also the strongest server-side signal for stage
      // 2 (the browser's direct Storage upload) never having landed an
      // object at this path -- that stage itself runs client-side and
      // can't be logged from the server.
      logUploadDiagnostic(currentStage, {
        documentId: input.documentId,
        success: !downloadError && !!blob,
        errorCode: code,
        errorMessage: message,
      });
    }
    if (downloadError || !blob) {
      return { ok: false, reason: "not_found", message: "The uploaded file could not be found. Please upload again." };
    }

    const buffer = Buffer.from(await blob.arrayBuffer());

    currentStage = "validation";
    if (buffer.byteLength === 0) {
      logUploadDiagnostic(currentStage, { documentId: input.documentId, success: false, errorCode: "EMPTY_FILE", errorMessage: null });
      await removeUploadedObject(serviceClient, path);
      return { ok: false, reason: "invalid_file_type", message: "The uploaded file is empty." };
    }
    if (buffer.byteLength > MAX_FILE_BYTES) {
      logUploadDiagnostic(currentStage, {
        documentId: input.documentId,
        success: false,
        errorCode: "FILE_TOO_LARGE",
        errorMessage: `byteLength ${buffer.byteLength} exceeds ${MAX_FILE_BYTES}`,
      });
      await removeUploadedObject(serviceClient, path);
      return { ok: false, reason: "invalid_file_type", message: `Invoice files must be ${MAX_FILE_MB} MB or smaller.` };
    }

    const sniffedMimeType = sniffMimeType(buffer);
    if (!sniffedMimeType || !ACCEPTED_MIME_TYPES.has(sniffedMimeType)) {
      logUploadDiagnostic(currentStage, {
        documentId: input.documentId,
        success: false,
        errorCode: "UNSUPPORTED_MIME_TYPE",
        errorMessage: "magic-byte sniff did not match an accepted type",
      });
      await removeUploadedObject(serviceClient, path);
      return {
        ok: false,
        reason: "invalid_file_type",
        message: "Unsupported file type. Only JPEG, PNG, and PDF are accepted.",
      };
    }
    logUploadDiagnostic(currentStage, { documentId: input.documentId, success: true, byteLength: buffer.byteLength, sniffedMimeType });

    const fileSha256 = await sha256Hex(buffer);

    currentStage = "finalize_rpc";
    logUploadDiagnostic(currentStage, { documentId: input.documentId, rpcReached: true });

    rpcResult = await finalizeDocumentUploadRpc(serviceClient, {
      documentId: input.documentId,
      organizationId: auth.manager.organizationId,
      uploadedByAppUserId: auth.manager.appUserId,
      storagePath: path,
      originalFilename: input.originalFilename,
      contentType: sniffedMimeType,
      byteSize: buffer.byteLength,
      fileSha256,
      provider: "gemini",
      model: resolveGeminiModel(),
      vendorId: input.vendorId,
      declaredDocumentType: input.declaredDocumentType,
    });

    logUploadDiagnostic(currentStage, {
      documentId: input.documentId,
      rpcReached: true,
      success: true,
      replayed: rpcResult.replayed,
    });

    dbFinalized = true;
  } catch (err) {
    const { code, message } = describeError(err);
    logUploadDiagnostic(currentStage, {
      documentId: input.documentId,
      success: false,
      rpcReached: currentStage === "finalize_rpc",
      errorCode: code ?? (err instanceof DocumentIdentityConflictError ? "DOCUMENT_IDENTITY_CONFLICT" : null),
      errorMessage: message ?? (err instanceof Error ? err.message : null),
    });

    if (err instanceof DocumentIdentityConflictError) {
      // documentId already refers to a DIFFERENT, already-persisted
      // document -- the RPC modified nothing, so neither do we: the
      // existing row and its Storage object are left completely untouched.
      return {
        ok: false,
        reason: "conflict",
        message: "This upload no longer matches a previously finalized document. Please upload again.",
      };
    }
    if (err instanceof VendorNotActiveError) {
      // The vendor was deactivated between initiate and finalize -- a
      // genuinely invalid upload, same category as bad MIME/size, so it
      // still falls through to the cleanup below.
      if (!dbFinalized) {
        await removeUploadedObject(serviceClient, path);
      }
      return { ok: false, reason: "invalid_vendor", message: "The selected vendor is no longer active. Choose a different vendor and upload again." };
    }
    if (!dbFinalized) {
      await removeUploadedObject(serviceClient, path);
    }
    return { ok: false, reason: "misconfigured", message: "Could not finish the upload. Try again." };
  }

  // Scheduling is best-effort and strictly happens AFTER durable
  // persistence: a failure here (e.g. after() itself throwing) must never
  // roll back or delete anything already committed. The existing
  // stale-attempt/retry path (retryDocumentExtraction) recovers a PENDING
  // attempt whose after() invocation never actually ran.
  try {
    logUploadDiagnostic("extraction_scheduling", { documentId: rpcResult.documentId, attemptId: rpcResult.attemptId, scheduled: true });
    after(() => runDocumentExtractionAttempt(rpcResult.attemptId));
  } catch (err) {
    const { code, message } = describeError(err);
    logUploadDiagnostic("extraction_scheduling", {
      documentId: rpcResult.documentId,
      scheduled: false,
      errorCode: code,
      errorMessage: message ?? (err instanceof Error ? err.message : null),
    });
    // Nothing to do here -- the detail page's Retry Extraction handles it.
  }

  return { ok: true, documentId: rpcResult.documentId, replayed: rpcResult.replayed };
}

async function removeUploadedObject(serviceClient: SupabaseClient, path: string): Promise<void> {
  await serviceClient.storage.from(RECEIVING_DOCUMENTS_BUCKET).remove([path]);
}

async function sha256Hex(buffer: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buffer).digest("hex");
}
