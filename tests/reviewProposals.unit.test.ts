import { describe, expect, it } from "vitest";
import { blockersUnresolvedByProposals, proposalCount } from "@/app/lib/purchaseDocuments/reviewProposals";
import type { PreparationBlocker } from "@/app/lib/purchaseDocuments/preparationBlockers";

/**
 * The UI-preview courtesy filter for Manager 2's provisional overlay:
 * a pending proposal on a line may provisionally cover that line's
 * matching blocker so Final Verify isn't dead-locked behind a blocker
 * whose fix IS the pending correction -- but the filter is never the
 * authority (verify re-runs the real gates on the promoted state).
 */
describe("blockersUnresolvedByProposals", () => {
  const mappingBlocker: PreparationBlocker = { lineKey: "L1", description: "Cream", reason: "Awaiting manager approval of the item match." };
  const staleBlocker: PreparationBlocker = { lineKey: "L1", description: "Cream", reason: "Line changed since it was classified -- needs re-review." };
  const receivingConfigBlocker: PreparationBlocker = {
    lineKey: "L2",
    description: "Radish",
    reason: "Receiving needs review -- this item's unit configuration changed after the delivery was recorded. Re-confirm the line via Edit Receiving.",
  };
  const missingReceiptBlocker: PreparationBlocker = { lineKey: "L3", description: "Butter", reason: "Not yet received -- record a delivery quantity." };
  const documentBlocker: PreparationBlocker = { lineKey: null, description: null, reason: "Delivery verified by is required before sending for final review -- this document has inventory lines." };

  it("a mapping proposal provisionally covers that line's classification blockers only", () => {
    const result = blockersUnresolvedByProposals([mappingBlocker, staleBlocker, missingReceiptBlocker], new Set(["L1"]), new Set());
    expect(result).toEqual([missingReceiptBlocker]);
  });

  it("a receiving proposal provisionally covers that line's receiving-needs-review blocker", () => {
    const result = blockersUnresolvedByProposals([receivingConfigBlocker], new Set(), new Set(["L2"]));
    expect(result).toEqual([]);
  });

  it("a receiving proposal never covers a MISSING receipt -- proposals only correct existing receipt lines", () => {
    const result = blockersUnresolvedByProposals([missingReceiptBlocker], new Set(), new Set(["L3"]));
    expect(result).toEqual([missingReceiptBlocker]);
  });

  it("document-level blockers are never filtered, whatever proposals exist", () => {
    const result = blockersUnresolvedByProposals([documentBlocker], new Set(["L1", "L2", "L3"]), new Set(["L1", "L2", "L3"]));
    expect(result).toEqual([documentBlocker]);
  });

  it("proposals on OTHER lines cover nothing", () => {
    const result = blockersUnresolvedByProposals([mappingBlocker], new Set(["L9"]), new Set(["L9"]));
    expect(result).toEqual([mappingBlocker]);
  });
});

describe("proposalCount", () => {
  it("counts one per proposed line mapping plus one per proposed receipt line", () => {
    expect(proposalCount({}, {})).toBe(0);
    expect(
      proposalCount(
        { L1: { inventoryItemId: "i1" } },
        {
          r1: { receivedQuantity: 1, receivedUnit: "CS", verifiedBaseQuantity: 10, locationId: null, conditionStatus: "SHORT" },
          r2: { receivedQuantity: 2, receivedUnit: null, verifiedBaseQuantity: null, locationId: null, conditionStatus: "RECEIVED_AS_INVOICED" },
        }
      )
    ).toBe(3);
  });
});
