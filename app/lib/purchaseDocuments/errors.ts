/**
 * App-defined SQLSTATEs used by finalize_document_upload and the
 * purchase-document RPCs (see the 2A.2 migrations), centralized here so
 * every TS wrapper maps a Postgres error to the same typed exception
 * instead of duplicating the mapping per file.
 */
export const PURCHASE_DOCUMENT_SQLSTATE = {
  DOCUMENT_IDENTITY_CONFLICT: "GA001",
  STALE_OR_WRONG_STATUS: "GA002",
  VERIFIED_LOCKED: "GA003",
  CANNOT_SELF_VERIFY: "GA004",
  VENDOR_NOT_ACTIVE: "GA005",
  NOT_PREPARER: "GA006",
  PREPARATION_INCOMPLETE: "GA013",
  REVIEW_PROPOSALS_CONFLICT: "GA018",
  REVIEW_PROPOSALS_OWNED_ELSEWHERE: "GA019",
  STALE_REVIEW_PROPOSALS: "GA020",
  /** post_purchase_document_sole_approver refused: the caller does not
   * hold the purchase_documents.post_without_second_review permission
   * (20260811100133) -- checked authoritatively in the database, never
   * only by hiding the button in the UI. */
  SOLE_APPROVER_PERMISSION_DENIED: "GA076",
  /** post_purchase_document_sole_approver refused: no reason was supplied
   * for single-manager approval. */
  SOLE_APPROVER_REASON_REQUIRED: "GA078",
  /** The posting-boundary price-review guard (assert_price_review_acknowledged,
   * 20260811100156+) refused: this invoice has a significant, comparable price
   * change that has not been (re-)acknowledged. Shares SQLSTATE GA079 with the
   * inventory-correction "invalid input" code, but during the POSTING path a
   * GA079 can ONLY be this guard (the correction RPCs are a different path), so
   * the posting wrappers map it here unambiguously. */
  PRICE_REVIEW_REQUIRED: "GA079",
  /** The posting-boundary delivery-lineage guard (assert_delivery_lineage_
   * unambiguous, 20260811100172) refused: this document has ambiguous delivery
   * lineage (the same physical delivery recorded more than once, or historical/
   * unidentified duplicates) that would multiply inventory. Dedicated to
   * delivery integrity -- never reused by price or correction codes. */
  DELIVERY_CONFLICT: "GA080",
  /** set_purchase_document_line_treatment (20260811100182) refused: a
   * treatment-specific required field is missing/invalid (no expense
   * category, no credit subtype, no discount scope, an unconfigured return
   * unit, an inactive category, ...). */
  INVALID_LINE_TREATMENT: "GA087",
  /** post_purchase_document_inventory refused: one or more current lines
   * are UNRESOLVED / not CONFIRMED / carry an invalid treatment -- an
   * unresolved line can never post. */
  UNRESOLVED_LINES: "GA088",
  /** set_line_classification_explanation / set_purchase_document_line_
   * treatment: the chosen catch-all expense category requires a written
   * explanation. */
  EXPLANATION_REQUIRED: "GA086",
} as const;

/** The purchase document's version didn't match, or it wasn't in the
 * expected status for the attempted transition (save requires DRAFT,
 * verify/return require READY_FOR_VERIFICATION). */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleVersionError";
  }
}

/** The purchase document is VERIFIED and permanently frozen. */
export class VerifiedLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifiedLockedError";
  }
}

/** The acting app_user is the same person who uploaded the source
 * document -- segregation of duties forbids them from verifying or
 * returning their own submission. */
export class CannotSelfVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotSelfVerifyError";
  }
}

/** The referenced vendor is not active (or not in the caller's
 * organization) at the moment it was required. */
export class VendorNotActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorNotActiveError";
  }
}

/** The acting app_user is not the original uploader of the source
 * document -- only the preparer may create/edit/submit a draft. */
export class NotPreparerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPreparerError";
  }
}

/** Send for Final Review was attempted while a CURRENT relevant line still
 * has incomplete item mapping/receiving preparation -- see
 * 20260811100047's purchase_document_preparation_incomplete() for the
 * exact, authoritative definition of "complete." */
export class PreparationIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparationIncompleteError";
  }
}

/** A reviewer-proposal save from stale local state -- another tab (or a
 * concurrent save) already advanced the overlay's version. Reload before
 * continuing; never silently overwrite. */
export class ReviewProposalsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewProposalsConflictError";
  }
}

/** The active proposal overlay belongs to a different reviewer -- no
 * silent takeover of another manager's in-progress review. */
export class ReviewProposalsOwnedElsewhereError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewProposalsOwnedElsewhereError";
  }
}

/** The proposal overlay (or one of its targets) belongs to an EARLIER
 * submission of this document -- it can never promote into the current
 * one. Reload the current review. */
export class StaleReviewProposalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleReviewProposalsError";
  }
}

/** The caller does not hold purchase_documents.post_without_second_review
 * -- a manager/admin title alone never implies it; only an Admin can
 * grant it (Admin -> Users -> that manager -> Permissions). */
export class SoleApproverPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoleApproverPermissionDeniedError";
  }
}

/** Post Now as Sole Approver was attempted with no reason selected. */
export class SoleApproverReasonRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoleApproverReasonRequiredError";
  }
}

/** The posting-boundary price-review guard refused (GA079 during posting): a
 * significant price change must be reviewed again before inventory can post. */
export class PriceReviewRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceReviewRequiredError";
  }
}

/** The posting-boundary delivery-lineage guard refused (GA080): ambiguous
 * delivery lineage must be reviewed before inventory can post. */
export class DeliveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryConflictError";
  }
}

/** A line treatment was saved with a missing/invalid required field (GA087). */
export class InvalidLineTreatmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLineTreatmentError";
  }
}

/** Posting refused because a current line is unresolved / unconfirmed /
 * invalid (GA088). `blockers` carries the exact per-line reasons. */
export class UnresolvedLinesError extends Error {
  blockers: { lineKey: string | null; description: string | null; reason: string }[];
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "UnresolvedLinesError";
    let parsed: { lineKey: string | null; description: string | null; reason: string }[] = [];
    if (detail) {
      try {
        const raw = JSON.parse(detail) as { lineKey?: string; description?: string; reason?: string }[];
        parsed = raw.map((b) => ({ lineKey: b.lineKey ?? null, description: b.description ?? null, reason: b.reason ?? "" }));
      } catch {
        parsed = [];
      }
    }
    this.blockers = parsed;
  }
}

/** The chosen catch-all expense category requires a written explanation (GA086). */
export class ExplanationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplanationRequiredError";
  }
}

export function mapPurchaseDocumentRpcError(error: { code?: string; message: string }): Error {
  switch (error.code) {
    case PURCHASE_DOCUMENT_SQLSTATE.STALE_OR_WRONG_STATUS:
      return new StaleVersionError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.REVIEW_PROPOSALS_CONFLICT:
      return new ReviewProposalsConflictError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.REVIEW_PROPOSALS_OWNED_ELSEWHERE:
      return new ReviewProposalsOwnedElsewhereError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.STALE_REVIEW_PROPOSALS:
      return new StaleReviewProposalsError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.VERIFIED_LOCKED:
      return new VerifiedLockedError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.CANNOT_SELF_VERIFY:
      return new CannotSelfVerifyError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.VENDOR_NOT_ACTIVE:
      return new VendorNotActiveError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.NOT_PREPARER:
      return new NotPreparerError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.PREPARATION_INCOMPLETE:
      return new PreparationIncompleteError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.SOLE_APPROVER_PERMISSION_DENIED:
      return new SoleApproverPermissionDeniedError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.SOLE_APPROVER_REASON_REQUIRED:
      return new SoleApproverReasonRequiredError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.INVALID_LINE_TREATMENT:
      return new InvalidLineTreatmentError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.UNRESOLVED_LINES:
      return new UnresolvedLinesError(error.message, (error as { details?: string | null }).details ?? undefined);
    case PURCHASE_DOCUMENT_SQLSTATE.EXPLANATION_REQUIRED:
      return new ExplanationRequiredError(error.message);
    default:
      return new Error(error.message);
  }
}
