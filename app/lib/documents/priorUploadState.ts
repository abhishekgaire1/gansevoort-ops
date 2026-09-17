/**
 * Classifies a prior upload of the SAME file (same sha256) so the
 * "possible duplicate" prompt can reflect what actually happened to it,
 * rather than warning identically for a live invoice and one the manager
 * already discarded.
 *
 * The upload-duplicate check matches on file_sha256 against the append-only
 * `documents` table, so a re-upload always finds the prior row even after
 * its draft was discarded or the upload was removed. This module lets the
 * caller downgrade those superseded cases to a softer, honest FYI while
 * keeping the strong warning for a prior that is still live -- most
 * importantly a VERIFIED one, where re-uploading risks a duplicate of an
 * already-posted invoice.
 */

export type PriorUploadState =
  | "IN_PROGRESS" // uploaded, no purchase document created yet (still extracting/awaiting a draft)
  | "DRAFT" // an open, non-discarded draft exists
  | "READY_FOR_VERIFICATION" // submitted, awaiting the second review
  | "VERIFIED" // already verified/posted -- the strongest duplicate risk
  | "DISCARDED" // every draft revision was discarded
  | "REMOVED"; // the upload itself was removed/archived

/** Higher = more significant when several prior uploads of the same file
 * exist -- a live/verified prior must never be hidden behind a more recent
 * discarded one. */
export const PRIOR_STATE_SIGNIFICANCE: Record<PriorUploadState, number> = {
  VERIFIED: 6,
  READY_FOR_VERIFICATION: 5,
  DRAFT: 4,
  IN_PROGRESS: 3,
  DISCARDED: 2,
  REMOVED: 1,
};

export function classifyPriorUpload(input: { archived: boolean; purchaseDocumentStatuses: string[] }): PriorUploadState {
  if (input.archived) return "REMOVED";
  const statuses = input.purchaseDocumentStatuses;
  if (statuses.includes("VERIFIED")) return "VERIFIED";
  if (statuses.includes("READY_FOR_VERIFICATION")) return "READY_FOR_VERIFICATION";
  if (statuses.includes("DRAFT")) return "DRAFT";
  if (statuses.length > 0) return "DISCARDED"; // present but all DISCARDED
  return "IN_PROGRESS";
}

/** A superseded prior (discarded or removed) is something the manager
 * already dealt with -- the prompt becomes an FYI, and capture flows no
 * longer hard-block on it. */
export function isSupersededPriorUpload(state: PriorUploadState): boolean {
  return state === "DISCARDED" || state === "REMOVED";
}

export interface DuplicateUploadNotice {
  message: string;
  tone: "warning" | "info";
  /** Whether "Open Existing" is worth offering -- false for superseded
   * priors, where opening the discarded/removed document is a dead end. */
  showOpenExisting: boolean;
  /** Label for the button that proceeds with the upload anyway. */
  proceedLabel: string;
}

/** Builds the prompt copy for a prior-upload state. `uploadedAtLabel` is the
 * already-formatted upload time (the caller owns locale formatting). */
export function duplicateUploadNotice(state: PriorUploadState, uploadedAtLabel: string): DuplicateUploadNotice {
  switch (state) {
    case "VERIFIED":
      return {
        message: `This exact file was already uploaded and verified on ${uploadedAtLabel}. Uploading it again creates a separate document.`,
        tone: "warning",
        showOpenExisting: true,
        proceedLabel: "Upload Anyway",
      };
    case "READY_FOR_VERIFICATION":
      return {
        message: `This exact file was previously uploaded on ${uploadedAtLabel} and is awaiting verification.`,
        tone: "warning",
        showOpenExisting: true,
        proceedLabel: "Upload Anyway",
      };
    case "DRAFT":
      return {
        message: `This exact file was previously uploaded on ${uploadedAtLabel} and has an open draft.`,
        tone: "warning",
        showOpenExisting: true,
        proceedLabel: "Upload Anyway",
      };
    case "IN_PROGRESS":
      return {
        message: `This exact file was previously uploaded on ${uploadedAtLabel}.`,
        tone: "warning",
        showOpenExisting: true,
        proceedLabel: "Upload Anyway",
      };
    case "DISCARDED":
      return {
        message: `You previously uploaded this file on ${uploadedAtLabel}, but that draft was discarded. You can upload it again.`,
        tone: "info",
        showOpenExisting: false,
        proceedLabel: "Continue Upload",
      };
    case "REMOVED":
      return {
        message: `You previously uploaded this file on ${uploadedAtLabel}, but that upload was removed. You can upload it again.`,
        tone: "info",
        showOpenExisting: false,
        proceedLabel: "Continue Upload",
      };
  }
}
