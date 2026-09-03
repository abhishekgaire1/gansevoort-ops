import { describe, expect, it } from "vitest";
import { reasonRequiresNotes, isSoleApproverFormValid, SOLE_APPROVER_REASON_OPTIONS, type SoleApproverFormState } from "@/app/lib/purchaseDocuments/soleApproverReason";

/**
 * Single-manager approval -- the confirmation modal's own submit gate.
 * Never a substitute for the server's authoritative checks; this only
 * governs when the modal's own Confirm button may be pressed.
 */

const base: SoleApproverFormState = { reason: "SECOND_REVIEWER_UNAVAILABLE", notes: "", acknowledged: true };

describe("reasonRequiresNotes", () => {
  it("only Other strictly requires notes", () => {
    expect(reasonRequiresNotes("OTHER")).toBe(true);
    expect(reasonRequiresNotes("SECOND_REVIEWER_UNAVAILABLE")).toBe(false);
    expect(reasonRequiresNotes("TIME_SENSITIVE_RECEIVING")).toBe(false);
    expect(reasonRequiresNotes("MANAGER_COMPLETED_FULL_REVIEW")).toBe(false);
    expect(reasonRequiresNotes(null)).toBe(false);
  });
});

describe("isSoleApproverFormValid", () => {
  it("test 4: no reason selected is never valid, even with acknowledgment checked", () => {
    expect(isSoleApproverFormValid({ ...base, reason: null })).toBe(false);
  });

  it("test 4: the acknowledgment checkbox is required even when a reason is selected", () => {
    expect(isSoleApproverFormValid({ ...base, acknowledged: false })).toBe(false);
  });

  it("a non-Other reason with acknowledgment checked and no notes is valid -- notes are optional for it", () => {
    expect(isSoleApproverFormValid({ ...base, notes: "" })).toBe(true);
  });

  it("test 5: Other requires non-blank notes even with acknowledgment checked", () => {
    expect(isSoleApproverFormValid({ reason: "OTHER", notes: "", acknowledged: true })).toBe(false);
    expect(isSoleApproverFormValid({ reason: "OTHER", notes: "   ", acknowledged: true })).toBe(false);
  });

  it("test 5: Other becomes valid once real notes are entered", () => {
    expect(isSoleApproverFormValid({ reason: "OTHER", notes: "Delivery must be shelved before close.", acknowledged: true })).toBe(true);
  });

  it("exposes exactly the four required reason options in the specified order", () => {
    expect(SOLE_APPROVER_REASON_OPTIONS.map((o) => o.code)).toEqual([
      "SECOND_REVIEWER_UNAVAILABLE",
      "TIME_SENSITIVE_RECEIVING",
      "MANAGER_COMPLETED_FULL_REVIEW",
      "OTHER",
    ]);
  });
});
