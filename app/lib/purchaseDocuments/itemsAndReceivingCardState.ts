import type { ReceivingLineDraft } from "@/app/lib/receiving/mergeReceivingLineState";
import type { LineOutcome } from "@/app/lib/purchaseDocuments/combinedLineReadiness";

/**
 * Redesign: pure card expand/collapse and bulk-receiving-action logic for
 * the combined "Confirm Items & Receiving" step -- extracted so it's
 * directly unit-testable without mounting ItemsAndReceivingPanel.tsx
 * (same "pure logic in app/lib, rendering in the component" split used
 * throughout this codebase).
 */

/** A ready or correctly-classified-expense line is compact/collapsed by
 * default; a line needing attention auto-expands so the manager sees the
 * problem immediately, never buried under a click. */
export function defaultExpandedForOutcome(outcome: LineOutcome): boolean {
  return outcome === "needs_attention";
}

/** A card's actual expanded state is its default, unless the manager has
 * explicitly toggled it -- toggling flips it relative to ITS OWN default,
 * so a manager who collapses a problem card to work on something else can
 * still reopen it, and a ready card they inspect stays open until they
 * collapse it again. */
export function isCardExpanded(outcome: LineOutcome, toggled: boolean): boolean {
  const def = defaultExpandedForOutcome(outcome);
  return toggled ? !def : def;
}

/** A receiving draft line is ready once it has a quantity, a verified
 * measurement if the package requires one, and a destination location --
 * the same completeness ReceivingPanel's own lineIsReady already used,
 * reused here as the SAME fact that also drives the combined step's own
 * per-line outcome (combinedLineReadiness.ts) and the card's collapsed
 * summary, never a second, independently-recomputed copy. */
export function receivingLineIsReady(l: {
  receivedQuantity: string;
  verifiedQuantity: string;
  locationId: string;
  info: Pick<ReceivingLineDraft["info"], "requiresVerifiedMeasurement">;
}): boolean {
  if (l.receivedQuantity.trim() === "") return false;
  if (l.info.requiresVerifiedMeasurement && l.verifiedQuantity.trim() === "") return false;
  if (l.locationId.trim() === "") return false;
  return true;
}

/** "Apply location to all inventory items" -- fills GAPS only, exactly
 * like mergeReceivingLineState's own prefill semantics: a location the
 * manager (or an item's own remembered default) already set for a line is
 * never overwritten just because a bulk default was applied. Never
 * touches item matches, units, or package conversions. */
export function applyLocationToAll<T extends { locationId: string }>(lines: T[], locationId: string): T[] {
  if (!locationId) return lines;
  return lines.map((l) => (l.locationId ? l : { ...l, locationId }));
}

/** "Apply condition to all" -- a deliberate bulk action, so (unlike
 * location) it overwrites every line's condition, but ONLY lines the
 * manager has actually started receiving (a non-blank quantity) -- a line
 * with nothing entered yet isn't "eligible" for a condition bulk-set.
 * Never touches item matches, units, or package conversions. */
export function applyConditionToAll<T extends { receivedQuantity: string; conditionStatus: string }>(lines: T[], condition: T["conditionStatus"]): T[] {
  return lines.map((l) => (l.receivedQuantity.trim() !== "" ? { ...l, conditionStatus: condition } : l));
}
