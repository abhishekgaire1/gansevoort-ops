import { isAttemptStale, type AttemptTimingInfo } from "@/app/lib/documents/staleExtraction";

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
