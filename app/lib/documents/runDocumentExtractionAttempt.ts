import "server-only";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storagePath";
import { listDocumentPagesRpc } from "@/app/lib/documents/listDocumentPagesRpc";
import { sanitizeGeminiRawResponse } from "@/app/lib/ai/providers/gemini";
import { AIProviderError } from "@/app/lib/ai/provider";
import { runInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/runInvoiceExtraction";
import type { ExtractInvoiceFile } from "@/app/lib/ai/tasks/invoiceExtraction/extract";
import { executeAITask, AIProviderUnavailableError } from "@/app/lib/ai/router/executeAITask";
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
    .select("id, organization_id, document_id, provider, model")
    .maybeSingle();

  if (claimError || !claimed) {
    // Lost the race, already claimed/terminal, or stale-terminalized out
    // from under us -- nothing for this caller to do.
    return;
  }

  try {
    // Multi-page capture (100127): document_pages always has at least one
    // row (page 1, whether from finalize_document_upload's own trigger or
    // the migration's one-time backfill) -- ordered by page_number so
    // every file below is handed to extraction in the correct page order.
    const docPages = await listDocumentPagesRpc(serviceClient, claimed.organization_id, claimed.document_id);
    if (docPages.length === 0) {
      throw new Error(`document ${claimed.document_id} has no pages for attempt ${attemptId}`);
    }

    const files: ExtractInvoiceFile[] = [];
    for (const page of docPages) {
      const { data: blob, error: downloadError } = await serviceClient.storage.from(RECEIVING_DOCUMENTS_BUCKET).download(page.storagePath);
      if (downloadError || !blob) {
        throw new Error(`could not download document ${claimed.document_id} page ${page.pageNumber} for attempt ${attemptId}`);
      }
      const buffer = Buffer.from(await blob.arrayBuffer());
      const mimeType = sniffMimeType(buffer);
      if (!mimeType) {
        throw new Error(`document ${claimed.document_id} page ${page.pageNumber} no longer matches an accepted file signature`);
      }
      files.push({ bytesBase64: buffer.toString("base64"), mimeType });
    }

    // AI Configuration + Usage/Cost Tracking milestone: provider/model
    // were already resolved and frozen onto this row at attempt-creation
    // time (documentUpload.ts/documentExtraction.ts) -- never re-resolved
    // here, so this call always uses exactly what the attempt started
    // with (Part 49-50). executeAITask is the one place that instantiates
    // the provider adapter, times the call, and records the durable usage
    // event -- this function no longer touches GEMINI_API_KEY directly.
    const result = await executeAITask({
      organizationId: claimed.organization_id,
      task: "INVOICE_EXTRACTION",
      provider: claimed.provider,
      model: claimed.model,
      requestKey: attemptId,
      sourceType: "document_extraction",
      sourceId: attemptId,
      run: async (provider, model) => {
        const extraction = await runInvoiceExtraction(provider, { files }, model);
        return { data: extraction, raw: extraction.raw, model: extraction.model, provider: extraction.provider };
      },
    });

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
  if (err instanceof AIProviderUnavailableError) {
    return { code: "PROVIDER_UNAVAILABLE", message: err.message };
  }
  return { code: UNKNOWN_ERROR_CODE, message: err instanceof Error ? err.message : "Unknown error" };
}
