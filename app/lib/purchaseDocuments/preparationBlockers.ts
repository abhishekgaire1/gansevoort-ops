// Deliberately NOT "server-only" -- pure helpers over already-fetched
// PreparationStatus data, shared by the client wizard (Step 3's gate and
// visible blocker list) and server code alike, the same way
// computeReceivingPrefill.ts is shared.

export interface PreparationBlocker {
  /** Null for a document-level blocker (delivery verifier, document
   * date) rather than a specific line. */
  lineKey: string | null;
  description: string | null;
  reason: string;
}

/** The blockers Step 3's Continue gate (and its visible blocker list) use
 * -- line-level only. Document-level blockers (lineKey null) surface on
 * Step 4, next to the controls that resolve them. */
export function lineLevelBlockers(blockers: PreparationBlocker[]): PreparationBlocker[] {
  return blockers.filter((blocker) => blocker.lineKey !== null);
}
