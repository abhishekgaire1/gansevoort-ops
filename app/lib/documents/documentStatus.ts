import { isAttemptStale, type AttemptTimingInfo } from "@/app/lib/documents/staleExtraction";
import type { PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * documents has no status column (see 20260811100018_documents.sql) --
 * "Processing / Needs Review / Extraction Failed / Extraction Stalled" is
 * always derived from the latest document_extractions row, never stored
 * redundantly. Shared by the receiving queue and the document detail page
 * so both surfaces agree on what a given attempt means.
 */
export type DocumentDisplayStatus = "PROCESSING" | "STALLED" | "NEEDS_REVIEW" | "FAILED";

export interface LatestAttemptForStatus extends AttemptTimingInfo {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
}

export function deriveDocumentStatus(latestAttempt: LatestAttemptForStatus | null, now: Date = new Date()): DocumentDisplayStatus {
  if (!latestAttempt) {
    // No attempt row exists at all (e.g. the attempt insert failed right
    // after a successful document upload) -- treated the same as a failed
    // attempt so the manager has a visible "Retry Extraction" action.
    return "FAILED";
  }

  if (latestAttempt.status === "SUCCEEDED") {
    return "NEEDS_REVIEW";
  }

  if (latestAttempt.status === "FAILED") {
    return "FAILED";
  }

  return isAttemptStale(latestAttempt, now) ? "STALLED" : "PROCESSING";
}

/**
 * Milestone 2A.2: the Receiving Queue's full workflow status, extending
 * DocumentDisplayStatus with the purchase_documents lifecycle. Still
 * nothing stored -- purchase_documents.status (when a row exists) is
 * simply layered on top of the same extraction-based derivation. Once a
 * purchase_document exists, its status always wins (DRAFT/
 * READY_FOR_VERIFICATION/VERIFIED) regardless of what a later extraction
 * retry's status is -- a document's business workflow state is no longer
 * about extraction once a draft has been started from it.
 */
export type ReceivingItemStatus = DocumentDisplayStatus | PurchaseDocumentStatus;

export function deriveReceivingItemStatus(
  latestAttempt: LatestAttemptForStatus | null,
  purchaseDocumentStatus: PurchaseDocumentStatus | null,
  now: Date = new Date()
): ReceivingItemStatus {
  if (purchaseDocumentStatus) {
    return purchaseDocumentStatus;
  }
  return deriveDocumentStatus(latestAttempt, now);
}
