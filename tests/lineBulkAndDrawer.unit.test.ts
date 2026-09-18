import { describe, it, expect } from "vitest";
import {
  applyPatchToSelected,
  deriveLineActionScopes,
  drawerIsDirty,
  lineIsBulkSelectable,
  selectedInventoryCount,
} from "@/app/lib/purchaseDocuments/lineBulkAndDrawer";

describe("lineIsBulkSelectable", () => {
  it("selects editable inventory lines", () => {
    expect(lineIsBulkSelectable({ disposition: "INVENTORY" }, false)).toBe(true);
  });
  it("never selects expenses", () => {
    expect(lineIsBulkSelectable({ disposition: "NON_INVENTORY" }, false)).toBe(false);
  });
  it("never selects in a read-only (already-posted) view", () => {
    expect(lineIsBulkSelectable({ disposition: "INVENTORY" }, true)).toBe(false);
  });
});

describe("applyPatchToSelected", () => {
  const rows = [
    { lineKey: "a", locationId: "", conditionStatus: "RECEIVED_AS_INVOICED" },
    { lineKey: "b", locationId: "", conditionStatus: "RECEIVED_AS_INVOICED" },
    { lineKey: "c", locationId: "", conditionStatus: "RECEIVED_AS_INVOICED" },
  ];

  it("patches only selected rows and leaves others untouched", () => {
    const out = applyPatchToSelected(rows, new Set(["a", "c"]), { locationId: "loc-1" });
    expect(out.map((r) => r.locationId)).toEqual(["loc-1", "", "loc-1"]);
  });

  it("only writes the fields present in the patch", () => {
    const out = applyPatchToSelected(rows, new Set(["b"]), { conditionStatus: "DAMAGED" });
    expect(out[1]).toEqual({ lineKey: "b", locationId: "", conditionStatus: "DAMAGED" });
    // untouched rows keep their identity fields
    expect(out[0].conditionStatus).toBe("RECEIVED_AS_INVOICED");
  });

  it("returns the same rows when nothing is selected", () => {
    const out = applyPatchToSelected(rows, new Set(), { locationId: "loc-9" });
    expect(out).toBe(rows);
  });

  it("does not mutate the input rows", () => {
    const before = JSON.parse(JSON.stringify(rows));
    applyPatchToSelected(rows, new Set(["a"]), { locationId: "loc-1" });
    expect(rows).toEqual(before);
  });
});

describe("selectedInventoryCount", () => {
  it("counts only selected keys that still exist", () => {
    const rows = [{ lineKey: "a" }, { lineKey: "b" }];
    expect(selectedInventoryCount(rows, new Set(["a", "gone"]))).toBe(1);
  });
});

describe("deriveLineActionScopes", () => {
  it("offers package/receiving + registered item for a matched editable line", () => {
    expect(deriveLineActionScopes({ readOnly: false, showPackageAndReceiving: true, priceCheckTone: "neutral" })).toEqual([
      "correct-invoice",
      "vendor-package",
      "registered-item",
    ]);
  });

  it("adds price-change only for notable (info/warning) tones", () => {
    expect(deriveLineActionScopes({ readOnly: false, showPackageAndReceiving: true, priceCheckTone: "warning" })).toContain("price-change");
    expect(deriveLineActionScopes({ readOnly: false, showPackageAndReceiving: true, priceCheckTone: "info" })).toContain("price-change");
    expect(deriveLineActionScopes({ readOnly: false, showPackageAndReceiving: true, priceCheckTone: "success" })).not.toContain("price-change");
    expect(deriveLineActionScopes({ readOnly: false, showPackageAndReceiving: true, priceCheckTone: null })).not.toContain("price-change");
  });

  it("drops the registered-item scope in a read-only view", () => {
    expect(deriveLineActionScopes({ readOnly: true, showPackageAndReceiving: true, priceCheckTone: null })).not.toContain("registered-item");
  });

  it("returns nothing actionable for a read-only, unmatched, unchanged line", () => {
    expect(deriveLineActionScopes({ readOnly: true, showPackageAndReceiving: false, priceCheckTone: null })).toEqual([]);
  });

  it("keeps a stable A->D order", () => {
    const out = deriveLineActionScopes({ readOnly: false, showPackageAndReceiving: true, priceCheckTone: "warning" });
    expect(out).toEqual(["correct-invoice", "vendor-package", "price-change", "registered-item"]);
  });
});

describe("drawerIsDirty", () => {
  it("is dirty when a local edit form is open", () => {
    expect(drawerIsDirty({ overrideFormOpen: true, correcting: false })).toBe(true);
    expect(drawerIsDirty({ overrideFormOpen: false, correcting: true })).toBe(true);
  });
  it("is clean when no local form is open (lifted drafts persist)", () => {
    expect(drawerIsDirty({ overrideFormOpen: false, correcting: false })).toBe(false);
  });
});
