import { describe, expect, it } from "vitest";
import { inventoryPostingBadgeLabel } from "@/app/lib/purchaseDocuments/getInventoryPostingStatus";

/**
 * 2A.4 note: the pre-2A.4 stub (getInventoryPostingSummary, which could
 * only truthfully return NOT_POSTED before inbound posting existed) is
 * gone -- real status now derives from actual posting records, covered by
 * tests/inventoryPosting.rpc.test.ts against real Postgres. What remains
 * pure and unit-testable here is the badge label mapping.
 */
describe("inventoryPostingBadgeLabel", () => {
  it("shows INVENTORY POSTED language for a fully posted document", () => {
    expect(inventoryPostingBadgeLabel("POSTED")).toBe("Inventory Posted");
  });

  it("shows PARTIALLY POSTED language for a partially posted document", () => {
    expect(inventoryPostingBadgeLabel("PARTIALLY_POSTED")).toBe("Partially Posted");
  });

  it("shows VERIFIED — READY FOR INVENTORY for a verified, unposted document", () => {
    expect(inventoryPostingBadgeLabel("NOT_POSTED")).toBe("Verified — Ready for Inventory");
  });
});
