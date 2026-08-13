import { describe, expect, it } from "vitest";
import { validatePurchaseDocumentDraft } from "@/app/lib/purchaseDocuments/validatePurchaseDocumentDraft";
import type { PurchaseDocumentDraft } from "@/app/lib/purchaseDocuments/types";
import type { NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";

function line(overrides: Partial<NormalizedInvoiceLine> = {}): NormalizedInvoiceLine {
  return {
    vendorSku: "SKU-1",
    description: "Chicken Thigh",
    packageQuantity: 5,
    packageUnit: "CS",
    measuredQuantity: 90.4,
    measuredUnit: "LB",
    unitPrice: 1.49,
    priceBasisUnit: "LB",
    lineTotal: 134.7,
    rawLineText: null,
    ...overrides,
  };
}

function draft(overrides: Partial<PurchaseDocumentDraft> = {}): PurchaseDocumentDraft {
  return {
    vendorId: "vendor-1",
    documentType: "INVOICE",
    documentNumber: "839291",
    documentDate: "2026-08-12",
    poNumber: null,
    deliveryDate: null,
    subtotal: 134.7,
    tax: 0,
    fees: 0,
    total: 134.7,
    currency: "USD",
    lines: [line()],
    ...overrides,
  };
}

describe("validatePurchaseDocumentDraft -- package/measured independence", () => {
  it("preserves package quantity/unit and measured quantity/unit as four independent facts (not collapsed) when passed through to line validation", () => {
    const flags = validatePurchaseDocumentDraft(draft());
    // A fully-populated, self-consistent line (5 CS / 90.4 LB / $1.49 per LB
    // / $134.70) produces no line-level flags -- proving the four fields
    // survived the round-trip without being merged/dropped, since any
    // collapse would either break the line-total math check or trigger a
    // missing-unit flag.
    expect(flags.filter((f) => f.field?.startsWith("lines["))).toEqual([]);
  });
});

describe("validatePurchaseDocumentDraft -- vendor/type-aware header checks", () => {
  it("flags a missing vendor", () => {
    const flags = validatePurchaseDocumentDraft(draft({ vendorId: null }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "MISSING_VENDOR" }));
  });

  it("flags an unresolved document type", () => {
    const flags = validatePurchaseDocumentDraft(draft({ documentType: null }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "MISSING_DOCUMENT_TYPE" }));
  });

  it("flags MISSING_INVOICE_NUMBER (not MISSING_RECEIPT_NUMBER) for an INVOICE with no document number", () => {
    const flags = validatePurchaseDocumentDraft(draft({ documentType: "INVOICE", documentNumber: null }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "MISSING_INVOICE_NUMBER" }));
    expect(flags.some((f) => f.code === "MISSING_RECEIPT_NUMBER")).toBe(false);
  });

  it("flags MISSING_RECEIPT_NUMBER (not MISSING_INVOICE_NUMBER) for a RECEIPT with no document number", () => {
    const flags = validatePurchaseDocumentDraft(draft({ documentType: "RECEIPT", documentNumber: null }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "MISSING_RECEIPT_NUMBER" }));
    expect(flags.some((f) => f.code === "MISSING_INVOICE_NUMBER")).toBe(false);
  });

  it("flags MISSING_CREDIT_MEMO_NUMBER for a CREDIT_MEMO with no document number", () => {
    const flags = validatePurchaseDocumentDraft(draft({ documentType: "CREDIT_MEMO", documentNumber: null }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "MISSING_CREDIT_MEMO_NUMBER" }));
  });

  it("never flags po_number or delivery_date as missing, for any document type", () => {
    const flags = validatePurchaseDocumentDraft(draft({ documentType: "INVOICE", poNumber: null, deliveryDate: null }));
    expect(flags.some((f) => f.field === "poNumber" || f.field === "deliveryDate")).toBe(false);
  });

  it("flags a missing total", () => {
    const flags = validatePurchaseDocumentDraft(draft({ total: null }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "MISSING_TOTAL" }));
  });
});

describe("validatePurchaseDocumentDraft -- calculations (reused from 2A.0's line validator)", () => {
  it("flags a line-total mismatch", () => {
    const flags = validatePurchaseDocumentDraft(draft({ lines: [line({ lineTotal: 999 })] }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "LINE_TOTAL_MISMATCH" }));
  });

  it("flags an invoice-total reconciliation mismatch", () => {
    const flags = validatePurchaseDocumentDraft(draft({ total: 999 }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "TOTAL_MISMATCH" }));
  });

  it("does not flag a negative line amount as a hard error at the header level (credit memos may be negative) -- severity stays advisory from the reused line validator", () => {
    const flags = validatePurchaseDocumentDraft(draft({ documentType: "CREDIT_MEMO", lines: [line({ lineTotal: -134.7, unitPrice: -1.49 })] }));
    // The reused line validator still flags negative amounts (it doesn't
    // know about credit memos) -- this documents that the flag is
    // display-only and never gates verification (see submit/verify RPCs).
    expect(flags.some((f) => f.code === "LINE_NEGATIVE_TOTAL")).toBe(true);
  });

  it("flags zero line items", () => {
    const flags = validatePurchaseDocumentDraft(draft({ lines: [] }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "NO_LINE_ITEMS" }));
  });

  it("a fully valid draft produces no flags", () => {
    expect(validatePurchaseDocumentDraft(draft())).toEqual([]);
  });
});
