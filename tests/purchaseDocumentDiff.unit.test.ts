import { describe, expect, it } from "vitest";
import { computePurchaseDocumentDiff, purchaseDocumentDiffCount } from "@/app/lib/purchaseDocuments/diff";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";

// CI-safe: pure functions, no network, no database. Mirrors the SQL
// purchase_document_diff/purchase_document_diff_count functions exactly
// (same field lists, same lineKey correlation, same counting rule) --
// used client-side only for the live "Verify with N Corrections" preview.

function header(overrides: Partial<PurchaseDocumentHeaderDraft> = {}): PurchaseDocumentHeaderDraft {
  return {
    vendorId: "vendor-1",
    documentType: "INVOICE",
    documentNumber: "839291",
    documentDate: "2026-08-12",
    poNumber: null,
    deliveryDate: null,
    subtotal: 100,
    tax: 0,
    fees: 0,
    total: 100,
    currency: "USD",
    ...overrides,
  };
}

function line(overrides: Partial<PurchaseDocumentLine> = {}): PurchaseDocumentLine {
  return {
    lineKey: "line-1",
    vendorSku: "SKU-1",
    description: "Heavy Cream",
    packageQuantity: 5,
    packageUnit: "CS",
    measuredQuantity: null,
    measuredUnit: null,
    unitPrice: 42,
    priceBasisUnit: "CS",
    lineTotal: 210,
    rawLineText: null,
    ...overrides,
  };
}

describe("computePurchaseDocumentDiff -- header changes", () => {
  it("detects no changes when header and lines are identical", () => {
    const diff = computePurchaseDocumentDiff(header(), [line()], header(), [line()]);
    expect(diff.headerChanges).toEqual([]);
    expect(diff.lineChanges).toEqual([]);
    expect(purchaseDocumentDiffCount(diff)).toBe(0);
  });

  it("reports each changed header field with its before/after value", () => {
    const diff = computePurchaseDocumentDiff(header(), [], header({ total: 148.5, documentNumber: "839292" }), []);
    expect(diff.headerChanges).toContainEqual({ field: "total", before: 100, after: 148.5 });
    expect(diff.headerChanges).toContainEqual({ field: "documentNumber", before: "839291", after: "839292" });
    expect(purchaseDocumentDiffCount(diff)).toBe(2);
  });

  it("a field changed and then changed back nets to zero", () => {
    // Manager B: $42 -> $40, Manager C: $40 -> $42 -- net submitted vs
    // final is unchanged.
    const submitted = header({ total: 42 });
    const final = header({ total: 42 });
    const diff = computePurchaseDocumentDiff(submitted, [], final, []);
    expect(diff.headerChanges).toEqual([]);
    expect(purchaseDocumentDiffCount(diff)).toBe(0);
  });
});

describe("computePurchaseDocumentDiff -- line changes", () => {
  it("modified line reports only the fields that actually changed, counted individually", () => {
    const oldLine = line({ unitPrice: 42, lineTotal: 210 });
    const newLine = line({ unitPrice: 40, lineTotal: 200 });
    const diff = computePurchaseDocumentDiff(header(), [oldLine], header(), [newLine]);
    expect(diff.lineChanges).toHaveLength(1);
    expect(diff.lineChanges[0]).toMatchObject({ lineKey: "line-1", kind: "modified" });
    if (diff.lineChanges[0].kind === "modified") {
      expect(diff.lineChanges[0].fields).toContainEqual({ field: "unitPrice", before: 42, after: 40 });
      expect(diff.lineChanges[0].fields).toContainEqual({ field: "lineTotal", before: 210, after: 200 });
    }
    expect(purchaseDocumentDiffCount(diff)).toBe(2); // two changed fields inside one modified line
  });

  it("a line present in new but not old (by lineKey) is 'added', counted as 1 regardless of how many fields it has", () => {
    const diff = computePurchaseDocumentDiff(header(), [line({ lineKey: "line-1" })], header(), [line({ lineKey: "line-1" }), line({ lineKey: "line-2", description: "Oat Milk" })]);
    expect(diff.lineChanges).toContainEqual(expect.objectContaining({ lineKey: "line-2", kind: "added" }));
    expect(purchaseDocumentDiffCount(diff)).toBe(1);
  });

  it("a line present in old but not new (by lineKey) is 'removed', counted as 1", () => {
    const diff = computePurchaseDocumentDiff(header(), [line({ lineKey: "line-1" }), line({ lineKey: "line-2" })], header(), [line({ lineKey: "line-1" })]);
    expect(diff.lineChanges).toContainEqual(expect.objectContaining({ lineKey: "line-2", kind: "removed" }));
    expect(purchaseDocumentDiffCount(diff)).toBe(1);
  });

  it("lines are correlated by lineKey, never array position -- a removed line in the middle does not misattribute later lines as modified", () => {
    const oldLines = [line({ lineKey: "a", description: "First" }), line({ lineKey: "b", description: "Second" }), line({ lineKey: "c", description: "Third" })];
    const newLines = [line({ lineKey: "a", description: "First" }), line({ lineKey: "c", description: "Third" })];
    const diff = computePurchaseDocumentDiff(header(), oldLines, header(), newLines);
    expect(diff.lineChanges).toEqual([expect.objectContaining({ lineKey: "b", kind: "removed" })]);
    expect(purchaseDocumentDiffCount(diff)).toBe(1);
  });

  it("a line with no lineKey is ignored by correlation (defensive; should not occur with a well-behaved client)", () => {
    const diff = computePurchaseDocumentDiff(header(), [line({ lineKey: null })], header(), [line({ lineKey: null })]);
    expect(diff.lineChanges).toEqual([]);
  });
});

describe("purchaseDocumentDiffCount", () => {
  it("counts header + line changes together", () => {
    const diff = computePurchaseDocumentDiff(
      header({ total: 100 }),
      [line({ lineKey: "a", unitPrice: 10 })],
      header({ total: 200 }),
      [line({ lineKey: "a", unitPrice: 20 }), line({ lineKey: "b" })]
    );
    // 1 header change (total) + 1 modified field (unitPrice) + 1 added line = 3
    expect(purchaseDocumentDiffCount(diff)).toBe(3);
  });
});
