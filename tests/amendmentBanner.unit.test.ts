import { describe, expect, it } from "vitest";
import { deriveAmendmentBanner, type AmendmentBannerInput } from "@/app/lib/purchaseDocuments/amendmentBanner";

/**
 * Fix for a confirmed defect: a reopened verified invoice gave the
 * manager no indication they were editing a previously-verified record.
 * revisionNumber > 1 is this app's own existing "this is an amendment"
 * convention (see initiate_purchase_document_amendment).
 */

const baseInput: AmendmentBannerInput = {
  revisionNumber: 2,
  documentNumber: "3759925",
  documentType: "INVOICE",
  previousVerifiedAt: "2026-09-01T21:41:21.599967+00:00",
  amendmentReason: "Correcting a header detail",
  previousRevisionId: "prev-rev-id",
};

describe("deriveAmendmentBanner", () => {
  it("test 1: a reopened (revisionNumber > 1) verified invoice shows the Amendment in Progress banner content", () => {
    const banner = deriveAmendmentBanner(baseInput);
    expect(banner).not.toBeNull();
    expect(banner!.originalLabel).toBe("Invoice #3759925");
    expect(banner!.previousVerifiedAt).toBe(baseInput.previousVerifiedAt);
    expect(banner!.amendmentReason).toBe(baseInput.amendmentReason);
    expect(banner!.previousRevisionId).toBe("prev-rev-id");
  });

  it("a fresh, never-amended document (revisionNumber 1) shows nothing", () => {
    expect(deriveAmendmentBanner({ ...baseInput, revisionNumber: 1 })).toBeNull();
  });

  it("falls back to a generic label when the document number isn't known yet", () => {
    const banner = deriveAmendmentBanner({ ...baseInput, documentNumber: null });
    expect(banner!.originalLabel).toBe("Original invoice");
  });

  it("uses the correct label per document type", () => {
    expect(deriveAmendmentBanner({ ...baseInput, documentType: "RECEIPT", documentNumber: "99" })!.originalLabel).toBe("Receipt/Transaction #99");
    expect(deriveAmendmentBanner({ ...baseInput, documentType: "CREDIT_MEMO", documentNumber: "99" })!.originalLabel).toBe("Credit Memo #99");
  });
});
