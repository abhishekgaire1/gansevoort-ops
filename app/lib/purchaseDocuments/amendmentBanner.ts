import type { PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";

const DOCUMENT_NUMBER_LABEL: Record<PurchaseDocumentType, string> = {
  INVOICE: "Invoice #",
  RECEIPT: "Receipt/Transaction #",
  CREDIT_MEMO: "Credit Memo #",
};

/**
 * "Amendment in Progress" banner content -- fix for a confirmed defect: a
 * reopened verified invoice gave the manager no indication they were
 * editing a previously-verified record, and (a separate but related
 * defect) its own prior verified revision reappeared as a "possible
 * duplicate" of itself. This is the pure decision of WHETHER and WHAT to
 * show; PurchaseDocumentReviewView.tsx renders it, never recomputes it.
 *
 * revisionNumber > 1 is this app's own existing convention for "this is
 * an amendment" (see initiate_purchase_document_amendment, which always
 * increments it from the prior revision) -- reused here, not reinvented.
 */
export interface AmendmentBannerInput {
  revisionNumber: number;
  documentNumber: string | null;
  documentType: PurchaseDocumentType | null;
  previousVerifiedAt: string | null;
  amendmentReason: string | null;
  previousRevisionId: string | null;
}

export interface AmendmentBannerContent {
  originalLabel: string;
  previousVerifiedAt: string | null;
  amendmentReason: string | null;
  previousRevisionId: string | null;
}

/** Null for revision 1 (never an amendment) -- the caller renders nothing. */
export function deriveAmendmentBanner(input: AmendmentBannerInput): AmendmentBannerContent | null {
  if (input.revisionNumber <= 1) return null;
  const originalLabel = input.documentNumber ? `${DOCUMENT_NUMBER_LABEL[input.documentType ?? "INVOICE"]}${input.documentNumber}` : "Original invoice";
  return {
    originalLabel,
    previousVerifiedAt: input.previousVerifiedAt,
    amendmentReason: input.amendmentReason,
    previousRevisionId: input.previousRevisionId,
  };
}
