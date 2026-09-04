import { describe, expect, it } from "vitest";
import { isLineInvoiceUnitResolved, reconcileStaleUnitFlags, buildResolvedUnitNotes } from "@/app/lib/purchaseDocuments/lineUnitResolution";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Step 1's "invoice quantity unit could not be identified" warning must
 * never stay stale once Step 2 has authoritatively resolved it (a
 * confirmed item match always carries a real effective purchase unit),
 * and must genuinely reappear if that resolution is later invalidated
 * (STALE).
 */

const missingPackageUnitFlag = (index: number): ReviewFlag => ({
  severity: "warning",
  code: "LINE_MISSING_PACKAGE_UNIT",
  field: `lines[${index}].packageUnit`,
  message: `Line ${index + 1} has a package quantity but no package unit.`,
});

const missingMeasuredUnitFlag = (index: number): ReviewFlag => ({
  severity: "warning",
  code: "LINE_MISSING_MEASURED_UNIT",
  field: `lines[${index}].measuredUnit`,
  message: `Line ${index + 1} has a measured quantity but no measured unit.`,
});

const unrelatedFlag: ReviewFlag = { severity: "error", code: "MISSING_VENDOR", field: "vendorId", message: "Vendor has not been selected." };

describe("isLineInvoiceUnitResolved", () => {
  it("test: an unresolved (unclassified/pending) line is never treated as resolved", () => {
    expect(isLineInvoiceUnitResolved("UNCLASSIFIED")).toBe(false);
    expect(isLineInvoiceUnitResolved("PENDING_REVIEW")).toBe(false);
    expect(isLineInvoiceUnitResolved(undefined)).toBe(false);
  });

  it("test: a CONFIRMED classification is resolved -- it always carries a real effective unit (vendor package or item base unit)", () => {
    expect(isLineInvoiceUnitResolved("CONFIRMED")).toBe(true);
  });

  it("test: a later-invalidated (STALE) line is never treated as resolved -- the warning must genuinely reappear", () => {
    expect(isLineInvoiceUnitResolved("STALE")).toBe(false);
  });
});

describe("reconcileStaleUnitFlags", () => {
  const lines = [{ lineKey: "line-a" }, { lineKey: "line-b" }, { lineKey: "line-c" }];

  it("test: a genuinely unresolved line's flag is kept", () => {
    const result = reconcileStaleUnitFlags([missingPackageUnitFlag(0)], lines, new Set());
    expect(result).toHaveLength(1);
  });

  it("test: a resolved line's flag is dropped", () => {
    const result = reconcileStaleUnitFlags([missingPackageUnitFlag(0)], lines, new Set(["line-a"]));
    expect(result).toHaveLength(0);
  });

  it("only drops the resolved line's own flag -- an unrelated line's identical-shaped flag is untouched", () => {
    const result = reconcileStaleUnitFlags([missingPackageUnitFlag(0), missingPackageUnitFlag(1)], lines, new Set(["line-a"]));
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("lines[1].packageUnit");
  });

  it("handles the measured-unit variant identically", () => {
    expect(reconcileStaleUnitFlags([missingMeasuredUnitFlag(2)], lines, new Set(["line-c"]))).toHaveLength(0);
    expect(reconcileStaleUnitFlags([missingMeasuredUnitFlag(2)], lines, new Set())).toHaveLength(1);
  });

  it("never touches an unrelated flag code, regardless of resolved set", () => {
    const result = reconcileStaleUnitFlags([unrelatedFlag], lines, new Set(["line-a", "line-b", "line-c"]));
    expect(result).toEqual([unrelatedFlag]);
  });

  it("a flag with no parseable field path (or pointing past the end of lines) is kept rather than silently dropped", () => {
    const noField: ReviewFlag = { severity: "warning", code: "LINE_MISSING_PACKAGE_UNIT", message: "no field" };
    expect(reconcileStaleUnitFlags([noField], lines, new Set(["line-a"]))).toHaveLength(1);
  });
});

describe("buildResolvedUnitNotes", () => {
  const lines = [{ lineKey: "line-a" }, { lineKey: "line-b" }];

  it("test: shows the resolution source (matched item + unit) only for a line that was genuinely flagged and is now CONFIRMED", () => {
    const notes = buildResolvedUnitNotes(
      [missingPackageUnitFlag(0)],
      lines,
      [{ lineKey: "line-a", status: "CONFIRMED", inventoryItemName: "Farmland Sour Cream 10lb", effectivePurchaseUnitCode: "LB" }]
    );
    expect(notes).toEqual([{ lineKey: "line-a", itemName: "Farmland Sour Cream 10lb", unitCode: "LB" }]);
  });

  it("never fabricates a note for a line that was never flagged in the first place", () => {
    const notes = buildResolvedUnitNotes(
      [],
      lines,
      [{ lineKey: "line-a", status: "CONFIRMED", inventoryItemName: "Farmland Sour Cream 10lb", effectivePurchaseUnitCode: "LB" }]
    );
    expect(notes).toHaveLength(0);
  });

  it("never shows a note for a flagged line that is still unresolved (PENDING_REVIEW/STALE)", () => {
    const pending = buildResolvedUnitNotes([missingPackageUnitFlag(0)], lines, [{ lineKey: "line-a", status: "PENDING_REVIEW", inventoryItemName: null, effectivePurchaseUnitCode: null }]);
    expect(pending).toHaveLength(0);
    const stale = buildResolvedUnitNotes([missingPackageUnitFlag(1)], lines, [{ lineKey: "line-b", status: "STALE", inventoryItemName: "Whole Milk Quart", effectivePurchaseUnitCode: "PIECE" }]);
    expect(stale).toHaveLength(0);
  });
});
