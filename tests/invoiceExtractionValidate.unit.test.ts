import { describe, expect, it } from "vitest";
import { validateInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/validate";
import type { NormalizedInvoiceExtraction, NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";

// CI-safe: pure deterministic validation logic, no network, no AI call.

function baseLine(overrides: Partial<NormalizedInvoiceLine> = {}): NormalizedInvoiceLine {
  return {
    vendorSku: "TOM-25",
    description: "Roma Tomatoes",
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

function baseExtraction(overrides: Partial<NormalizedInvoiceExtraction> = {}): NormalizedInvoiceExtraction {
  return {
    documentType: "INVOICE",
    vendorName: "Baldor",
    vendorAddress: null,
    vendorPhone: null,
    invoiceNumber: "B-839291",
    invoiceDate: "2026-08-12",
    deliveryDate: null,
    purchaseOrderNumber: null,
    subtotal: null,
    tax: null,
    fees: null,
    total: null,
    amountDue: null,
    currency: "USD",
    lines: [],
    warnings: [],
    ...overrides,
  };
}

describe("validateInvoiceExtraction -- header checks", () => {
  it("flags missing vendor, invoice number, invoice date, and total as errors", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ vendorName: null, invoiceNumber: null, invoiceDate: null, total: null })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("MISSING_VENDOR_NAME");
    expect(codes).toContain("MISSING_INVOICE_NUMBER");
    expect(codes).toContain("MISSING_INVOICE_DATE");
    expect(codes).toContain("MISSING_TOTAL");
    expect(issues.every((i) => i.severity === "error" || i.code === "NO_LINE_ITEMS")).toBe(true);
  });

  it("raises no missing-required-field flags when every header field is present", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ total: 100, lines: [baseLine({ lineTotal: 100 })] }));
    expect(issues.some((i) => i.code.startsWith("MISSING_"))).toBe(false);
  });
});

describe("validateInvoiceExtraction -- line-total math", () => {
  it("does not flag a line when measuredQuantity x unitPrice matches lineTotal (measured basis)", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        lines: [baseLine({ measuredQuantity: 90.4, measuredUnit: "LB", unitPrice: 1.49, priceBasisUnit: "LB", lineTotal: 134.7 })],
      })
    );
    expect(issues.some((i) => i.code === "LINE_TOTAL_MISMATCH")).toBe(false);
  });

  it("does not flag a line when packageQuantity x unitPrice matches lineTotal (package basis)", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        lines: [baseLine({ packageQuantity: 2, packageUnit: "BOX", unitPrice: 37, priceBasisUnit: "BOX", lineTotal: 74 })],
      })
    );
    expect(issues.some((i) => i.code === "LINE_TOTAL_MISMATCH")).toBe(false);
  });

  it("flags a line where measured-basis math does not reconcile with lineTotal", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        lines: [baseLine({ measuredQuantity: 90.4, measuredUnit: "LB", unitPrice: 1.49, priceBasisUnit: "LB", lineTotal: 500 })],
      })
    );
    expect(issues.some((i) => i.code === "LINE_TOTAL_MISMATCH")).toBe(true);
  });

  it("does not flag a line whose price basis matches neither the package nor measured unit (unfamiliar pricing model)", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        lines: [
          baseLine({
            packageQuantity: 3,
            packageUnit: "CS",
            measuredQuantity: 10,
            measuredUnit: "LB",
            unitPrice: 2.5,
            priceBasisUnit: "DZ",
            lineTotal: 999,
          }),
        ],
      })
    );
    expect(issues.some((i) => i.code === "LINE_TOTAL_MISMATCH")).toBe(false);
  });

  it("tolerates small rounding differences without flagging", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        lines: [baseLine({ measuredQuantity: 90.4, measuredUnit: "LB", unitPrice: 1.49, priceBasisUnit: "LB", lineTotal: 134.71 })],
      })
    );
    expect(issues.some((i) => i.code === "LINE_TOTAL_MISMATCH")).toBe(false);
  });
});

describe("validateInvoiceExtraction -- reconciliation regression matrix", () => {
  it("NORMAL INVOICE: 100 subtotal + 8 tax = 108 total reconciles normally, no signal of any kind", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ total: 108, tax: 8, fees: 0, lines: [baseLine({ lineTotal: 100 })] }));
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
    expect(issues.some((i) => i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE" || i.code === "TOTAL_INCLUDES_ACCOUNT_BALANCE")).toBe(false);
  });

  it("CREDIT LINE: a 100 purchase and a -20 credit reconcile to an 80 total, cleanly, with the credit recognized (not flagged as an error)", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        total: 80,
        tax: 0,
        fees: 0,
        lines: [baseLine({ packageQuantity: 1, unitPrice: 100, lineTotal: 100 }), baseLine({ packageQuantity: -1, unitPrice: 20, lineTotal: -20 })],
      })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
    expect(issues.some((i) => i.code === "LINE_NEGATIVE_PACKAGE_QUANTITY" || i.code === "LINE_NEGATIVE_TOTAL")).toBe(false);
    expect(issues.some((i) => i.code === "LINE_RECOGNIZED_AS_CREDIT")).toBe(true);
  });

  it("PRIOR BALANCE: 100 current invoice + 500 previous balance = 600 amount due -- current document reconciles at 100, amount due recorded separately (not folded into the current-document mismatch check)", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ total: 600, tax: 0, fees: 0, lines: [baseLine({ lineTotal: 100 })] }));
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
    const signal = issues.find((i) => i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE");
    expect(signal).toBeDefined();
    expect(signal!.message).toContain("$100.00");
    expect(signal!.message).toContain("$600.00");
  });

  it("FREE ITEM: qty 1, amount 0, description FREE -- not automatically invalid", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ lines: [baseLine({ description: "Sample Item FREE", packageQuantity: 1, unitPrice: 0, lineTotal: 0 })] }));
    expect(issues.some((i) => i.code.startsWith("LINE_NEGATIVE"))).toBe(false);
  });

  it("INVALID SIGN: ordinary product, qty -5, amount +100 -- needs review, never silently accepted as a credit", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ lines: [baseLine({ description: "Ordinary Widget", packageQuantity: -5, unitPrice: 20, lineTotal: 100 })] }));
    expect(issues.some((i) => i.code === "LINE_NEGATIVE_PACKAGE_QUANTITY")).toBe(true);
    expect(issues.some((i) => i.code === "LINE_RECOGNIZED_AS_CREDIT")).toBe(false);
  });
});

describe("validateInvoiceExtraction -- invoice total check", () => {
  it("does not flag when line totals + tax + fees reconcile with the extracted total", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        total: 110,
        tax: 10,
        fees: 0,
        lines: [baseLine({ lineTotal: 60 }), baseLine({ lineTotal: 40 })],
      })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
  });

  it("flags a genuine mismatch (stated total SMALLER than the lines) as INVOICE_TOTAL_MISMATCH, never as an account-balance signal", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ total: 40, tax: 0, fees: 0, lines: [baseLine({ lineTotal: 60 })] })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(true);
    expect(issues.some((i) => i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE" || i.code === "TOTAL_INCLUDES_ACCOUNT_BALANCE")).toBe(false);
  });

  it("recognizes a LARGER stated total as a possible account balance (info if amountDue confirms it, warning otherwise) instead of a plain mismatch -- Capital Paper #178606 regression", () => {
    // Real captured facts from Capital Paper Inc invoice #178606: 62 real
    // lines (including two legitimate credits) sum to exactly $3,336.00 --
    // the document's own economic total -- but the invoice prints a
    // TOTAL of $15,565.50, which is that $3,336.00 plus three PRIOR,
    // separately-invoiced deliveries (177888/178135/178361) listed above
    // it. The AI never extracted those three rows as line items.
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ total: 15565.5, tax: null, fees: null, lines: [baseLine({ lineTotal: 3336 })] })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
    const signal = issues.find((i) => i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("warning");
    expect(signal!.message).toContain("$3,336.00");
    expect(signal!.message).toContain("$15,565.50");
  });

  it("recognizes the account balance at INFO severity when the AI's own amountDue confirms the same figure", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ total: 15565.5, amountDue: 15565.5, tax: null, fees: null, lines: [baseLine({ lineTotal: 3336 })] })
    );
    const signal = issues.find((i) => i.code === "TOTAL_INCLUDES_ACCOUNT_BALANCE");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("info");
  });

  it("does NOT treat a larger total as an account balance when amountDue disagrees with it -- falls back to the ordinary mismatch check", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ total: 15565.5, amountDue: 999999, tax: null, fees: null, lines: [baseLine({ lineTotal: 3336 })] })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(true);
    expect(issues.some((i) => i.code === "TOTAL_INCLUDES_ACCOUNT_BALANCE" || i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE")).toBe(false);
  });

  it("skips the total check (does not overwrite or fabricate) when any line total is unknown", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ total: 999, lines: [baseLine({ lineTotal: 60 }), baseLine({ lineTotal: null })] })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
  });
});

describe("validateInvoiceExtraction -- data-quality checks", () => {
  it("flags negative quantities and negative totals", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ lines: [baseLine({ packageQuantity: -1, measuredQuantity: -1, unitPrice: -1, lineTotal: -1 })] })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("LINE_NEGATIVE_PACKAGE_QUANTITY");
    expect(codes).toContain("LINE_NEGATIVE_MEASURED_QUANTITY");
    expect(codes).toContain("LINE_NEGATIVE_UNIT_PRICE");
    expect(codes).toContain("LINE_NEGATIVE_TOTAL");
  });

  it("flags a quantity present without its unit", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ lines: [baseLine({ packageQuantity: 5, packageUnit: null, measuredQuantity: 10, measuredUnit: null })] })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("LINE_MISSING_PACKAGE_UNIT");
    expect(codes).toContain("LINE_MISSING_MEASURED_UNIT");
  });

  it("flags a line with no description", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ lines: [baseLine({ description: null })] }));
    expect(issues.some((i) => i.code === "LINE_MISSING_DESCRIPTION")).toBe(true);
  });

  it("flags an extraction with zero line items", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ lines: [] }));
    expect(issues.some((i) => i.code === "NO_LINE_ITEMS")).toBe(true);
  });
});

describe("validateInvoiceExtraction -- purity", () => {
  it("does not mutate the extracted source values it's given", () => {
    const input = baseExtraction({
      total: 100,
      lines: [baseLine({ lineTotal: 50, measuredQuantity: -1 })],
    });
    const snapshot = JSON.parse(JSON.stringify(input));

    validateInvoiceExtraction(input);

    expect(input).toEqual(snapshot);
  });

  it("returns the same extraction object it was given as `data`, unmodified", () => {
    const input = baseExtraction({ total: 100 });
    const { data } = validateInvoiceExtraction(input);
    expect(data).toBe(input);
  });
});

describe("validateInvoiceExtraction -- credit/return lines (negative quantity+total is not automatically an error)", () => {
  it("recognizes a legitimate credit line (negative qty, negative total, consistent arithmetic) as info, never as an error -- Capital Paper #178606's -$64 credit", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        lines: [baseLine({ description: "CREDIT ------ 32OZ ROUND CONTAI", packageQuantity: -2, unitPrice: 32, lineTotal: -64 })],
      })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).not.toContain("LINE_NEGATIVE_PACKAGE_QUANTITY");
    expect(codes).not.toContain("LINE_NEGATIVE_TOTAL");
    expect(codes).toContain("LINE_RECOGNIZED_AS_CREDIT");
    expect(issues.find((i) => i.code === "LINE_RECOGNIZED_AS_CREDIT")!.severity).toBe("info");
  });

  it("recognizes a second legitimate credit line -- Capital Paper #178606's -$36 credit", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        lines: [baseLine({ description: "CREDIT ------ BLACK DOME LID HO", packageQuantity: -1, unitPrice: 36, lineTotal: -36 })],
      })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).not.toContain("LINE_NEGATIVE_PACKAGE_QUANTITY");
    expect(codes).not.toContain("LINE_NEGATIVE_TOTAL");
    expect(codes).toContain("LINE_RECOGNIZED_AS_CREDIT");
  });

  it("does NOT recognize a credit when the signs disagree (negative qty, POSITIVE total) -- still flagged, genuinely needs review", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ lines: [baseLine({ description: "Ordinary Product", packageQuantity: -2, unitPrice: 32, lineTotal: 64 })] })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("LINE_NEGATIVE_PACKAGE_QUANTITY");
    expect(codes).not.toContain("LINE_RECOGNIZED_AS_CREDIT");
  });

  it("does NOT recognize a credit when quantity/total are negative but the arithmetic doesn't reconcile", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ lines: [baseLine({ packageQuantity: -2, unitPrice: 10, lineTotal: -999 })] })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("LINE_NEGATIVE_PACKAGE_QUANTITY");
    expect(codes).toContain("LINE_NEGATIVE_TOTAL");
    expect(codes).not.toContain("LINE_RECOGNIZED_AS_CREDIT");
  });

  it("does not recognize an ordinary positive purchase line as a credit", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ lines: [baseLine({ packageQuantity: 4, unitPrice: 17.5, lineTotal: 70 })] }));
    expect(issues.some((i) => i.code === "LINE_RECOGNIZED_AS_CREDIT")).toBe(false);
  });
});

describe("validateInvoiceExtraction -- zero-value/free lines are not automatically invalid", () => {
  it("does not flag a positive-quantity, zero-total line described as FREE", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ lines: [baseLine({ description: "#24 MOP HEAD (1/1) FREE", packageQuantity: 1, unitPrice: 0, lineTotal: 0 })] })
    );
    const codes = issues.map((i) => i.code);
    expect(codes).not.toContain("LINE_NEGATIVE_TOTAL");
    expect(codes).not.toContain("LINE_NEGATIVE_PACKAGE_QUANTITY");
    expect(codes).not.toContain("LINE_NEGATIVE_UNIT_PRICE");
  });

  it("does not flag a zero-total line with no explicit FREE wording either -- Capital Paper's BROOM (1/1) line", () => {
    const { issues } = validateInvoiceExtraction(baseExtraction({ lines: [baseLine({ description: "BROOM (1/1)", packageQuantity: 1, unitPrice: 0, lineTotal: 0 })] }));
    expect(issues.some((i) => i.code.startsWith("LINE_NEGATIVE"))).toBe(false);
  });
});

describe("validateInvoiceExtraction -- multi-page capture (100127): sourcePageNumber never interferes with reconciliation", () => {
  it("still reconciles a combined multi-page-style extraction correctly (lines tagged with sourcePageNumber across several pages)", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        subtotal: 204.23,
        tax: 0,
        total: 204.23,
        lines: [
          baseLine({ description: "Tomatoes", packageQuantity: 5, unitPrice: 20, lineTotal: 100, sourcePageNumber: 1 }),
          baseLine({ description: "Eggs", packageQuantity: 2, unitPrice: 37, lineTotal: 74, sourcePageNumber: 1 }),
          baseLine({ description: "Bread", packageQuantity: 1, unitPrice: 30.23, lineTotal: 30.23, sourcePageNumber: 2 }),
        ],
      })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(false);
  });

  it("still flags a genuine conflicting/mismatched total for a multi-page-style extraction -- sourcePageNumber does not suppress it", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({
        subtotal: 100,
        tax: 0,
        total: 999, // does not reconcile with the lines below
        lines: [
          baseLine({ description: "Tomatoes", packageQuantity: 5, unitPrice: 20, lineTotal: 100, sourcePageNumber: 1 }),
          baseLine({ description: "Bread", packageQuantity: 1, unitPrice: 30, lineTotal: 30, sourcePageNumber: 2 }),
        ],
      })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH" || i.code === "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE")).toBe(true);
  });

  it("sourcePageNumber being absent/null (single-page documents) behaves identically to before -- no new validation issue is introduced by its mere presence or absence", () => {
    const withPageNumbers = validateInvoiceExtraction(
      baseExtraction({ subtotal: 50, tax: 0, total: 50, lines: [baseLine({ packageQuantity: 1, unitPrice: 50, lineTotal: 50, sourcePageNumber: 1 })] })
    ).issues;
    const withoutPageNumbers = validateInvoiceExtraction(
      baseExtraction({ subtotal: 50, tax: 0, total: 50, lines: [baseLine({ packageQuantity: 1, unitPrice: 50, lineTotal: 50 })] })
    ).issues;
    expect(withPageNumbers).toEqual(withoutPageNumbers);
  });
});
