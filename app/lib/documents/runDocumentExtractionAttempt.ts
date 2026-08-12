import "server-only";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storagePath";
import { GeminiProvider, sanitizeGeminiRawResponse } from "@/app/lib/ai/providers/gemini";
import { AIProviderError } from "@/app/lib/ai/provider";
import { runInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/runInvoiceExtraction";
import { sniffMimeType } from "@/app/lib/files/sniffMimeType";

const UNKNOWN_ERROR_CODE = "UNKNOWN";

/**
 * Executor-independent by construction: identically callable from after()
 * on the finalize happy path, a manual "Retry Extraction" action, or (only
 * if real usage later shows it's needed) a scheduled recovery sweep --
 * none of that changes this function. The atomic claim below is what
 * actually guarantees exactly one caller ever runs a given attempt; this
 * function does not assume it's the only invocation in flight.
 */
export async function runDocumentExtractionAttempt(attemptId: string): Promise<void> {
  const serviceClient = getServiceRoleClient();

  const { data: claimed, error: claimError } = await serviceClient
    .from("document_extractions")
    .update({ status: "RUNNING", started_at: new Date().toISOString() })
    .eq("id", attemptId)
    .eq("status", "PENDING")
    .select("id, organization_id, document_id, model")
    .maybeSingle();

  if (claimError || !claimed) {
    // Lost the race, already claimed/terminal, or stale-terminalized out
    // from under us -- nothing for this caller to do.
    return;
  }

  try {
    const { data: document, error: documentError } = await serviceClient
      .from("documents")
      .select("storage_path")
      .eq("id", claimed.document_id)
      .eq("organization_id", claimed.organization_id)
      .single();

    if (documentError || !document) {
      throw new Error(`document ${claimed.document_id} not found for attempt ${attemptId}`);
    }

    const { data: blob, error: downloadError } = await serviceClient.storage
      .from(RECEIVING_DOCUMENTS_BUCKET)
      .download(document.storage_path);

    if (downloadError || !blob) {
      throw new Error(`could not download document ${claimed.document_id} for attempt ${attemptId}`);
    }

    const buffer = Buffer.from(await blob.arrayBuffer());
    const mimeType = sniffMimeType(buffer);
    if (!mimeType) {
      throw new Error(`document ${claimed.document_id} no longer matches an accepted file signature`);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }

    const provider = new GeminiProvider(apiKey);
    const result = await runInvoiceExtraction(provider, { fileBytesBase64: buffer.toString("base64"), mimeType }, claimed.model);

    await serviceClient
      .from("document_extractions")
      .update({
        status: "SUCCEEDED",
        completed_at: new Date().toISOString(),
        normalized_extraction: result.normalized,
        review_flags: result.issues,
        provider_metadata: sanitizeGeminiRawResponse(result.raw),
      })
      .eq("id", attemptId);
  } catch (err) {
    const { code, message } = mapExtractionError(err);
    await serviceClient
      .from("document_extractions")
      .update({
        status: "FAILED",
        completed_at: new Date().toISOString(),
        error_code: code,
        error_message: message.slice(0, 2000),
      })
      .eq("id", attemptId);
  }
}

function mapExtractionError(err: unknown): { code: string; message: string } {
  if (err instanceof AIProviderError) {
    return { code: err.code, message: err.message };
  }
  return { code: UNKNOWN_ERROR_CODE, message: err instanceof Error ? err.message : "Unknown error" };
}
