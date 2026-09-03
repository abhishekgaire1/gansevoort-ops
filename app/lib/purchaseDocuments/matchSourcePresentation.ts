import type { LineClassificationRow } from "@/app/actions/itemClassification";

/**
 * Receiving UX pass, Part 12-16: pure, framework-free presentation logic
 * for Confirm Items & Receiving's inline resolved-line display --
 * separated from ItemsAndReceivingPanel.tsx (same "pure logic in app/lib,
 * rendering in the component" split already used throughout this
 * codebase, e.g.
 * classificationMatchingOutcome.ts, receivingPresentation.ts) so it's
 * directly unit-testable without mounting the component or touching a
 * database/AI call.
 *
 * matchSourceLabel is the single source of truth for HOW a resolved line
 * is described to a manager -- never a raw pipeline term
 * (resolution_source/disposition/approval_status), and never a false
 * "approved" label for something the backend hasn't actually confirmed
 * (this function is only ever called for a CONFIRMED line to begin with).
 * Every branch is derived from durable, already-loaded data:
 *   - resolutionSource on the deterministic tiers (VENDOR_SKU_MAPPING /
 *     VENDOR_DESCRIPTION_MAPPING) is set once by the zero-AI-call tier and
 *     never rewritten by a later manual approval.
 *   - inventoryItemCreatedVia is set ONCE at item creation and survives
 *     approval_status flipping to CONFIRMED -- unlike
 *     aiSuggestedIsNewProposal, which is computed from the AI-candidate
 *     item's CURRENT approval_status and therefore reads false again the
 *     instant a new-item proposal is approved (its approval_status becomes
 *     CONFIRMED too), making it useless for a post-approval label.
 *   - aiSuggestedInventoryItemId still matching the confirmed
 *     inventoryItemId is real evidence the manager approved exactly what
 *     was suggested, not an assumption.
 */
export interface MatchSource {
  label: string;
  sublabel: string;
}

export function matchSourceLabel(line: LineClassificationRow): MatchSource {
  if (line.resolutionSource === "VENDOR_SKU_MAPPING" || line.resolutionSource === "VENDOR_DESCRIPTION_MAPPING") {
    return { label: "Known Mapping", sublabel: "Previously approved" };
  }
  if (line.disposition === "NON_INVENTORY") {
    return { label: "Non-Inventory", sublabel: "Manager approved" };
  }
  if (line.inventoryItemCreatedVia === "AI_PROPOSED" && line.aiSuggestedInventoryItemId && line.aiSuggestedInventoryItemId === line.inventoryItemId) {
    return { label: "New Item", sublabel: "Manager approved" };
  }
  if (line.aiSuggestedInventoryItemId && line.aiSuggestedInventoryItemId === line.inventoryItemId && line.aiConfidence !== null) {
    return { label: "AI Suggested", sublabel: "Manager approved" };
  }
  return { label: "Manager Approved", sublabel: "" };
}

/** The invoice's own stated quantity/pack for the SOURCE side of a line --
 * package quantity+unit takes priority (what the vendor actually
 * shipped/billed in), falling back to a measured quantity+unit only when
 * no package figure was extracted. Never fabricates a unit the invoice
 * didn't state. */
export function formatSourceQuantity(line: LineClassificationRow): string | null {
  if (line.packageQuantity !== null && line.packageUnit) return `${line.packageQuantity} ${line.packageUnit}`;
  if (line.measuredQuantity !== null && line.measuredUnit) return `${line.measuredQuantity} ${line.measuredUnit}`;
  return null;
}
