import { describe, expect, test } from "vitest";
import { describeLineIssue } from "@/app/lib/purchaseDocuments/lineIssueSummary";

const readyReceiving = {
  receivedQuantity: "2",
  verifiedQuantity: "20",
  locationId: "loc-1",
  info: { requiresVerifiedMeasurement: false, baseUnitCode: "LB" },
};

describe("describeLineIssue", () => {
  test("unclassified new-item proposal points at item match", () => {
    expect(
      describeLineIssue({ status: "PENDING_REVIEW", disposition: "UNRESOLVED", isNewItemProposal: true, hasPackageMismatch: false, receiving: null })
    ).toEqual({ section: "item_match", text: "New item needs verification" });
  });

  test("unclassified with no AI proposal points at item match with a generic message", () => {
    expect(
      describeLineIssue({ status: "UNCLASSIFIED", disposition: "UNRESOLVED", isNewItemProposal: false, hasPackageMismatch: false, receiving: null })
    ).toEqual({ section: "item_match", text: "No item match yet" });
  });

  test("confirmed non-inventory (expense) is never an issue", () => {
    expect(
      describeLineIssue({ status: "CONFIRMED", disposition: "NON_INVENTORY", isNewItemProposal: false, hasPackageMismatch: false, receiving: null })
    ).toBeNull();
  });

  test("confirmed inventory with a package mismatch points at the package, never receiving", () => {
    expect(
      describeLineIssue({ status: "CONFIRMED", disposition: "INVENTORY", isNewItemProposal: false, hasPackageMismatch: true, receiving: readyReceiving })
    ).toEqual({ section: "package", text: "Purchase package needs review" });
  });

  test("confirmed inventory, package ok, but no receiving draft loaded yet", () => {
    expect(
      describeLineIssue({ status: "CONFIRMED", disposition: "INVENTORY", isNewItemProposal: false, hasPackageMismatch: false, receiving: null })
    ).toEqual({ section: "receiving", text: "Receiving details not started." });
  });

  test("confirmed inventory, package ok, missing received quantity points at receiving with the specific reason", () => {
    expect(
      describeLineIssue({
        status: "CONFIRMED",
        disposition: "INVENTORY",
        isNewItemProposal: false,
        hasPackageMismatch: false,
        receiving: { ...readyReceiving, receivedQuantity: "" },
      })
    ).toEqual({ section: "receiving", text: "Enter the received quantity." });
  });

  test("confirmed inventory, package ok, missing verified measurement points at receiving with the unit-specific reason", () => {
    expect(
      describeLineIssue({
        status: "CONFIRMED",
        disposition: "INVENTORY",
        isNewItemProposal: false,
        hasPackageMismatch: false,
        receiving: { ...readyReceiving, verifiedQuantity: "", info: { requiresVerifiedMeasurement: true, baseUnitCode: "LB" } },
      })
    ).toEqual({ section: "receiving", text: "Enter the verified LB." });
  });

  test("confirmed inventory, package ok, missing location points at receiving", () => {
    expect(
      describeLineIssue({
        status: "CONFIRMED",
        disposition: "INVENTORY",
        isNewItemProposal: false,
        hasPackageMismatch: false,
        receiving: { ...readyReceiving, locationId: "" },
      })
    ).toEqual({ section: "receiving", text: "Choose a storage location." });
  });
});
