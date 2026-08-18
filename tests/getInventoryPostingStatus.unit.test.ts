import { describe, expect, it } from "vitest";
import { getInventoryPostingSummary, inventoryPostingBadgeLabel } from "@/app/lib/purchaseDocuments/getInventoryPostingStatus";

/**
 * Investigated twice now against real VERIFIED Gansevoort DEV documents
 * (most recently Bartlett #3614450, 9 confirmed INVENTORY lines, fully
 * received): zero inventory_movement_lines exist for any of its items,
 * and the schema has no inbound movement type and no reference column
 * linking a movement to a receipt at all -- so getInventoryPostingSummary
 * can only ever truthfully return NOT_POSTED today, regardless of how
 * complete receiving is. These tests lock in that honest contract (and
 * the separately-testable label mapping for every status, ready for when
 * 2A.4 adds real posting data) rather than fabricating posted data that
 * doesn't exist.
 */

describe("getInventoryPostingSummary", () => {
  it("always returns NOT_POSTED today -- there is no inbound movement type or receipt-to-movement link in the schema yet", () => {
    const summary = getInventoryPostingSummary(9);
    expect(summary.status).toBe("NOT_POSTED");
    expect(summary.postedLineCount).toBe(0);
    expect(summary.postedLines).toEqual([]);
    expect(summary.lastPostedAt).toBeNull();
  });

  it("echoes the given total inventory line count through as the denominator", () => {
    expect(getInventoryPostingSummary(9).totalInventoryLines).toBe(9);
    expect(getInventoryPostingSummary(0).totalInventoryLines).toBe(0);
  });

  it("receipt existence / full receiving completion alone does NOT mark inventory posted -- the function takes no receiving data as input at all, only a line count, and still returns NOT_POSTED", () => {
    // A document with 9/9 lines fully received (the exact real Bartlett
    // case) still has zero inventory_movements -- receiving completeness
    // and inventory posting are different facts.
    const fullyReceivedButUnposted = getInventoryPostingSummary(9);
    expect(fullyReceivedButUnposted.status).toBe("NOT_POSTED");
  });
});

describe("inventoryPostingBadgeLabel", () => {
  it("shows INVENTORY POSTED language for a fully posted document", () => {
    expect(inventoryPostingBadgeLabel("POSTED")).toBe("Inventory Posted");
  });

  it("shows PARTIALLY POSTED language for a partially posted document", () => {
    expect(inventoryPostingBadgeLabel("PARTIALLY_POSTED")).toBe("Verified — Partially Posted");
  });

  it("shows VERIFIED — READY FOR INVENTORY for a verified, unposted document", () => {
    expect(inventoryPostingBadgeLabel("NOT_POSTED")).toBe("Verified — Ready for Inventory");
  });
});
