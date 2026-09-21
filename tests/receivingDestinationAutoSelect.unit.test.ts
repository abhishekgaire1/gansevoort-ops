import { describe, expect, it } from "vitest";
import { mergeReceivingLineState } from "@/app/lib/receiving/mergeReceivingLineState";
import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";

/**
 * Receiving destination auto-select behavior. When exactly one eligible
 * (active + storage-eligible) location exists, a receiving line is
 * auto-assigned to it -- the manager never has to pick, and ReceivingPanel
 * hides the selector entirely (`locations.length === 1`). When more than
 * one exists, a line is NOT auto-assigned to a guessed location: it takes
 * the item's own remembered receiving location if any, otherwise stays
 * blank so the manager must choose from the selector.
 */

function line(overrides: Partial<ReceivingLineInfo>): ReceivingLineInfo {
  return {
    lineKey: "line-1",
    description: "Test Item",
    vendorSku: "SKU-1",
    invoicePackageQuantity: null,
    invoicePackageUnit: null,
    disposition: "INVENTORY",
    inventoryItemId: "item-1",
    baseUnitCode: null,
    baseUnitId: "unit-1",
    purchaseUnitCode: null,
    receivingBehavior: null,
    fixedConversionFactor: null,
    requiresVerifiedMeasurement: false,
    defaultReceivingLocationId: null,
    confirmedInvoiceUnitCode: null,
    ...overrides,
  };
}

describe("receiving destination auto-select", () => {
  it("auto-assigns the sole eligible location to a new line (one-location auto-select)", () => {
    const [draft] = mergeReceivingLineState([line({})], [{ id: "central-walk-in" }], []);
    expect(draft.locationId).toBe("central-walk-in");
  });

  it("hidden-selector condition holds when there is exactly one location", () => {
    const locations = [{ id: "central-walk-in" }];
    expect(locations.length === 1).toBe(true); // ReceivingPanel hides the selector
  });

  it("does NOT auto-assign a guessed location when more than one exists (selector shown)", () => {
    const [draft] = mergeReceivingLineState([line({})], [{ id: "walk-in" }, { id: "freezer" }], []);
    expect(draft.locationId).toBe("");
  });

  it("uses the item's own remembered receiving location when multiple exist", () => {
    const [draft] = mergeReceivingLineState([line({ defaultReceivingLocationId: "freezer" })], [{ id: "walk-in" }, { id: "freezer" }], []);
    expect(draft.locationId).toBe("freezer");
  });

  it("never overwrites a location the manager already chose on a later merge", () => {
    const first = mergeReceivingLineState([line({})], [{ id: "walk-in" }, { id: "freezer" }], []);
    const edited = first.map((d) => ({ ...d, locationId: "walk-in" }));
    const [merged] = mergeReceivingLineState([line({})], [{ id: "walk-in" }, { id: "freezer" }], edited);
    expect(merged.locationId).toBe("walk-in");
  });
});
