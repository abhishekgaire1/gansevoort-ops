import { describe, expect, it } from "vitest";
import { normalizeInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/normalize";
import type { GeminiInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/schema";

// CI-safe: pure mapping logic, no network, no AI call.

function rawExtraction(overrides: Partial<GeminiInvoiceExtraction> = {}): GeminiInvoiceExtraction {
  return {
    documentType: "INVOICE",
    vendorName: "Baldor",
    vendorAddress: null,
    vendorPhone: null,
    invoiceNumber: "B-839291",
    invoiceDate: "2026-08-12",
    deliveryDate: null,
    purchaseOrderNumber: null,
    subtotal: 134.7,
    tax: 0,
    fees: 0,
    total: 134.7,
    amountDue: null,
    currency: "USD",
    lines: [],
    warnings: [],
    ...overrides,
  };
}

describe("normalizeInvoiceExtraction", () => {
  it("preserves package quantity and measured quantity independently on the same line -- never collapsed", () => {
    const normalized = normalizeInvoiceExtraction(
      rawExtraction({
        lines: [
          {
            vendorSku: "TOM-25",
            description: "TOM ROMA XL 25LB",
            packageQuantity: 5,
            packageUnit: "CS",
            measuredQuantity: 90.4,
            measuredUnit: "LB",
            unitPrice: 1.49,
            priceBasisUnit: "LB",
            lineTotal: 134.7,
            rawLineText: "5 CS 90.4 LB $1.49/LB $134.70",
          sourcePageNumber: null,
          },
        ],
      })
    );

    const [line] = normalized.lines;
    expect(line.packageQuantity).toBe(5);
    expect(line.packageUnit).toBe("CS");
    expect(line.measuredQuantity).toBe(90.4);
    expect(line.measuredUnit).toBe("LB");
    expect(line.unitPrice).toBe(1.49);
    expect(line.priceBasisUnit).toBe("LB");
    expect(line.lineTotal).toBe(134.7);
  });

  it("preserves a fixed-package line with no measured quantity as null, not zero or missing", () => {
    const normalized = normalizeInvoiceExtraction(
      rawExtraction({
        lines: [
          {
            vendorSku: null,
            description: "Eggs",
            packageQuantity: 2,
            packageUnit: "BOX",
            measuredQuantity: null,
            measuredUnit: null,
            unitPrice: 37,
            priceBasisUnit: "BOX",
            lineTotal: 74,
            rawLineText: "2 BOX $37.00 BOX $74.00",
          sourcePageNumber: null,
          },
        ],
      })
    );

    const [line] = normalized.lines;
    expect(line.packageQuantity).toBe(2);
    expect(line.measuredQuantity).toBeNull();
    expect(line.measuredUnit).toBeNull();
    expect(line.priceBasisUnit).toBe("BOX");
  });

  it("preserves the unit-price basis independently of package and measured units", () => {
    // A pricing basis that matches neither the package nor measured unit is
    // still preserved verbatim -- normalization never second-guesses it.
    const normalized = normalizeInvoiceExtraction(
      rawExtraction({
        lines: [
          {
            vendorSku: null,
            description: "Odd pricing case",
            packageQuantity: 3,
            packageUnit: "CS",
            measuredQuantity: 10,
            measuredUnit: "LB",
            unitPrice: 2.5,
            priceBasisUnit: "DZ",
            lineTotal: 25,
            rawLineText: null,
          sourcePageNumber: null,
          },
        ],
      })
    );
    expect(normalized.lines[0].priceBasisUnit).toBe("DZ");
  });

  it("collapses empty/whitespace-only strings to null, and trims surrounding whitespace", () => {
    const normalized = normalizeInvoiceExtraction(
      rawExtraction({
        vendorName: "  Baldor  ",
        vendorAddress: "   ",
        invoiceNumber: "",
      })
    );
    expect(normalized.vendorName).toBe("Baldor");
    expect(normalized.vendorAddress).toBeNull();
    expect(normalized.invoiceNumber).toBeNull();
  });

  it("passes through null header/total fields as null, not zero or omitted", () => {
    const normalized = normalizeInvoiceExtraction(
      rawExtraction({ subtotal: null, tax: null, fees: null, total: null, currency: null })
    );
    expect(normalized.subtotal).toBeNull();
    expect(normalized.tax).toBeNull();
    expect(normalized.fees).toBeNull();
    expect(normalized.total).toBeNull();
    expect(normalized.currency).toBeNull();
  });

  it("drops empty warning strings but keeps real ones, trimmed", () => {
    const normalized = normalizeInvoiceExtraction(rawExtraction({ warnings: ["  low image quality  ", "", "   "] }));
    expect(normalized.warnings).toEqual(["low image quality"]);
  });

  it("normalizes an empty lines array to an empty array, not null/undefined", () => {
    const normalized = normalizeInvoiceExtraction(rawExtraction({ lines: [] }));
    expect(normalized.lines).toEqual([]);
  });
});
