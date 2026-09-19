import { describe, it, expect } from "vitest";
import { hasDuplicateEffectiveDeliveryLines, DUPLICATE_DELIVERY_REASON } from "@/app/lib/purchaseDocuments/duplicateDelivery";

describe("hasDuplicateEffectiveDeliveryLines", () => {
  it("is false for one effective receipt line per invoice line (the normal case)", () => {
    expect(hasDuplicateEffectiveDeliveryLines(["a", "b", "c"])).toBe(false);
  });

  it("is false for a normally-corrected document (one effective line per key)", () => {
    // A correction supersedes the receipt it corrects, so the effective set
    // still has exactly one line per matched key.
    expect(hasDuplicateEffectiveDeliveryLines(["a", "b"])).toBe(false);
  });

  it("is true when the same delivery was recorded twice (two effective lines for a key)", () => {
    expect(hasDuplicateEffectiveDeliveryLines(["a", "a", "b"])).toBe(true);
  });

  it("is true for the real triple-delivery signature (three effective lines per key)", () => {
    expect(hasDuplicateEffectiveDeliveryLines(["a", "a", "a", "b", "b", "b"])).toBe(true);
  });

  it("ignores null/undefined matched keys (unmatched receipt lines never count)", () => {
    expect(hasDuplicateEffectiveDeliveryLines([null, null, undefined, "a"])).toBe(false);
  });

  it("exposes a single shared manager-facing reason", () => {
    expect(DUPLICATE_DELIVERY_REASON).toMatch(/more than one recorded delivery/i);
    expect(DUPLICATE_DELIVERY_REASON).toMatch(/Items & Receiving/);
  });
});
