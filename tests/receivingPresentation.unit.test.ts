import { describe, expect, it } from "vitest";
import { receivingTabForStatus, matchesReceivingTab, receivingStatusPresentation, viewerRelationshipFor } from "@/app/manager/(app)/receiving/_lib/receivingPresentation";
import type { ReceivingItemStatus } from "@/app/lib/documents/documentStatus";

const ALL_STATUSES: ReceivingItemStatus[] = [
  "PROCESSING",
  "STALLED",
  "NEEDS_REVIEW",
  "FAILED",
  "DRAFT",
  "READY_FOR_VERIFICATION",
  "VERIFIED",
  "DISCARDED",
];

describe("receivingTabForStatus", () => {
  it("groups needs-review, stalled, failed, and draft under NEEDS_ATTENTION", () => {
    expect(receivingTabForStatus("NEEDS_REVIEW")).toBe("NEEDS_ATTENTION");
    expect(receivingTabForStatus("STALLED")).toBe("NEEDS_ATTENTION");
    expect(receivingTabForStatus("FAILED")).toBe("NEEDS_ATTENTION");
    expect(receivingTabForStatus("DRAFT")).toBe("NEEDS_ATTENTION");
  });

  it("gives READY_FOR_VERIFICATION and VERIFIED their own dedicated tabs", () => {
    expect(receivingTabForStatus("READY_FOR_VERIFICATION")).toBe("READY_FOR_VERIFICATION");
    expect(receivingTabForStatus("VERIFIED")).toBe("VERIFIED");
  });

  it("PROCESSING has no dedicated/attention tab -- only appears under ALL", () => {
    expect(receivingTabForStatus("PROCESSING")).toBe("ALL");
  });
});

describe("matchesReceivingTab", () => {
  it("ALL matches every status", () => {
    for (const status of ALL_STATUSES) {
      expect(matchesReceivingTab(status, "ALL")).toBe(true);
    }
  });

  it("a dedicated tab only matches its own group", () => {
    expect(matchesReceivingTab("VERIFIED", "VERIFIED")).toBe(true);
    expect(matchesReceivingTab("DRAFT", "VERIFIED")).toBe(false);
    expect(matchesReceivingTab("DRAFT", "NEEDS_ATTENTION")).toBe(true);
    expect(matchesReceivingTab("READY_FOR_VERIFICATION", "NEEDS_ATTENTION")).toBe(false);
  });
});

describe("receivingStatusPresentation", () => {
  it("is defined for every ReceivingItemStatus with a non-empty label", () => {
    for (const status of ALL_STATUSES) {
      const presentation = receivingStatusPresentation(status);
      expect(presentation.label.length).toBeGreaterThan(0);
    }
  });

  it("never surfaces a raw enum-shaped label (no all-caps underscore text)", () => {
    for (const status of ALL_STATUSES) {
      const presentation = receivingStatusPresentation(status);
      expect(presentation.label).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it("PROCESSING has no action yet -- nothing for the manager to click", () => {
    expect(receivingStatusPresentation("PROCESSING").actionLabel).toBeNull();
  });

  it("every actionable status has a distinct, non-null action label", () => {
    const actionable: ReceivingItemStatus[] = ["STALLED", "NEEDS_REVIEW", "FAILED", "DRAFT", "READY_FOR_VERIFICATION", "VERIFIED", "DISCARDED"];
    for (const status of actionable) {
      expect(receivingStatusPresentation(status).actionLabel).not.toBeNull();
    }
  });
});

/**
 * Status Language -- Verification milestone: the SAME canonical
 * READY_FOR_VERIFICATION status reads differently depending on the
 * viewer's relationship to the document -- never a new/changed database
 * status (verified separately below), purely a presentation split.
 */
describe("receivingStatusPresentation -- viewer-relative READY_FOR_VERIFICATION wording", () => {
  it("1. the submitting/preparing manager sees 'Sent for Verification'", () => {
    expect(receivingStatusPresentation("READY_FOR_VERIFICATION", "preparer").label).toBe("Sent for Verification");
  });

  it("2. the preparer is never offered a Verify action -- self-verification is prohibited", () => {
    const presentation = receivingStatusPresentation("READY_FOR_VERIFICATION", "preparer");
    expect(presentation.actionLabel).not.toBe("Verify →");
    expect(presentation.actionLabel).not.toMatch(/review/i);
  });

  it("3. an eligible second manager sees 'Needs Verification'", () => {
    expect(receivingStatusPresentation("READY_FOR_VERIFICATION", "eligible_verifier").label).toBe("Needs Verification");
  });

  it("4. an eligible second manager sees a Verify action", () => {
    expect(receivingStatusPresentation("READY_FOR_VERIFICATION", "eligible_verifier").actionLabel).toBe("Verify →");
  });

  it("5. a generic/admin overview (or an indeterminate relationship) uses 'Awaiting Verification', never an active-sounding label, and defaults to it when no viewer is specified", () => {
    expect(receivingStatusPresentation("READY_FOR_VERIFICATION", "generic").label).toBe("Awaiting Verification");
    expect(receivingStatusPresentation("READY_FOR_VERIFICATION").label).toBe("Awaiting Verification");
  });

  it("6. every other status is completely unaffected by the viewer parameter -- this is a READY_FOR_VERIFICATION-only presentation split", () => {
    const otherStatuses: ReceivingItemStatus[] = ["PROCESSING", "STALLED", "NEEDS_REVIEW", "FAILED", "DRAFT", "VERIFIED", "DISCARDED"];
    for (const status of otherStatuses) {
      const generic = receivingStatusPresentation(status, "generic");
      const preparer = receivingStatusPresentation(status, "preparer");
      const verifier = receivingStatusPresentation(status, "eligible_verifier");
      expect(preparer).toEqual(generic);
      expect(verifier).toEqual(generic);
    }
  });

  it("7. after verification, the status moves to a distinct, correct label -- never lingers as any 'verification' wording", () => {
    const verified = receivingStatusPresentation("VERIFIED", "preparer");
    expect(verified.label).toBe("Verified");
    expect(verified.label).not.toMatch(/verification/i);
  });

  // V1 Ready-to-Post queue fix (Section 12) -- READY TO POST remains
  // derived presentation, never a DB enum: VERIFIED + contains inventory
  // + not fully posted.
  it("8. VERIFIED with no posting-status data at all falls back to plain 'Verified' -- unaffected by the new parameter when it's omitted", () => {
    const presentation = receivingStatusPresentation("VERIFIED", "generic");
    expect(presentation).toEqual({ label: "Verified", tone: "success", actionLabel: "View Invoice →" });
  });

  it("9. VERIFIED + contains inventory + NOT_POSTED -> Ready to Post", () => {
    const presentation = receivingStatusPresentation("VERIFIED", "generic", { status: "NOT_POSTED", requiredLineCount: 12 });
    expect(presentation).toEqual({ label: "Ready to Post", tone: "success", actionLabel: "Post to Inventory →" });
  });

  it("10. VERIFIED + PARTIALLY_POSTED -> Partially Posted with a truthful review action, never a fabricated new recovery action", () => {
    const presentation = receivingStatusPresentation("VERIFIED", "generic", { status: "PARTIALLY_POSTED", requiredLineCount: 12 });
    expect(presentation).toEqual({ label: "Partially Posted", tone: "warning", actionLabel: "Review →" });
  });

  it("11. VERIFIED + POSTED -> Posted", () => {
    const presentation = receivingStatusPresentation("VERIFIED", "generic", { status: "POSTED", requiredLineCount: 12 });
    expect(presentation).toEqual({ label: "Posted", tone: "success", actionLabel: "View →" });
  });

  it("12. VERIFIED with zero required inventory lines never claims 'Ready to Post' -- there is nothing to post", () => {
    const presentation = receivingStatusPresentation("VERIFIED", "generic", { status: "NOT_POSTED", requiredLineCount: 0 });
    expect(presentation).toEqual({ label: "Verified", tone: "success", actionLabel: "View Invoice →" });
  });

  it("13. a null postingStatus (explicitly passed) behaves identically to omitting it", () => {
    expect(receivingStatusPresentation("VERIFIED", "generic", null)).toEqual(receivingStatusPresentation("VERIFIED", "generic"));
  });
});

describe("viewerRelationshipFor", () => {
  it("returns 'preparer' when the current viewer created the document", () => {
    expect(viewerRelationshipFor("app-user-1", "app-user-1")).toBe("preparer");
  });

  it("returns 'eligible_verifier' when someone else prepared it", () => {
    expect(viewerRelationshipFor("app-user-1", "app-user-2")).toBe("eligible_verifier");
  });

  it("returns 'generic' when the preparer id is unknown (defensive fallback, never a guess)", () => {
    expect(viewerRelationshipFor(null, "app-user-2")).toBe("generic");
  });

  it("8. is the exact input the success-state 'Sent for Verification' wording is driven by for the preparer", () => {
    const viewer = viewerRelationshipFor("app-user-1", "app-user-1");
    expect(receivingStatusPresentation("READY_FOR_VERIFICATION", viewer).label).toBe("Sent for Verification");
  });
});
