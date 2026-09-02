/**
 * Step 2 (Confirm Items) completion, as a pure function -- shared by
 * ItemMappingPanel.tsx (the panel's own "Continue to Confirm Receiving"
 * gate and unresolved-issue count) and PreparationWizard.tsx (the
 * wizard's own step-2-complete signal). A CONFIRMED line with an
 * unresolved purchase-package mismatch (see packageUnitMismatch.ts) is
 * NOT resolved, even though its item match itself is correct -- fix for a
 * confirmed defect: this used to only surface at "Ready to Post" time,
 * letting a manager complete Step 2 (and the whole four-step review) with
 * an unresolved mismatch still on the line.
 */

export interface ItemMappingProgressLine {
  lineKey: string;
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  /** Expense (NON_INVENTORY) lines are never blocked by this -- see
   * hasPackageUnitMismatch's own doc comment. */
  hasPackageMismatch: boolean;
}

export interface ItemMappingProgress {
  /** True only when every line is CONFIRMED and no CONFIRMED inventory
   * line has an unresolved purchase-package mismatch. */
  allResolved: boolean;
  /** Every line still needing attention -- either not yet CONFIRMED, or
   * CONFIRMED with an unresolved mismatch -- in original order. */
  unresolvedLineKeys: string[];
  /** The subset of unresolvedLineKeys that are CONFIRMED but blocked
   * specifically by a purchase-package mismatch. */
  mismatchedLineKeys: string[];
}

export function computeItemMappingProgress(lines: ItemMappingProgressLine[]): ItemMappingProgress {
  const needsReview = lines.filter((l) => l.status !== "CONFIRMED");
  const mismatched = lines.filter((l) => l.status === "CONFIRMED" && l.hasPackageMismatch);
  const allResolved = lines.length > 0 && needsReview.length === 0 && mismatched.length === 0;
  return {
    allResolved,
    unresolvedLineKeys: [...needsReview, ...mismatched].map((l) => l.lineKey),
    mismatchedLineKeys: mismatched.map((l) => l.lineKey),
  };
}
