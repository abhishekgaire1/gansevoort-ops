import { missingReceivingReason } from "@/app/lib/purchaseDocuments/itemsAndReceivingCardState";

export type LineIssueSection = "item_match" | "package" | "receiving";

export interface LineIssueSummary {
  section: LineIssueSection;
  text: string;
}

export interface DescribeLineIssueInput {
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  isNewItemProposal: boolean;
  hasPackageMismatch: boolean;
  receiving: {
    receivedQuantity: string;
    verifiedQuantity: string;
    locationId: string;
    info: { requiresVerifiedMeasurement: boolean; baseUnitCode: string | null };
  } | null;
}

/**
 * The ONE blocking reason a needs_attention line's compact row shows --
 * checked in the exact same priority order classifyLineOutcome uses (item
 * match, then purchase package, then receiving), so the short message
 * always matches the specific check that's actually failing, never a
 * generic "needs attention" that disagrees with what the expanded editor
 * shows. Returns null for a line that isn't actually needs_attention
 * (CONFIRMED + NON_INVENTORY is "expense," never needs_attention).
 */
export function describeLineIssue(input: DescribeLineIssueInput): LineIssueSummary | null {
  if (input.status !== "CONFIRMED") {
    return { section: "item_match", text: input.isNewItemProposal ? "New item needs verification" : "No item match yet" };
  }
  if (input.disposition !== "INVENTORY") return null;
  if (input.hasPackageMismatch) return { section: "package", text: "Purchase package needs review" };
  if (!input.receiving) return { section: "receiving", text: "Receiving details not started." };
  return { section: "receiving", text: missingReceivingReason(input.receiving) };
}
