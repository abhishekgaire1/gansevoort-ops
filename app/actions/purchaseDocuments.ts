"use server";

import { after } from "next/server";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { classifyPurchaseDocumentLines } from "@/app/lib/itemMaster/classifyPurchaseDocumentLines";
import { getPreparationStatus, type PreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import { hasSiblingRevisionAlreadyPosted } from "@/app/lib/purchaseDocuments/amendmentPostingStatus";
import { getPurchaseDocumentReviewSummary as getReviewSummary, type PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import { getReceiptHistory, type ReceiptHistoryEntry } from "@/app/lib/purchaseDocuments/getReceiptHistory";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { saveReviewCorrectionsRpc } from "@/app/lib/purchaseDocuments/saveReviewCorrectionsRpc";
import { saveReviewProposalsRpc } from "@/app/lib/purchaseDocuments/saveReviewProposalsRpc";
import type { MappingProposals, ReceivingProposals } from "@/app/lib/purchaseDocuments/reviewProposals";
import { returnPurchaseDocumentToDraftRpc } from "@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";
import { discardPurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/discardPurchaseDocumentDraftRpc";
import { withdrawPurchaseDocumentSubmissionRpc } from "@/app/lib/purchaseDocuments/withdrawPurchaseDocumentSubmissionRpc";
import {
  findPossibleDuplicatePurchaseDocuments,
  type PossibleDuplicatePurchaseDocument,
} from "@/app/lib/purchaseDocuments/duplicateDetection";
import {
  NotPreparerError,
  CannotSelfVerifyError,
  StaleVersionError,
  VerifiedLockedError,
  VendorNotActiveError,
  PreparationIncompleteError,
  ReviewProposalsConflictError,
  ReviewProposalsOwnedElsewhereError,
  StaleReviewProposalsError,
} from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentStatus, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";

/** Manager-facing only -- never the raw RPC error text. */
function safeMessage(err: unknown): string {
  if (err instanceof NotPreparerError) return "Only the manager who uploaded this document can make this change.";
  if (err instanceof CannotSelfVerifyError) return "Another manager must verify this document.";
  if (err instanceof StaleVersionError) return "This document was updated elsewhere. Reload to see the latest version.";
  if (err instanceof VerifiedLockedError) return "This document is verified and can no longer be changed.";
  if (err instanceof VendorNotActiveError) return "The selected vendor is not active.";
  if (err instanceof PreparationIncompleteError) {
    return "This document isn't ready for final review yet -- every line needs a confirmed item mapping, and inventory lines need receiving quantities recorded first.";
  }
  if (err instanceof ReviewProposalsConflictError) {
    return "This final review changed in another tab. Reload the latest review before continuing.";
  }
  if (err instanceof ReviewProposalsOwnedElsewhereError) {
    return "Another manager already has pending review corrections on this document. Coordinate with them, or have them finish or release the review.";
  }
  if (err instanceof StaleReviewProposalsError) {
    return "This review belongs to an earlier submission. Reload the current submission.";
  }
  return "Something went wrong. Try again.";
}

/** Every business-rule error this module knows how to translate into a
 * specific manager-facing message. Anything else is a genuinely
 * unexpected failure (a constraint violation, a bad cast, a bug) -- see
 * logIfUnexpected below for why those must never be silently discarded. */
function isKnownPurchaseDocumentError(err: unknown): boolean {
  return (
    err instanceof NotPreparerError ||
    err instanceof CannotSelfVerifyError ||
    err instanceof StaleVersionError ||
    err instanceof VerifiedLockedError ||
    err instanceof VendorNotActiveError ||
    err instanceof PreparationIncompleteError ||
    err instanceof ReviewProposalsConflictError ||
    err instanceof ReviewProposalsOwnedElsewhereError ||
    err instanceof StaleReviewProposalsError
  );
}

/** The manager-facing message can stay friendly, but an UNEXPECTED error
 * (not one of the typed business-rule errors above) must never just
 * vanish behind "Something went wrong" -- that's exactly what let a real
 * foreign-key bug (20260811100054's confirmed-invoice-unit FK breaking
 * every delete-and-reinsert save/submit) hide for as long as it did.
 * Logs the actual Postgres/RPC error server-side for diagnosis; a known
 * business-rule rejection (e.g. PreparationIncompleteError, expected and
 * already explained to the manager) is not worth logging as a warning. */
function logIfUnexpected(actionName: string, err: unknown, context: Record<string, unknown>): void {
  if (!isKnownPurchaseDocumentError(err)) {
    console.error(`${actionName}: unexpected error`, { ...context, error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err });
  }
}

function reasonFor(
  err: unknown
):
  | "not_preparer"
  | "cannot_self_verify"
  | "stale"
  | "locked"
  | "invalid_vendor"
  | "preparation_incomplete"
  | "review_conflict"
  | "review_owned_elsewhere"
  | "stale_review"
  | "misconfigured" {
  if (err instanceof NotPreparerError) return "not_preparer";
  if (err instanceof CannotSelfVerifyError) return "cannot_self_verify";
  if (err instanceof StaleVersionError) return "stale";
  if (err instanceof VerifiedLockedError) return "locked";
  if (err instanceof VendorNotActiveError) return "invalid_vendor";
  if (err instanceof PreparationIncompleteError) return "preparation_incomplete";
  if (err instanceof ReviewProposalsConflictError) return "review_conflict";
  if (err instanceof ReviewProposalsOwnedElsewhereError) return "review_owned_elsewhere";
  if (err instanceof StaleReviewProposalsError) return "stale_review";
  return "misconfigured";
}

type FailureReason =
  | "not_authorized"
  | "not_preparer"
  | "cannot_self_verify"
  | "stale"
  | "locked"
  | "invalid_vendor"
  | "preparation_incomplete"
  | "review_conflict"
  | "review_owned_elsewhere"
  | "stale_review"
  | "misconfigured";

/** Best-effort, fire-and-forget scheduling -- mirrors documentUpload.ts's
 * extraction-scheduling shape. Called after submit, review-correction save,
 * and verify (the three points that can produce a STALE or never-classified
 * line per plan §4) -- never from withdraw/return, which only send the
 * document back to DRAFT for a fresh classification opportunity at its
 * next submit. A failure here must never surface as a failure of the
 * action that scheduled it; the page-load recovery check and the manual
 * "Run Item Matching" button both independently pick up anything missed. */
function scheduleClassification(purchaseDocumentId: string, organizationId: string): void {
  try {
    after(() => classifyPurchaseDocumentLines(purchaseDocumentId, organizationId));
  } catch {
    // Nothing to do here -- the item mapping panel's own recovery check
    // and manual "Run Item Matching" button cover this case.
  }
}

export type CreateOrOpenPurchaseDocumentDraftResult =
  | { ok: true; purchaseDocumentId: string; status: PurchaseDocumentStatus; created: boolean }
  | { ok: false; reason: FailureReason; message: string };

/** Preparer-only (enforced by the RPC): only the source document's
 * uploader may create its draft. Idempotent -- opens the existing
 * purchase_document if one already exists rather than erroring. */
export async function createOrOpenPurchaseDocumentDraft(documentId: string): Promise<CreateOrOpenPurchaseDocumentDraftResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await initializePurchaseDocumentDraftRpc(getServiceRoleClient(), {
      documentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
    });
    // Item matching begins as soon as a real draft with real lines exists
    // -- never deferred until Send for Final Review, which the completion
    // gate (20260811100047) now blocks on classification already being
    // complete. Harmless/no-op if there's nothing to classify yet.
    scheduleClassification(result.purchaseDocumentId, auth.manager.organizationId);
    return { ok: true, purchaseDocumentId: result.purchaseDocumentId, status: result.status, created: result.created };
  } catch (err) {
    logIfUnexpected("createOrOpenPurchaseDocumentDraft", err, { documentId });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export interface SavePurchaseDocumentDraftActionInput {
  purchaseDocumentId: string;
  expectedVersion: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
}

export type SavePurchaseDocumentDraftActionResult =
  | { ok: true; version: number }
  | { ok: false; reason: FailureReason; message: string };

/** Preparer-only, requires DRAFT + matching version. */
export async function savePurchaseDocumentDraft(input: SavePurchaseDocumentDraftActionInput): Promise<SavePurchaseDocumentDraftActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await savePurchaseDocumentDraftRpc(getServiceRoleClient(), {
      purchaseDocumentId: input.purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion: input.expectedVersion,
      header: input.header,
      lines: input.lines,
    });
    scheduleClassification(input.purchaseDocumentId, auth.manager.organizationId);
    return { ok: true, version: result.version };
  } catch (err) {
    logIfUnexpected("savePurchaseDocumentDraft", err, { purchaseDocumentId: input.purchaseDocumentId, expectedVersion: input.expectedVersion });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type SubmitPurchaseDocumentForVerificationResult =
  | { ok: true; status: PurchaseDocumentStatus; version: number }
  | { ok: false; reason: FailureReason; message: string };

/** Preparer-only. Completeness gates (vendor active, type resolved, >=1
 * line) are enforced by the RPC -- the UI should pre-check the same
 * conditions so this failure path is rare, not the primary signal.
 * `header`/`lines` should always be the exact current on-screen form
 * state -- the RPC persists them atomically with the transition, so the
 * caller never needs a separate Save Draft click first. */
export async function submitPurchaseDocumentForVerification(
  purchaseDocumentId: string,
  expectedVersion: number,
  header?: PurchaseDocumentHeaderDraft,
  lines?: PurchaseDocumentLine[]
): Promise<SubmitPurchaseDocumentForVerificationResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await submitPurchaseDocumentForVerificationRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion,
      header,
      lines,
    });
    scheduleClassification(purchaseDocumentId, auth.manager.organizationId);
    return { ok: true, status: result.status, version: result.version };
  } catch (err) {
    logIfUnexpected("submitPurchaseDocumentForVerification", err, { purchaseDocumentId, expectedVersion });
    return {
      ok: false,
      reason: reasonFor(err),
      message: err instanceof StaleVersionError
        ? "This document isn't ready to submit yet, or was updated elsewhere."
        : isKnownPurchaseDocumentError(err)
          ? safeMessage(err)
          : "We couldn't send this invoice for final review. Please try again.",
    };
  }
}

export type VerifyPurchaseDocumentResult =
  | { ok: true; verifiedAt: string }
  | { ok: false; reason: FailureReason; message: string };

/** Non-preparer-only: rejected with "cannot_self_verify" if the caller
 * uploaded the source document, regardless of admin status. `header`/
 * `lines` should always be the reviewer's exact current on-screen form
 * state -- the RPC persists any unsaved edits atomically with the
 * verification, so the caller never needs a separate Save Corrections
 * click first. */
export async function verifyPurchaseDocument(
  purchaseDocumentId: string,
  expectedVersion: number,
  header?: PurchaseDocumentHeaderDraft,
  lines?: PurchaseDocumentLine[]
): Promise<VerifyPurchaseDocumentResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await verifyPurchaseDocumentRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion,
      header,
      lines,
    });
    scheduleClassification(purchaseDocumentId, auth.manager.organizationId);
    return { ok: true, verifiedAt: result.verifiedAt };
  } catch (err) {
    logIfUnexpected("verifyPurchaseDocument", err, { purchaseDocumentId, expectedVersion });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type SaveReviewCorrectionsActionResult =
  | { ok: true; version: number }
  | { ok: false; reason: FailureReason; message: string };

/** Manager 2's controlled persist of header/line invoice-fact corrections
 * during READY_FOR_VERIFICATION -- non-preparer-only (the RPC rejects the
 * preparer with GA004, same maker-checker rule as verify). Needed before
 * Final Verify whenever a correction touches a classification-IDENTITY
 * field (SKU/description/units): persisting first lets the invalidation
 * trigger flag the affected mappings as needing review, so the reviewer
 * re-confirms them against the CORRECTED facts -- resolving them against
 * the stale pre-correction facts can never converge. Schedules the same
 * background re-classification as every other line-changing save. */
export async function savePurchaseDocumentReviewCorrections(
  purchaseDocumentId: string,
  expectedVersion: number,
  header: PurchaseDocumentHeaderDraft,
  lines: PurchaseDocumentLine[]
): Promise<SaveReviewCorrectionsActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await saveReviewCorrectionsRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion,
      header,
      lines,
    });
    scheduleClassification(purchaseDocumentId, auth.manager.organizationId);
    return { ok: true, version: result.version };
  } catch (err) {
    logIfUnexpected("savePurchaseDocumentReviewCorrections", err, { purchaseDocumentId, expectedVersion });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type SaveReviewProposalsActionResult =
  | { ok: true; version: number; mappingCount: number; receivingCount: number }
  | { ok: false; reason: FailureReason; message: string };

/** Persists Manager 2's PROVISIONAL correction overlay (mapping +
 * receiving proposals) so a refresh never loses review work. Changes NO
 * authoritative state -- effective receipts and confirmed classifications
 * are untouched until Final Verify promotes the overlay atomically, and
 * Return to Preparer / Withdraw Submission discard it (keeping a copy in
 * their audit events). Non-preparer-only; READY_FOR_VERIFICATION only.
 * `expectedVersion` (0 = creating) is the optimistic-concurrency token:
 * a stale save is rejected with reason "review_conflict" instead of
 * overwriting another tab's proposals. */
export async function savePurchaseDocumentReviewProposals(
  purchaseDocumentId: string,
  expectedVersion: number,
  mappingProposals: MappingProposals,
  receivingProposals: ReceivingProposals
): Promise<SaveReviewProposalsActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await saveReviewProposalsRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion,
      mappingProposals,
      receivingProposals,
    });
    return { ok: true, version: result.version, mappingCount: result.mappingCount, receivingCount: result.receivingCount };
  } catch (err) {
    logIfUnexpected("savePurchaseDocumentReviewProposals", err, { purchaseDocumentId, expectedVersion });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type ReturnPurchaseDocumentToDraftResult =
  | { ok: true; status: PurchaseDocumentStatus; version: number }
  | { ok: false; reason: FailureReason; message: string };

/** Non-preparer-only, same identity check as verify. */
export async function returnPurchaseDocumentToDraft(
  purchaseDocumentId: string,
  expectedVersion: number,
  reason?: string
): Promise<ReturnPurchaseDocumentToDraftResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await returnPurchaseDocumentToDraftRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion,
      reason: reason ?? null,
    });
    return { ok: true, status: result.status, version: result.version };
  } catch (err) {
    logIfUnexpected("returnPurchaseDocumentToDraft", err, { purchaseDocumentId, expectedVersion });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export interface CheckPurchaseDocumentDuplicatesInput {
  purchaseDocumentId: string;
  revisionGroupId?: string;
  vendorId: string | null;
  documentType: PurchaseDocumentType | null;
  documentNumber: string | null;
}

export type CheckPurchaseDocumentDuplicatesResult =
  | { ok: true; duplicates: PossibleDuplicatePurchaseDocument[] }
  | { ok: false; reason: "not_authorized"; message: string };

/** Non-blocking, read-only -- never gates save/submit. Excludes the
 * purchase document being reviewed from its own results. */
export async function checkPurchaseDocumentDuplicates(
  input: CheckPurchaseDocumentDuplicatesInput
): Promise<CheckPurchaseDocumentDuplicatesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const duplicates = await findPossibleDuplicatePurchaseDocuments(getServiceRoleClient(), {
    organizationId: auth.manager.organizationId,
    vendorId: input.vendorId,
    documentType: input.documentType,
    documentNumber: input.documentNumber,
    excludePurchaseDocumentId: input.purchaseDocumentId,
    excludeRevisionGroupId: input.revisionGroupId,
  });
  return { ok: true, duplicates };
}

export type InitiateAmendmentResult =
  | { ok: true; purchaseDocumentId: string; revisionNumber: number }
  | { ok: false; reason: FailureReason; message: string };

/** Any manager/admin may initiate -- the resulting revision's own
 * created_by_app_user_id (the initiator) is what maker-checker enforces
 * against from here on, exactly like an original draft's uploader. Only
 * the CURRENT verified revision may be amended; a superseded one is
 * rejected. */
export async function initiatePurchaseDocumentAmendment(
  purchaseDocumentId: string,
  reason: string
): Promise<InitiateAmendmentResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await initiateAmendmentRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      reason,
    });
    return { ok: true, purchaseDocumentId: result.purchaseDocumentId, revisionNumber: result.revisionNumber };
  } catch (err) {
    logIfUnexpected("initiatePurchaseDocumentAmendment", err, { purchaseDocumentId });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type DiscardPurchaseDocumentDraftResult =
  | { ok: true; status: PurchaseDocumentStatus; version: number }
  | { ok: false; reason: FailureReason; message: string };

/** Preparer-only, DRAFT-only -- a READY_FOR_VERIFICATION submission must
 * be withdrawn first (see withdrawPurchaseDocumentSubmission below), and a
 * VERIFIED record can never be discarded. `reason` is required by the RPC
 * for an amendment (revision_number > 1), optional for an original,
 * never-submitted draft -- the UI should pre-check the same condition so
 * this rejection is rare, not the primary signal. */
export async function discardPurchaseDocumentDraft(
  purchaseDocumentId: string,
  expectedVersion: number,
  reason?: string
): Promise<DiscardPurchaseDocumentDraftResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await discardPurchaseDocumentDraftRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion,
      reason,
    });
    return { ok: true, status: result.status, version: result.version };
  } catch (err) {
    logIfUnexpected("discardPurchaseDocumentDraft", err, { purchaseDocumentId, expectedVersion });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type WithdrawPurchaseDocumentSubmissionResult =
  | { ok: true; status: PurchaseDocumentStatus; version: number }
  | { ok: false; reason: FailureReason; message: string };

/** Preparer-only -- the opposite identity check from verify/return, since
 * only the person who submitted a document may pull it back. Restores the
 * latest submitted snapshot exactly like Return-to-Preparer, so any
 * reviewer corrections saved during this cycle are discarded (they remain
 * in permanent audit history, just never silently become the restored
 * draft). */
export async function withdrawPurchaseDocumentSubmission(
  purchaseDocumentId: string,
  expectedVersion: number,
  reason?: string
): Promise<WithdrawPurchaseDocumentSubmissionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await withdrawPurchaseDocumentSubmissionRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      expectedVersion,
      reason,
    });
    return { ok: true, status: result.status, version: result.version };
  } catch (err) {
    logIfUnexpected("withdrawPurchaseDocumentSubmission", err, { purchaseDocumentId, expectedVersion });
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type GetPurchaseDocumentPreparationStatusResult = { ok: true; status: PreparationStatus } | { ok: false; reason: "not_authorized"; message: string };

/** The read-only preview of whether Send for Final Review would currently
 * succeed -- backs the button's disabled state and its per-line reasons.
 * Never the enforcement itself; submitPurchaseDocumentForVerification's
 * own RPC call is the only thing that can't be bypassed. */
export async function getPurchaseDocumentPreparationStatus(purchaseDocumentId: string): Promise<GetPurchaseDocumentPreparationStatusResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const status = await getPreparationStatus(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, status };
}

export type GetAmendmentAlreadyPostedResult = { ok: true; alreadyPosted: boolean } | { ok: false; reason: "not_authorized"; message: string };

/** True when a SIBLING revision in this document's own amendment lineage
 * already posted inventory -- mirrors migration 20260811100132's own
 * server-side guard (post_purchase_document_inventory refuses a second
 * posting per lineage). Surfaced on the combined Confirm Items &
 * Receiving step so a manager reopening an already-posted invoice for
 * amendment is told up front, never discovering it only after reaching
 * the final screen. */
export async function getAmendmentAlreadyPosted(purchaseDocumentId: string): Promise<GetAmendmentAlreadyPostedResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }
  const alreadyPosted = await hasSiblingRevisionAlreadyPosted(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, alreadyPosted };
}

export type GetPurchaseDocumentReviewSummaryResult =
  | { ok: true; summary: PurchaseDocumentReviewSummary }
  | { ok: false; reason: "not_authorized"; message: string };

/** Step 4's read-only "what am I about to send" summary -- purely an
 * aggregation of what earlier steps already produced (classifications,
 * receiving config, receipt facts). Never a second opinion on readiness;
 * getPurchaseDocumentPreparationStatus above remains the only source of
 * truth for that. */
export async function getPurchaseDocumentReviewSummary(purchaseDocumentId: string): Promise<GetPurchaseDocumentReviewSummaryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const summary = await getReviewSummary(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, summary };
}

export type GetReceiptHistoryResult = { ok: true; history: ReceiptHistoryEntry[] } | { ok: false; reason: "not_authorized"; message: string };

/** The VERIFIED page's read-only receipt timeline -- every receipt ever
 * recorded for this document, each marked Effective/Superseded. */
export async function getReceiptHistoryForPurchaseDocument(purchaseDocumentId: string): Promise<GetReceiptHistoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const history = await getReceiptHistory(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, history };
}
