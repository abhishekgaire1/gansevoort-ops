import { describe, expect, it } from "vitest";
import { defaultDispositionForVendor } from "@/app/lib/itemMaster/defaultDispositionForVendor";
import { vendorClassificationLabel, vendorOptionLabel } from "@/app/lib/vendors/vendorPresentation";

/**
 * Vendor classification (INVENTORY vs NON_INVENTORY vendors) -- the
 * vendor-aware disposition DEFAULT and the shared picker/badge labels.
 * The rule is a default, never a restriction: the classification form's
 * disposition select stays visible and overridable per line.
 */

describe("defaultDispositionForVendor", () => {
  it("a NON_INVENTORY vendor's lines default to Non-inventory regardless of the AI proposal", () => {
    expect(defaultDispositionForVendor("NON_INVENTORY", "INVENTORY")).toBe("NON_INVENTORY");
    expect(defaultDispositionForVendor("NON_INVENTORY", "NON_INVENTORY")).toBe("NON_INVENTORY");
    expect(defaultDispositionForVendor("NON_INVENTORY", null)).toBe("NON_INVENTORY");
  });

  it("an INVENTORY vendor preserves the pre-existing behavior exactly: AI proposal, else INVENTORY", () => {
    expect(defaultDispositionForVendor("INVENTORY", "INVENTORY")).toBe("INVENTORY");
    expect(defaultDispositionForVendor("INVENTORY", "NON_INVENTORY")).toBe("NON_INVENTORY");
    expect(defaultDispositionForVendor("INVENTORY", null)).toBe("INVENTORY");
  });

  it("an unknown/missing vendor classification behaves exactly like INVENTORY (no behavior change for legacy paths)", () => {
    expect(defaultDispositionForVendor(null, "NON_INVENTORY")).toBe("NON_INVENTORY");
    expect(defaultDispositionForVendor(null, null)).toBe("INVENTORY");
    expect(defaultDispositionForVendor(undefined, "INVENTORY")).toBe("INVENTORY");
    expect(defaultDispositionForVendor(undefined, undefined)).toBe("INVENTORY");
  });
});

describe("vendor presentation labels", () => {
  it("uses the item-side identity vocabulary: Inventory / Non-inventory", () => {
    expect(vendorClassificationLabel("INVENTORY")).toBe("Inventory");
    expect(vendorClassificationLabel("NON_INVENTORY")).toBe("Non-inventory");
  });

  it("suffixes picker options ONLY for Non-inventory vendors -- inventory suppliers are the unbadged norm", () => {
    expect(vendorOptionLabel({ name: "Baldor", classification: "INVENTORY" })).toBe("Baldor");
    expect(vendorOptionLabel({ name: "Office Depot", classification: "NON_INVENTORY" })).toBe("Office Depot — Non-inventory");
  });
});
