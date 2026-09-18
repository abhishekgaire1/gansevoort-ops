import { describe, expect, it } from "vitest";
import {
  classifyPriceChangeSeverity,
  priceReviewBlocksPosting,
  priceReviewIsNotable,
  priceChangeLabel,
  priceCheckBadge,
  INFORMATIONAL_THRESHOLD_PCT,
  ACKNOWLEDGMENT_THRESHOLD_PCT,
} from "@/app/lib/purchasing/priceReviewPolicy";
import { derivePriceReviewState, priceComparisonFingerprint, type StoredPriceAcknowledgment } from "@/app/lib/purchasing/priceReviewState";
import type { PriceComparisonResult } from "@/app/lib/purchasing/priceComparison";

const context = { inventoryItemId: "item-1", vendorId: "vendor-1", vendorSku: "40", currency: "USD" };

function comparable(deltaPct: number, direction: "increase" | "decrease" | "unchanged"): Extract<PriceComparisonResult, { available: true }> {
  const previousUnitCost = 1.66;
  const currentUnitCost = previousUnitCost * (1 + deltaPct / 100);
  return {
    available: true,
    currentUnitCost,
    baseUnitCode: "LB",
    previous: { purchaseDocumentId: "prev-1", documentNumber: "111", documentDate: "2026-08-21", vendorName: "Bartlett", unitCost: previousUnitCost },
    deltaAbs: currentUnitCost - previousUnitCost,
    deltaPct,
    direction,
  };
}

describe("classifyPriceChangeSeverity (thresholds 10 / 20, both directions)", () => {
  it("below 10% is NONE (scenario 34)", () => {
    expect(classifyPriceChangeSeverity(9.99)).toBe("NONE");
    expect(classifyPriceChangeSeverity(-9.99)).toBe("NONE");
  });
  it("10%..19.99% is INFORMATIONAL (scenario 35)", () => {
    expect(classifyPriceChangeSeverity(INFORMATIONAL_THRESHOLD_PCT)).toBe("INFORMATIONAL");
    expect(classifyPriceChangeSeverity(18.4)).toBe("INFORMATIONAL");
    expect(classifyPriceChangeSeverity(-12.1)).toBe("INFORMATIONAL");
    expect(classifyPriceChangeSeverity(19.99)).toBe("INFORMATIONAL");
  });
  it("20%+ is SIGNIFICANT, increases and decreases alike (scenarios 36, 37)", () => {
    expect(classifyPriceChangeSeverity(ACKNOWLEDGMENT_THRESHOLD_PCT)).toBe("SIGNIFICANT");
    expect(classifyPriceChangeSeverity(31.3)).toBe("SIGNIFICANT");
    expect(classifyPriceChangeSeverity(-42.0)).toBe("SIGNIFICANT");
  });
});

describe("derivePriceReviewState", () => {
  it("expense / unresolved lines are NOT_APPLICABLE (scenario 29)", () => {
    for (const reason of ["NON_INVENTORY", "UNRESOLVED", "FREE_LINE", "CREDIT_LINE"] as const) {
      expect(derivePriceReviewState({ comparison: { available: false, reason }, context, acknowledgment: null }).state).toBe("NOT_APPLICABLE");
    }
  });

  it("a new vendor/item with no prior purchase is NO_COMPARABLE_HISTORY (scenario 28)", () => {
    expect(derivePriceReviewState({ comparison: { available: false, reason: "FIRST_PURCHASE" }, context, acknowledgment: null }).state).toBe("NO_COMPARABLE_HISTORY");
  });

  it("missing quantity/amount/conversion is COMPARISON_UNAVAILABLE, never a fabricated price (scenario 33)", () => {
    for (const reason of ["NO_VENDOR", "MISSING_LINE_TOTAL", "MISSING_CONVERSION", "AWAITING_RECEIVING_CONFIRMATION", "CURRENCY_UNAVAILABLE"] as const) {
      expect(derivePriceReviewState({ comparison: { available: false, reason }, context, acknowledgment: null }).state).toBe("COMPARISON_UNAVAILABLE");
    }
  });

  it("a comparable sub-threshold change is NO_MATERIAL_CHANGE", () => {
    expect(derivePriceReviewState({ comparison: comparable(4, "increase"), context, acknowledgment: null }).state).toBe("NO_MATERIAL_CHANGE");
  });

  it("a 10-19.99% change is INFORMATIONAL_CHANGE and never blocks (scenarios 35, 38)", () => {
    const r = derivePriceReviewState({ comparison: comparable(18.4, "increase"), context, acknowledgment: null });
    expect(r.state).toBe("INFORMATIONAL_CHANGE");
    expect(priceReviewBlocksPosting(r.state)).toBe(false);
  });

  it("a >=20% change with no ack REQUIRES_ACKNOWLEDGMENT and blocks (scenarios 36, 39)", () => {
    const r = derivePriceReviewState({ comparison: comparable(31.3, "increase"), context, acknowledgment: null });
    expect(r.state).toBe("REQUIRES_ACKNOWLEDGMENT");
    expect(priceReviewBlocksPosting(r.state)).toBe(true);
    expect(r.fingerprint).toBeTruthy();
  });

  it("a >=20% change with a fingerprint-matching ack is ACKNOWLEDGED and unblocks (scenario 40)", () => {
    const comparison = comparable(31.3, "increase");
    const fingerprint = priceComparisonFingerprint({
      inventoryItemId: context.inventoryItemId,
      vendorId: context.vendorId,
      vendorSku: context.vendorSku,
      currency: context.currency,
      baseUnitCode: comparison.baseUnitCode,
      currentUnitCost: comparison.currentUnitCost,
      previousPurchaseDocumentId: comparison.previous.purchaseDocumentId,
      previousUnitCost: comparison.previous.unitCost,
      policyVersion: "v1:10-20",
    });
    const ack: StoredPriceAcknowledgment = { fingerprint, actorName: "Bhavika Punjabi", acknowledgedAt: "2026-09-18T00:00:00Z", note: null };
    const r = derivePriceReviewState({ comparison, context, acknowledgment: ack });
    expect(r.state).toBe("ACKNOWLEDGED");
    expect(priceReviewBlocksPosting(r.state)).toBe(false);
    expect(r.acknowledgment?.actorName).toBe("Bhavika Punjabi");
  });

  it("a stale ack (any comparison input changed) fails closed and requires re-acknowledgment (scenario 43)", () => {
    const original = comparable(31.3, "increase");
    const fingerprint = priceComparisonFingerprint({
      inventoryItemId: context.inventoryItemId,
      vendorId: context.vendorId,
      vendorSku: context.vendorSku,
      currency: context.currency,
      baseUnitCode: original.baseUnitCode,
      currentUnitCost: original.currentUnitCost,
      previousPurchaseDocumentId: original.previous.purchaseDocumentId,
      previousUnitCost: original.previous.unitCost,
      policyVersion: "v1:10-20",
    });
    const ack: StoredPriceAcknowledgment = { fingerprint, actorName: "M", acknowledgedAt: "2026-09-18T00:00:00Z", note: null };
    // A different current unit cost (e.g. the received quantity was corrected).
    const changed = comparable(45.0, "increase");
    const r = derivePriceReviewState({ comparison: changed, context, acknowledgment: ack });
    expect(r.state).toBe("REQUIRES_ACKNOWLEDGMENT");
    expect(r.acknowledgment).toBeNull();
  });

  it("changing vendor SKU or currency changes the fingerprint (invalidates an ack)", () => {
    const base = { inventoryItemId: "i", vendorId: "v", vendorSku: "A", currency: "USD", baseUnitCode: "LB", currentUnitCost: 2, previousPurchaseDocumentId: "p", previousUnitCost: 1.5, policyVersion: "v1:10-20" };
    const fp = priceComparisonFingerprint(base);
    expect(priceComparisonFingerprint({ ...base, vendorSku: "B" })).not.toBe(fp);
    expect(priceComparisonFingerprint({ ...base, currency: "EUR" })).not.toBe(fp);
    expect(priceComparisonFingerprint({ ...base, currentUnitCost: 2.01 })).not.toBe(fp);
    expect(priceComparisonFingerprint({ ...base, baseUnitCode: "OZ" })).not.toBe(fp);
    expect(priceComparisonFingerprint({ ...base, previousPurchaseDocumentId: "p2" })).not.toBe(fp);
  });

  it("scenario 27: a threshold policy-version change invalidates the fingerprint", () => {
    const base = { inventoryItemId: "i", vendorId: "v", vendorSku: "A", currency: "USD", baseUnitCode: "LB", currentUnitCost: 2, previousPurchaseDocumentId: "p", previousUnitCost: 1.5, policyVersion: "v1:10-20" };
    expect(priceComparisonFingerprint({ ...base, policyVersion: "v2:15-30" })).not.toBe(priceComparisonFingerprint(base));
  });
});

describe("labels are direction-specific and never valuation/advice", () => {
  it("uses increased/decreased language and a review prefix for significant", () => {
    expect(priceChangeLabel("increase", 18.4)).toBe("Price increased 18.4%");
    expect(priceChangeLabel("decrease", 12.1)).toBe("Price decreased 12.1%");
    expect(priceChangeLabel("increase", 31.3, { requiresReview: true })).toBe("Price change requires review: increased 31.3%");
  });
  it("badge pairs arrow + percent + vendor, never color alone", () => {
    expect(priceCheckBadge("increase", 18.4, "Bartlett")).toBe("↑ 18.4% · Bartlett");
    expect(priceCheckBadge("decrease", 12.1, "Bartlett")).toBe("↓ 12.1% · Bartlett");
  });
  it("notable covers informational + significant + acknowledged only", () => {
    expect(priceReviewIsNotable("INFORMATIONAL_CHANGE")).toBe(true);
    expect(priceReviewIsNotable("REQUIRES_ACKNOWLEDGMENT")).toBe(true);
    expect(priceReviewIsNotable("ACKNOWLEDGED")).toBe(true);
    expect(priceReviewIsNotable("NO_MATERIAL_CHANGE")).toBe(false);
    expect(priceReviewIsNotable("NO_COMPARABLE_HISTORY")).toBe(false);
  });
});
