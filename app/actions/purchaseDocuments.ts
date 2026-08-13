"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { returnPurchaseDocumentToDraftRpc } from "@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc";
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
} from "@/app/lib/purchaseDocuments/errors";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentStatus, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/** Manager-facing only -- never the raw RPC error text. */
function safeMessage(err: unknown): string {
  if (err instanceof NotPreparerError) return "Only the manager who uploaded this document can make this change.";
  if (err instanceof CannotSelfVerifyError) return "Another manager must verify this document.";
  if (err instanceof StaleVersionError) return "This document was updated elsewhere. Reload to see the latest version.";
  if (err instanceof VerifiedLockedError) return "This document is verified and can no longer be changed.";
  if (err instanceof VendorNotActiveError) return "The selected vendor is not active.";
  return "Something went wrong. Try again.";
}

function reasonFor(err: unknown): "not_preparer" | "cannot_self_verify" | "stale" | "locked" | "invalid_vendor" | "misconfigured" {
  if (err instanceof NotPreparerError) return "not_preparer";
  if (err instanceof CannotSelfVerifyError) return "cannot_self_verify";
  if (err instanceof StaleVersionError) return "stale";
  if (err instanceof VerifiedLockedError) return "locked";
  if (err instanceof VendorNotActiveError) return "invalid_vendor";
  return "misconfigured";
}

type FailureReason = "not_authorized" | "not_preparer" | "cannot_self_verify" | "stale" | "locked" | "invalid_vendor" | "misconfigured";

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
    return { ok: true, purchaseDocumentId: result.purchaseDocumentId, status: result.status, created: result.created };
  } catch (err) {
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export interface SavePurchaseDocumentDraftActionInput {
  purchaseDocumentId: string;
  expectedVersion: number;
  header: PurchaseDocumentHeaderDraft;
  lines: NormalizedInvoiceLine[];
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
    return { ok: true, version: result.version };
  } catch (err) {
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export type SubmitPurchaseDocumentForVerificationResult =
  | { ok: true; status: PurchaseDocumentStatus; version: number }
  | { ok: false; reason: FailureReason; message: string };

/** Preparer-only. Completeness gates (vendor active, type resolved, >=1
 * line) are enforced by the RPC -- the UI should pre-check the same
 * conditions so this failure path is rare, not the primary signal. */
export async function submitPurchaseDocumentForVerification(
  purchaseDocumentId: string,
  expectedVersion: number
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
    });
    return { ok: true, status: result.status, version: result.version };
  } catch (err) {
    return {
      ok: false,
      reason: reasonFor(err),
      message: err instanceof StaleVersionError ? "This document isn't ready to submit yet, or was updated elsewhere." : safeMessage(err),
    };
  }
}

export type VerifyPurchaseDocumentResult =
  | { ok: true; verifiedAt: string }
  | { ok: false; reason: FailureReason; message: string };

/** Non-preparer-only: rejected with "cannot_self_verify" if the caller
 * uploaded the source document, regardless of admin status. */
export async function verifyPurchaseDocument(purchaseDocumentId: string, expectedVersion: number): Promise<VerifyPurchaseDocumentResult> {
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
    });
    return { ok: true, verifiedAt: result.verifiedAt };
  } catch (err) {
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
    return { ok: false, reason: reasonFor(err), message: safeMessage(err) };
  }
}

export interface CheckPurchaseDocumentDuplicatesInput {
  purchaseDocumentId: string;
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
  });
  return { ok: true, duplicates };
}
