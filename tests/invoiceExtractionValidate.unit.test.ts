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

  it("flags when line totals + tax + fees do not reconcile with the extracted total", () => {
    const { issues } = validateInvoiceExtraction(
      baseExtraction({ total: 999, tax: 0, fees: 0, lines: [baseLine({ lineTotal: 60 })] })
    );
    expect(issues.some((i) => i.code === "INVOICE_TOTAL_MISMATCH")).toBe(true);
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
