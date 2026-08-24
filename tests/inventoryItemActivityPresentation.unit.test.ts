import { describe, expect, it } from "vitest";
import {
  movementDisplayLabel,
  movementGlyph,
  actorLabelVerb,
  formatSignedQuantity,
  formatQuantityMagnitude,
  activityDateGroupLabel,
  formatActivityTimestamp,
  groupActivityByDate,
  wasteReasonLabel,
  withdrawalSourceLabel,
} from "@/app/manager/(app)/inventory/_lib/activityPresentation";
import type { InventoryActivityEntry } from "@/app/lib/inventory/itemActivity";

function entry(overrides: Partial<InventoryActivityEntry>): InventoryActivityEntry {
  return {
    id: "line-1",
    movementId: "movement-1",
    movementType: "ISSUE_TO_STATION",
    direction: "OUT",
    quantity: 2,
    baseUnitCode: "PIECE",
    occurredAt: "2026-08-19T12:42:00.000Z",
    locationAttribution: "EXACT",
    station: null,
    actor: null,
    purchaseDocument: null,
    vendor: null,
    waste: null,
    cycleCount: null,
    ...overrides,
  };
}

describe("movementDisplayLabel", () => {
  it("never exposes a raw enum string", () => {
    expect(movementDisplayLabel("COUNT_ADJUSTMENT_OUT")).toBe("Cycle Count Adjustment");
    expect(movementDisplayLabel("COUNT_ADJUSTMENT_OUT")).not.toMatch(/^[A-Z_]+$/);
    expect(movementDisplayLabel("PURCHASE_RECEIPT")).toBe("Received");
    expect(movementDisplayLabel("ISSUE_TO_STATION")).toBe("Withdrawal");
    expect(movementDisplayLabel("WASTE")).toBe("Waste");
  });
});

describe("movementGlyph", () => {
  it("uses a two-way glyph for cycle count regardless of IN/OUT sub-type", () => {
    expect(movementGlyph("COUNT_ADJUSTMENT_IN")).toBe("↕");
    expect(movementGlyph("COUNT_ADJUSTMENT_OUT")).toBe("↕");
  });

  it("uses up for inbound and down for outbound otherwise", () => {
    expect(movementGlyph("PURCHASE_RECEIPT")).toBe("↑");
    expect(movementGlyph("ISSUE_TO_STATION")).toBe("↓");
    expect(movementGlyph("WASTE")).toBe("↓");
  });
});

describe("actorLabelVerb", () => {
  it("is precise about the role behind each movement type's actor", () => {
    expect(actorLabelVerb("ISSUE_TO_STATION")).toBe("Taken by");
    expect(actorLabelVerb("PURCHASE_RECEIPT")).toBe("Posted by");
    expect(actorLabelVerb("WASTE")).toBe("Recorded by");
    expect(actorLabelVerb("COUNT_ADJUSTMENT_IN")).toBe("Completed by");
    expect(actorLabelVerb("COUNT_ADJUSTMENT_OUT")).toBe("Completed by");
  });

  it("has no established verb for a defensive-only type", () => {
    expect(actorLabelVerb("TRANSFER_IN")).toBeNull();
  });
});

describe("formatSignedQuantity", () => {
  it("shows a withdrawal as negative", () => {
    expect(formatSignedQuantity("OUT", 2, "PIECE")).toBe("-2 PIECE");
  });

  it("shows a receipt as positive", () => {
    expect(formatSignedQuantity("IN", 12, "PIECE")).toBe("+12 PIECE");
  });

  it("rounds fractional magnitudes to two decimals", () => {
    expect(formatQuantityMagnitude(43.6789)).toBe("43.68");
    expect(formatQuantityMagnitude(5)).toBe("5");
  });
});

describe("activityDateGroupLabel / formatActivityTimestamp", () => {
  const now = new Date("2026-08-19T20:00:00.000Z");

  it("labels the same calendar day as Today", () => {
    expect(activityDateGroupLabel("2026-08-19T12:42:00.000Z", now)).toBe("Today");
  });

  it("labels the prior calendar day as Yesterday", () => {
    expect(activityDateGroupLabel("2026-08-18T18:22:00.000Z", now)).toBe("Yesterday");
  });

  it("labels an older day with a short month/day", () => {
    expect(activityDateGroupLabel("2026-08-17T09:10:00.000Z", now)).toBe("Aug 17");
  });

  it("combines the date group and time", () => {
    expect(formatActivityTimestamp("2026-08-19T12:42:00.000Z", now)).toMatch(/^Today · /);
  });
});

describe("groupActivityByDate", () => {
  it("groups newest-first entries into consecutive date buckets without re-sorting", () => {
    const now = new Date("2026-08-19T20:00:00.000Z");
    const entries = [
      entry({ id: "a", occurredAt: "2026-08-19T12:42:00.000Z" }),
      entry({ id: "b", occurredAt: "2026-08-19T07:20:00.000Z" }),
      entry({ id: "c", occurredAt: "2026-08-18T18:22:00.000Z" }),
      entry({ id: "d", occurredAt: "2026-08-17T09:10:00.000Z" }),
    ];
    const groups = groupActivityByDate(entries, now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Aug 17"]);
    expect(groups[0].entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(groups[1].entries.map((e) => e.id)).toEqual(["c"]);
    expect(groups[2].entries.map((e) => e.id)).toEqual(["d"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupActivityByDate([], new Date())).toEqual([]);
  });
});

describe("withdrawalSourceLabel", () => {
  it("shows the source location for an EXACT, employee-chosen withdrawal", () => {
    expect(withdrawalSourceLabel("EXACT", "Central Walk-In")).toBe("Central Walk-In → ");
  });

  it("never claims a specific source location for a LEGACY_ESTIMATED withdrawal (Part 17: no false precision)", () => {
    const label = withdrawalSourceLabel("LEGACY_ESTIMATED", "Central Walk-In");
    expect(label).not.toContain("Central Walk-In");
    expect(label).toBe("→ ");
  });
});

describe("wasteReasonLabel", () => {
  it("maps a known reason code to its human label", () => {
    expect(wasteReasonLabel("SPOILED")).toBe("Spoiled");
  });

  it("falls back to the raw code for an unrecognized value rather than crashing", () => {
    expect(wasteReasonLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
