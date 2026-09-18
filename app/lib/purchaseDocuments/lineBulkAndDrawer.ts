/**
 * Pure decision logic for two Step-2 line features:
 *  - selection-based bulk location/condition actions, and
 *  - the unified four-scope line-action drawer.
 *
 * Kept free of React so it can be unit-tested directly (the components in
 * ItemsAndReceivingPanel / LineActionDrawer only wire these into state).
 */

export type LineActionScope = "correct-invoice" | "vendor-package" | "price-change" | "registered-item";

export type LineDisposition = "INVENTORY" | "NON_INVENTORY";

/**
 * A line may be selected for a bulk location/condition action only when it is
 * an editable inventory line. Expenses and read-only (already-posted) views are
 * never selectable, so bulk can never touch a protected or non-inventory line.
 */
export function lineIsBulkSelectable(line: { disposition: string }, readOnly: boolean | undefined): boolean {
  return !readOnly && line.disposition === "INVENTORY";
}

/**
 * Apply a patch to exactly the rows whose lineKey is in `selected`, leaving
 * every other row untouched. Used for "Set location" / "Set condition" on the
 * current selection -- it only ever writes the fields present in `patch`.
 */
export function applyPatchToSelected<T extends { lineKey: string }>(rows: T[], selected: Set<string>, patch: Partial<T>): T[] {
  if (selected.size === 0) return rows;
  return rows.map((row) => (selected.has(row.lineKey) ? { ...row, ...patch } : row));
}

/** Count of currently-selected rows that still exist in the row set. */
export function selectedInventoryCount<T extends { lineKey: string }>(rows: T[], selected: Set<string>): number {
  return rows.reduce((n, row) => (selected.has(row.lineKey) ? n + 1 : n), 0);
}

/**
 * Which of the four correction scopes a line's drawer should surface:
 *  - D "Edit registered item safely" whenever the line is editable;
 *  - B "Update vendor purchase package" + A "Correct this invoice only" once
 *    the item is matched and receiving is in play;
 *  - C "Review price change" only when there is a notable (info/warning) change.
 * Returned in the stable A→D presentation order the drawer legend expects.
 */
export function deriveLineActionScopes(opts: {
  readOnly: boolean | undefined;
  showPackageAndReceiving: boolean;
  priceCheckTone: "neutral" | "info" | "success" | "warning" | null;
}): LineActionScope[] {
  const scopes: LineActionScope[] = [];
  if (opts.showPackageAndReceiving) {
    scopes.push("correct-invoice", "vendor-package");
  }
  if (opts.priceCheckTone === "warning" || opts.priceCheckTone === "info") {
    scopes.push("price-change");
  }
  if (!opts.readOnly) {
    scopes.push("registered-item");
  }
  return scopes;
}

/**
 * The drawer is "dirty" (closing risks losing input) only when a locally-held
 * edit form is open. Lifted receiving drafts persist in parent state, so they
 * are not counted -- closing the drawer never silently loses them.
 */
export function drawerIsDirty(opts: { overrideFormOpen: boolean; correcting: boolean }): boolean {
  return opts.overrideFormOpen || opts.correcting;
}
