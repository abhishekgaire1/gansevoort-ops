import type { DocumentDisplayStatus } from "@/app/lib/documents/documentStatus";

/**
 * Single source of truth for "should the client keep polling for status
 * updates." Only PROCESSING represents an attempt that could still change
 * on its own, without any manager action, purely because the background
 * extraction finishes -- STALLED/FAILED/NEEDS_REVIEW are all states a
 * manager must act on (retry/review), so continuing to poll after reaching
 * one of them would just be wasted network traffic.
 *
 * Shared by the document detail page (a single status) and the receiving
 * queue (any one of several visible documents' statuses) so both surfaces
 * use the identical rule for when to stop.
 *
 * No explicit max-poll-count/backoff is needed to satisfy "do not poll
 * forever": a PENDING/RUNNING attempt that never resolves is itself
 * time-bounded -- deriveDocumentStatus() already re-evaluates staleness
 * (see staleExtraction.ts) against the current wall-clock time on every
 * call, so a stuck attempt stops being reported as PROCESSING (and this
 * function stops returning true) once the existing 5-minute stale
 * threshold passes, with no change needed here.
 */
export function shouldPollForStatuses(statuses: DocumentDisplayStatus[]): boolean {
  return statuses.includes("PROCESSING");
}
