import { describe, expect, it } from "vitest";
import { computeItemMappingProgress, type ItemMappingProgressLine } from "@/app/lib/purchaseDocuments/itemMappingProgress";

/**
 * Step 2 (Confirm Items) completion -- fix for a confirmed defect: a
 * CONFIRMED line with an unresolved purchase-package mismatch used to
 * count as fully resolved (the mismatch only surfaced later, at "Ready to
 * Post" time). Shared by ItemMappingPanel.tsx's own gate/unresolved-count
 * and PreparationWizard.tsx's step-2-complete signal -- see
 * itemMappingProgress.ts.
 */

function line(overrides: Partial<ItemMappingProgressLine>): ItemMappingProgressLine {
  return { lineKey: "line-1", status: "CONFIRMED", disposition: "INVENTORY", hasPackageMismatch: false, ...overrides };
}

describe("computeItemMappingProgress", () => {
  it("a mismatched inventory line cannot complete approval -- allResolved is false even though every line is otherwise CONFIRMED", () => {
    const progress = computeItemMappingProgress([line({ lineKey: "a" }), line({ lineKey: "b", hasPackageMismatch: true })]);
    expect(progress.allResolved).toBe(false);
    expect(progress.mismatchedLineKeys).toEqual(["b"]);
  });

  it("the unresolved count includes both not-yet-CONFIRMED lines and CONFIRMED lines with an unresolved mismatch", () => {
    const progress = computeItemMappingProgress([
      line({ lineKey: "a", status: "PENDING_REVIEW" }),
      line({ lineKey: "b", hasPackageMismatch: true }),
      line({ lineKey: "c" }),
    ]);
    expect(progress.unresolvedLineKeys).toEqual(["a", "b"]);
  });

  it("correcting the mismatch (hasPackageMismatch flips to false) preserves every other already-resolved line and clears allResolved to true", () => {
    const beforeCorrection = computeItemMappingProgress([line({ lineKey: "a" }), line({ lineKey: "b", hasPackageMismatch: true }), line({ lineKey: "c" })]);
    expect(beforeCorrection.allResolved).toBe(false);

    const afterCorrection = computeItemMappingProgress([line({ lineKey: "a" }), line({ lineKey: "b", hasPackageMismatch: false }), line({ lineKey: "c" })]);
    expect(afterCorrection.allResolved).toBe(true);
    expect(afterCorrection.unresolvedLineKeys).toEqual([]);
  });

  it("an expense (NON_INVENTORY) line is never counted as a mismatch blocker, even if hasPackageMismatch were somehow true", () => {
    const progress = computeItemMappingProgress([line({ lineKey: "a", disposition: "NON_INVENTORY" })]);
    expect(progress.allResolved).toBe(true);
    expect(progress.mismatchedLineKeys).toEqual([]);
  });

  it("passes normally (allResolved true) when every line is CONFIRMED with no mismatch", () => {
    const progress = computeItemMappingProgress([line({ lineKey: "a" }), line({ lineKey: "b", disposition: "NON_INVENTORY" })]);
    expect(progress.allResolved).toBe(true);
  });

  it("an empty document is never treated as resolved", () => {
    expect(computeItemMappingProgress([]).allResolved).toBe(false);
  });
});
