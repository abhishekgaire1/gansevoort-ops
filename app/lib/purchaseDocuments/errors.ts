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

export function mapPurchaseDocumentRpcError(error: { code?: string; message: string }): Error {
  switch (error.code) {
    case PURCHASE_DOCUMENT_SQLSTATE.STALE_OR_WRONG_STATUS:
      return new StaleVersionError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.VERIFIED_LOCKED:
      return new VerifiedLockedError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.CANNOT_SELF_VERIFY:
      return new CannotSelfVerifyError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.VENDOR_NOT_ACTIVE:
      return new VendorNotActiveError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.NOT_PREPARER:
      return new NotPreparerError(error.message);
    default:
      return new Error(error.message);
  }
}
