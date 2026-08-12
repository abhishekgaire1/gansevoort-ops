import { describe, expect, it } from "vitest";
import { GeminiInvoiceExtractionSchema } from "@/app/lib/ai/tasks/invoiceExtraction/schema";

// CI-safe: pure Zod schema validation, no network, no AI call.

const VALID_LINE = {
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
};

const VALID_EXTRACTION = {
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
  currency: "USD",
  lines: [VALID_LINE],
  warnings: [],
};

describe("GeminiInvoiceExtractionSchema", () => {
  it("accepts a fully-populated, well-formed extraction", () => {
    const result = GeminiInvoiceExtractionSchema.safeParse(VALID_EXTRACTION);
    expect(result.success).toBe(true);
  });

  it("accepts an extraction where every nullable field is explicitly null", () => {
    const result = GeminiInvoiceExtractionSchema.safeParse({
      documentType: null,
      vendorName: null,
      vendorAddress: null,
      vendorPhone: null,
      invoiceNumber: null,
      invoiceDate: null,
      deliveryDate: null,
      purchaseOrderNumber: null,
      subtotal: null,
      tax: null,
      fees: null,
      total: null,
      currency: null,
      lines: [],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a line with only a package quantity and no measured quantity (fixed-package pattern)", () => {
    const result = GeminiInvoiceExtractionSchema.safeParse({
      ...VALID_EXTRACTION,
      lines: [
        {
          vendorSku: null,
          description: "Eggs",
          packageQuantity: 2,
          packageUnit: "BOX",
          measuredQuantity: null,
          measuredUnit: null,
          unitPrice: 37.0,
          priceBasisUnit: "BOX",
          lineTotal: 74.0,
          rawLineText: "2 BOX $37.00 BOX $74.00",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a document missing the lines array entirely", () => {
    const withoutLines: Record<string, unknown> = { ...VALID_EXTRACTION };
    delete withoutLines.lines;
    const result = GeminiInvoiceExtractionSchema.safeParse(withoutLines);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid documentType enum value", () => {
    const result = GeminiInvoiceExtractionSchema.safeParse({ ...VALID_EXTRACTION, documentType: "PACKING_SLIP" });
    expect(result.success).toBe(false);
  });

  it("rejects a quantity field that is a string instead of a number", () => {
    const result = GeminiInvoiceExtractionSchema.safeParse({
      ...VALID_EXTRACTION,
      lines: [{ ...VALID_LINE, packageQuantity: "5" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects omitting a required-but-nullable field (must be null, not absent)", () => {
    const withoutVendorName: Record<string, unknown> = { ...VALID_EXTRACTION };
    delete withoutVendorName.vendorName;
    const result = GeminiInvoiceExtractionSchema.safeParse(withoutVendorName);
    expect(result.success).toBe(false);
  });
});
