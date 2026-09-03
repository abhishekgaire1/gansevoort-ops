import { describe, expect, it } from "vitest";
import {
  defaultExpandedForOutcome,
  isCardExpanded,
  receivingLineIsReady,
  applyLocationToAll,
  applyConditionToAll,
  summarizeBulkLocations,
  missingReceivingReason,
} from "@/app/lib/purchaseDocuments/itemsAndReceivingCardState";

/**
 * Redesign: pure card expand/collapse and bulk-receiving-action logic for
 * the combined "Confirm Items & Receiving" step.
 */

describe("defaultExpandedForOutcome / isCardExpanded", () => {
  it("test 3: a ready line is collapsed by default", () => {
    expect(defaultExpandedForOutcome("ready")).toBe(false);
    expect(isCardExpanded("ready", false)).toBe(false);
  });

  it("test 3 (component of): an expense line is also collapsed by default -- compact, like a ready line", () => {
    expect(defaultExpandedForOutcome("expense")).toBe(false);
  });

  it("test 4: a line needing attention auto-expands by default", () => {
    expect(defaultExpandedForOutcome("needs_attention")).toBe(true);
    expect(isCardExpanded("needs_attention", false)).toBe(true);
  });

  it("toggling flips a card relative to its OWN default -- a manager can still collapse a problem card or expand a ready one", () => {
    expect(isCardExpanded("needs_attention", true)).toBe(false); // collapsed despite needing attention
    expect(isCardExpanded("ready", true)).toBe(true); // expanded despite being ready
  });
});

describe("receivingLineIsReady", () => {
  const base = { receivedQuantity: "2", verifiedQuantity: "", locationId: "loc-1", info: { requiresVerifiedMeasurement: false } };

  it("test 6 (component of): ready once quantity and location are present and no measurement is required", () => {
    expect(receivingLineIsReady(base)).toBe(true);
  });

  it("test 7: a package requiring an actual measurement is never ready without one, even with a quantity and location", () => {
    expect(receivingLineIsReady({ ...base, info: { requiresVerifiedMeasurement: true } })).toBe(false);
    expect(receivingLineIsReady({ ...base, info: { requiresVerifiedMeasurement: true }, verifiedQuantity: "38.6" })).toBe(true);
  });

  it("is never ready without a received quantity or a destination location", () => {
    expect(receivingLineIsReady({ ...base, receivedQuantity: "" })).toBe(false);
    expect(receivingLineIsReady({ ...base, locationId: "" })).toBe(false);
  });
});

describe("applyLocationToAll / applyConditionToAll (bulk actions)", () => {
  it("test 12: applying a bulk location fills gaps only -- a line that already has a location is never overwritten", () => {
    const lines = [
      { key: "a", locationId: "" },
      { key: "b", locationId: "existing-loc" },
    ];
    const result = applyLocationToAll(lines, "bulk-loc");
    expect(result.find((l) => l.key === "a")?.locationId).toBe("bulk-loc");
    expect(result.find((l) => l.key === "b")?.locationId).toBe("existing-loc");
  });

  it("does nothing when no bulk location is selected", () => {
    const lines = [{ key: "a", locationId: "" }];
    expect(applyLocationToAll(lines, "")).toEqual(lines);
  });

  it("test 12: applying a bulk condition only affects lines the manager has actually started receiving (a non-blank quantity) -- never an untouched line", () => {
    const lines = [
      { key: "a", receivedQuantity: "2", conditionStatus: "RECEIVED_AS_INVOICED" },
      { key: "b", receivedQuantity: "", conditionStatus: "RECEIVED_AS_INVOICED" },
    ];
    const result = applyConditionToAll(lines, "DAMAGED");
    expect(result.find((l) => l.key === "a")?.conditionStatus).toBe("DAMAGED");
    expect(result.find((l) => l.key === "b")?.conditionStatus).toBe("RECEIVED_AS_INVOICED");
  });

  it("never touches item matches, units, or conversions -- only the location/condition fields it's given", () => {
    const lines = [{ key: "a", locationId: "", itemId: "item-1", purchaseUnitCode: "CASE" }];
    const result = applyLocationToAll(lines, "loc");
    expect(result[0].itemId).toBe("item-1");
    expect(result[0].purchaseUnitCode).toBe("CASE");
  });
});

describe("summarizeBulkLocations", () => {
  it("test 10: reports Multiple locations when eligible lines disagree, instead of a misleadingly blank Select", () => {
    expect(summarizeBulkLocations(["loc-a", "loc-b"])).toEqual({ kind: "multiple", locationId: null });
  });

  it("reports the shared location when every eligible line agrees", () => {
    expect(summarizeBulkLocations(["loc-a", "loc-a", "loc-a"])).toEqual({ kind: "single", locationId: "loc-a" });
  });

  it("ignores lines with no location set yet when determining agreement", () => {
    expect(summarizeBulkLocations(["loc-a", null, "loc-a"])).toEqual({ kind: "single", locationId: "loc-a" });
  });

  it("reports none when nothing is set anywhere", () => {
    expect(summarizeBulkLocations([null, null])).toEqual({ kind: "none", locationId: null });
  });
});

describe("missingReceivingReason", () => {
  const base = { receivedQuantity: "2", verifiedQuantity: "", locationId: "loc-1", info: { requiresVerifiedMeasurement: false, baseUnitCode: "LB" } };

  it("test 5: identifies a missing received quantity as the incomplete check", () => {
    expect(missingReceivingReason({ ...base, receivedQuantity: "" })).toBe("Enter the received quantity.");
  });

  it("test 5: identifies a missing required verified measurement, naming the specific unit", () => {
    expect(missingReceivingReason({ ...base, info: { requiresVerifiedMeasurement: true, baseUnitCode: "LB" } })).toBe("Enter the verified LB.");
  });

  it("test 5: identifies a missing storage location once quantity (and any required measurement) is present", () => {
    expect(missingReceivingReason({ ...base, locationId: "" })).toBe("Choose a storage location.");
  });
});
