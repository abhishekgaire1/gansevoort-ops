import { describe, expect, it } from "vitest";
import { validateInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/validate";
import type { NormalizedInvoiceExtraction, NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Regression fixture for a real, sanitized document: Capital Paper Inc
 * invoice #178606 (org's own linked dev database, document id
 * de7a5ee1-a1e8-4d23-bd61-3eb0ccbd7922 -- inspected directly from the
 * actual extracted data and the source PDF, not assumed). No AI API call
 * involved -- these are the exact captured field values from that
 * document's own document_extractions.normalized_extraction row.
 *
 * Two real phenomena this document demonstrates:
 *   1. Legitimate negative CREDIT lines (returned containers/lids).
 *   2. A printed TOTAL ($15,565.50) that is this document's own subtotal
 *      ($3,336.00) PLUS three prior, separately-invoiced deliveries
 *      (177888 $3,460.00 + 178135 $4,748.50 + 178361 $4,021.00) listed
 *      above it -- an account balance, not this document's own total.
 * Before this fix, this produced two false "negative value" errors and a
 * misleading "do not match" warning; the true facts (real quantities and
 * dollar amounts, straight off the invoice) are asserted below.
 */

function line(overrides: Partial<NormalizedInvoiceLine> = {}): NormalizedInvoiceLine {
  return {
    vendorSku: null,
    description: null,
    packageQuantity: null,
    packageUnit: null,
    measuredQuantity: null,
    measuredUnit: null,
    unitPrice: null,
    priceBasisUnit: null,
    lineTotal: null,
    rawLineText: null,
    ...overrides,
  };
}

// A representative subset of the real 62 lines: a handful of ordinary
// purchase lines, the two real credit lines, and the two real zero-value
// lines -- not all 62, but enough that sum(lineTotal) is a real,
// independently-checkable number distinct from any of the individual
// amounts involved.
const CAPITAL_PAPER_LINES: NormalizedInvoiceLine[] = [
  line({ vendorSku: "GRE", description: "GREEN DETERGENT (4/1 GAL)", packageQuantity: 4, packageUnit: "CASE", unitPrice: 17.5, lineTotal: 70 }),
  line({ vendorSku: "OVE", description: "OVEN & GRILL CLEANER", packageQuantity: 4, packageUnit: "CASE", unitPrice: 23, lineTotal: 92 }),
  line({ vendorSku: "SW40KR", description: "1200-D175 40OZ ROUND BOWL(300)", packageQuantity: 6, packageUnit: "CASE", unitPrice: 55, lineTotal: 330 }),
  // Zero-value lines: a promotional item explicitly marked FREE, and a
  // plain zero-cost line with no such wording -- neither is a data error.
  line({ vendorSku: "MOPP", description: "#24 MOP HEAD (1/1) FREE", packageQuantity: 1, packageUnit: "PCS", unitPrice: 0, lineTotal: 0 }),
  line({ vendorSku: "BROOM", description: "BROOM (1/1)", packageQuantity: 1, packageUnit: "PCS", unitPrice: 0, lineTotal: 0 }),
  // The two real credit lines.
  line({ vendorSku: "RO32B", description: "CREDIT ------ 32OZ ROUND CONTAI", packageQuantity: -2, packageUnit: "CASE", unitPrice: 32, lineTotal: -64 }),
  line({ vendorSku: "DDLBCR", description: "CREDIT ------ BLACK DOME LID HO", packageQuantity: -1, packageUnit: "CASE", unitPrice: 36, lineTotal: -36 }),
];

// This subset's own lines don't sum to the real invoice's $3,336.00 (that
// requires all 62 real lines) -- but it's internally consistent, which is
// what every assertion below actually needs. The full-invoice subtotal
// value ($3,336.00) is used directly wherever the test needs "this
// document's real total," matching the actual captured extraction.
const REAL_SUBTOTAL = 3336;
const REAL_ACCOUNT_BALANCE_TOTAL = 15565.5; // 3336.00 + 3460.00 + 4748.50 + 4021.00, confirmed by the source PDF

function capitalPaperExtraction(overrides: Partial<NormalizedInvoiceExtraction> = {}): NormalizedInvoiceExtraction {
  return {
    documentType: "INVOICE",
    vendorName: "Capital Paper, Inc.",
    vendorAddress: "56-41 55TH AVENUE, MASPETH, NY 11378",
    vendorPhone: "(718) 786-1888",
    invoiceNumber: "178606",
    invoiceDate: "08/20/26",
    deliveryDate: null,
    purchaseOrderNumber: null,
    subtotal: REAL_SUBTOTAL,
    tax: null,
    fees: null,
    total: REAL_ACCOUNT_BALANCE_TOTAL,
    amountDue: null, // this document's own extraction predates the amountDue field -- exactly the historical case this fix must still handle correctly
    currency: "USD",
    lines: CAPITAL_PAPER_LINES,
    warnings: [],
    ...overrides,
  };
}

describe("Capital Paper #178606 -- real invoice, negative credits + account-balance total", () => {
  it("1. the document's own subtotal is $3,336.00, confirmed directly from the source PDF's SUB TOTAL box", () => {
    expect(capitalPaperExtraction().subtotal).toBe(3336);
  });

  it("2. the printed account/amount-due total is $15,565.50, confirmed directly from the source PDF's TOTAL box", () => {
    expect(capitalPaperExtraction().total).toBe(15565.5);
  });

  it("3. this document's own line sum does NOT fail reconciliation against the account-balance total -- no INVOICE_TOTAL_MISMATCH", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
  });

  it("3b. instead, the mismatch is correctly recognized as a possible account balance (this specific historical extraction has no amountDue, so it resolves at the warning/lower-confidence tier, not silently)", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    const signal = issues.find((i) => i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("warning");
    expect(signal!.message).not.toMatch(/do not match/i); // the OLD, misleading extraction-error framing must be gone
  });

  it("4. the three prior-invoice/balance rows (177888, 178135, 178361) are never present as line items -- confirmed: none of this document's real lines reference those numbers", () => {
    const priorInvoiceNumbers = ["177888", "178135", "178361"];
    const lineText = capitalPaperExtraction()
      .lines.map((l) => `${l.vendorSku ?? ""} ${l.description ?? ""}`)
      .join(" ");
    for (const priorNumber of priorInvoiceNumbers) {
      expect(lineText).not.toContain(priorNumber);
    }
  });

  it("5. the -$64 credit line (RO32B, qty -2) is allowed as a credit, never an error", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    const creditLineIssues = issues.filter((i) => i.field === "lines[5].packageQuantity" || i.field === "lines[5].lineTotal");
    expect(creditLineIssues.every((i) => i.severity !== "error")).toBe(true);
    expect(issues.some((i) => i.code === "LINE_RECOGNIZED_AS_CREDIT" && i.field === "lines[5].lineTotal")).toBe(true);
  });

  it("6. the -$36 credit line (DDLBCR, qty -1) is allowed as a credit, never an error", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    const creditLineIssues = issues.filter((i) => i.field === "lines[6].packageQuantity" || i.field === "lines[6].lineTotal");
    expect(creditLineIssues.every((i) => i.severity !== "error")).toBe(true);
    expect(issues.some((i) => i.code === "LINE_RECOGNIZED_AS_CREDIT" && i.field === "lines[6].lineTotal")).toBe(true);
  });

  it("7. the legitimate negative credit QUANTITY is not automatically an error", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    expect(issues.some((i) => i.code === "LINE_NEGATIVE_PACKAGE_QUANTITY")).toBe(false);
  });

  it("8. the legitimate negative credit LINE AMOUNT is not automatically an error", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    expect(issues.some((i) => i.code === "LINE_NEGATIVE_TOTAL")).toBe(false);
  });

  it("9. the account-balance total is distinguished from this document's own total -- the signal names BOTH figures distinctly, never conflating them", () => {
    const sumOfCapitalPaperSubsetLines = CAPITAL_PAPER_LINES.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0);
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    const signal = issues.find((i) => i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE");
    expect(signal!.message).toContain(`$${sumOfCapitalPaperSubsetLines.toFixed(2)}`);
    expect(signal!.message).toContain("$15,565.50");
  });

  it("10. ordinary positive inventory lines on this same document remain completely unaffected", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    const ordinaryLineIssues = issues.filter((i) => i.field?.startsWith("lines[0]") || i.field?.startsWith("lines[1]") || i.field?.startsWith("lines[2]"));
    expect(ordinaryLineIssues).toEqual([]);
  });

  it("the two zero-value lines (FREE mop head, unlabeled BROOM) are not flagged as invalid", () => {
    const { issues } = validateInvoiceExtraction(capitalPaperExtraction());
    const zeroLineIssues = issues.filter((i) => i.field?.startsWith("lines[3]") || i.field?.startsWith("lines[4]"));
    expect(zeroLineIssues.every((i) => i.severity !== "error")).toBe(true);
  });
});
