import { describe, it, expect } from "vitest";
import { classifyDeliveryLineage, isAmbiguousDeliveryLineage, AMBIGUOUS_DELIVERY_REASON } from "@/app/lib/purchaseDocuments/duplicateDelivery";

describe("classifyDeliveryLineage", () => {
  it("single effective delivery -> single (posts normally)", () => {
    expect(classifyDeliveryLineage([{ deliveryEventId: "evt-1" }])).toBe("single");
    expect(classifyDeliveryLineage([{ deliveryEventId: null }])).toBe("single");
    expect(classifyDeliveryLineage([])).toBe("single");
  });

  it("multiple deliveries with DISTINCT non-null event ids -> additional (legitimate partials, summed)", () => {
    expect(classifyDeliveryLineage([{ deliveryEventId: "evt-mon" }, { deliveryEventId: "evt-tue" }])).toBe("additional");
    expect(isAmbiguousDeliveryLineage([{ deliveryEventId: "evt-mon" }, { deliveryEventId: "evt-tue" }])).toBe(false);
  });

  it("two genuine partial deliveries with the SAME quantity are NOT auto-deduplicated (distinct event ids)", () => {
    // Identity, not quantity, decides: two distinct events remain additional.
    expect(classifyDeliveryLineage([{ deliveryEventId: "evt-a" }, { deliveryEventId: "evt-b" }])).toBe("additional");
  });

  it("multiple deliveries with any NULL (historical) event id -> ambiguous (block)", () => {
    // The real Bartlett shape: three historical deliveries, all null event id.
    expect(classifyDeliveryLineage([{ deliveryEventId: null }, { deliveryEventId: null }, { deliveryEventId: null }])).toBe("ambiguous");
    expect(classifyDeliveryLineage([{ deliveryEventId: "evt-1" }, { deliveryEventId: null }])).toBe("ambiguous");
    expect(isAmbiguousDeliveryLineage([{ deliveryEventId: null }, { deliveryEventId: null }])).toBe(true);
  });

  it("multiple deliveries claiming the SAME event id -> ambiguous (block)", () => {
    expect(classifyDeliveryLineage([{ deliveryEventId: "evt-x" }, { deliveryEventId: "evt-x" }])).toBe("ambiguous");
  });

  it("exposes a single shared manager-facing reason directing to review", () => {
    expect(AMBIGUOUS_DELIVERY_REASON).toMatch(/multiple recorded deliveries/i);
    expect(AMBIGUOUS_DELIVERY_REASON).toMatch(/separate physical deliveries or duplicate entries/i);
  });
});
