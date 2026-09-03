import { describe, expect, it } from "vitest";
import { deriveLineProvenance, amendmentDiff, type ProvenanceInput, type AmendmentDiffLine } from "@/app/lib/purchaseDocuments/lineProvenance";

/**
 * Truthful completion provenance -- "Confirmed for this invoice" requires
 * a real resolved_by_app_user_id (a genuine manager action); a system
 * auto-match is always "Previously approved," never falsely attributed.
 */

describe("deriveLineProvenance", () => {
  it("test 3 + 4: distinguishes Previously approved (system auto-match, no resolver) from Confirmed for this invoice (a real manager action)", () => {
    const autoMatched: ProvenanceInput = { status: "CONFIRMED", resolutionSource: "VENDOR_SKU_MAPPING", resolvedByName: null, resolvedAt: null };
    expect(deriveLineProvenance(autoMatched)).toEqual({ kind: "previously_approved", label: "Previously approved", resolvedByName: null, resolvedAt: null });

    const managerConfirmed: ProvenanceInput = { status: "CONFIRMED", resolutionSource: "MANUAL", resolvedByName: "Jordan Lee", resolvedAt: "2026-09-01T21:35:12.761443+00:00" };
    expect(deriveLineProvenance(managerConfirmed)).toEqual({
      kind: "confirmed_this_invoice",
      label: "Confirmed for this invoice",
      resolvedByName: "Jordan Lee",
      resolvedAt: "2026-09-01T21:35:12.761443+00:00",
    });
  });

  it("test 4: an AI-suggested match not yet confirmed is never labeled as manager-confirmed", () => {
    const pending: ProvenanceInput = { status: "PENDING_REVIEW", resolutionSource: "AI_SUGGESTED", resolvedByName: null, resolvedAt: null };
    const result = deriveLineProvenance(pending);
    expect(result.kind).toBe("ai_suggestion");
    expect(result.label).not.toMatch(/confirmed|approved/i);
  });

  it("never fabricates an attribution when resolvedByName is genuinely absent, even for a CONFIRMED line", () => {
    const result = deriveLineProvenance({ status: "CONFIRMED", resolutionSource: "VENDOR_DESCRIPTION_MAPPING", resolvedByName: null, resolvedAt: null });
    expect(result.resolvedByName).toBeNull();
    expect(result.resolvedAt).toBeNull();
  });

  it("a line with no classification at all is not yet classified", () => {
    expect(deriveLineProvenance({ status: "UNCLASSIFIED", resolutionSource: null, resolvedByName: null, resolvedAt: null }).kind).toBe("not_yet_classified");
  });
});

describe("amendmentDiff", () => {
  const previousBySku = new Map<string, AmendmentDiffLine>([
    ["SKU-1", { vendorSku: "SKU-1", description: "Farmland Sour Cream 10lb", packageQuantity: 1, packageUnit: "PACK" }],
  ]);

  it("test 7: a line whose package quantity/unit changed since the previous revision is identified as changed, with the previous value preserved", () => {
    const current: AmendmentDiffLine = { vendorSku: "SKU-1", description: "Farmland Sour Cream 10lb", packageQuantity: 2, packageUnit: "PACK" };
    expect(amendmentDiff(current, previousBySku)).toEqual({ changed: true, previousSummary: "1 PACK" });
  });

  it("test 7: an untouched line (identical description/package to the previous revision) is never marked changed", () => {
    const current: AmendmentDiffLine = { vendorSku: "SKU-1", description: "Farmland Sour Cream 10lb", packageQuantity: 1, packageUnit: "PACK" };
    expect(amendmentDiff(current, previousBySku)).toEqual({ changed: false, previousSummary: null });
  });

  it("a line with no vendor SKU can't be matched across revisions, so it's never guessed at as changed", () => {
    const current: AmendmentDiffLine = { vendorSku: null, description: "Something else", packageQuantity: 1, packageUnit: "PACK" };
    expect(amendmentDiff(current, previousBySku)).toEqual({ changed: false, previousSummary: null });
  });

  it("a line new to this amendment (no match on the previous revision) is never marked changed", () => {
    const current: AmendmentDiffLine = { vendorSku: "SKU-NEW", description: "Brand new line", packageQuantity: 1, packageUnit: "CASE" };
    expect(amendmentDiff(current, previousBySku)).toEqual({ changed: false, previousSummary: null });
  });
});
