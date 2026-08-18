import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { classifyMock, approveNewMock, approveExistingMock, bulkConfirmMock } = vi.hoisted(() => ({
  classifyMock: vi.fn(),
  approveNewMock: vi.fn(),
  approveExistingMock: vi.fn(),
  bulkConfirmMock: vi.fn(),
}));
vi.mock("@/app/lib/itemMaster/classifyPurchaseDocumentLines", () => ({ classifyPurchaseDocumentLines: classifyMock }));
vi.mock("@/app/lib/itemMaster/approveLineClassificationNewItemRpc", () => ({ approveLineClassificationNewItemRpc: approveNewMock }));
vi.mock("@/app/lib/itemMaster/approveLineClassificationExistingItemRpc", () => ({ approveLineClassificationExistingItemRpc: approveExistingMock }));
vi.mock("@/app/lib/itemMaster/bulkConfirmLineClassificationsRpc", () => ({ bulkConfirmLineClassificationsRpc: bulkConfirmMock }));

import {
  runItemMatchingNow,
  approveNewItemClassification,
  approveExistingItemClassification,
  markLineNonInventory,
  bulkConfirmClassifications,
} from "@/app/actions/itemClassification";
import { LineNotFoundInCurrentRevisionError, ItemNotPendingReviewError } from "@/app/lib/itemMaster/errors";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  classifyMock.mockReset();
  approveNewMock.mockReset();
  approveExistingMock.mockReset();
  bulkConfirmMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runItemMatchingNow", () => {
  it("rejects unauthenticated callers before running the orchestrator", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await runItemMatchingNow("pd-1");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("awaits the orchestrator directly with the resolved organization id, opted into refreshing unconfirmed AI proposals", async () => {
    classifyMock.mockResolvedValue(undefined);
    const result = await runItemMatchingNow("pd-1");
    expect(classifyMock).toHaveBeenCalledWith("pd-1", "org-1", { includeUnconfirmedAiProposals: true });
    expect(result).toEqual({ ok: true });
  });

  it("returns misconfigured on an unexpected orchestrator failure", async () => {
    classifyMock.mockRejectedValue(new Error("GEMINI_API_KEY is not set"));
    const result = await runItemMatchingNow("pd-1");
    expect(result).toEqual({ ok: false, reason: "misconfigured", message: "Could not run item matching. Try again." });
  });
});

describe("approveNewItemClassification", () => {
  const input = {
    purchaseDocumentId: "pd-1",
    lineKey: "line-1",
    finalName: "Chicken Thigh",
    disposition: "INVENTORY" as const,
    categoryId: "cat-1",
    spendCategoryId: null,
    baseUnitCode: "LB",
  };

  it("passes the resolved manager identity through to the RPC", async () => {
    approveNewMock.mockResolvedValue({ inventoryItemId: "item-1", classificationId: "class-1" });
    const result = await approveNewItemClassification(input);
    expect(approveNewMock).toHaveBeenCalledWith(expect.anything(), {
      purchaseDocumentId: "pd-1",
      lineKey: "line-1",
      organizationId: "org-1",
      appUserId: "user-1",
      finalName: "Chicken Thigh",
      disposition: "INVENTORY",
      categoryId: "cat-1",
      spendCategoryId: null,
      baseUnitCode: "LB",
      pendingItemId: undefined,
      rememberVendorMapping: undefined,
    });
    expect(result).toEqual({ ok: true, inventoryItemId: "item-1" });
  });

  it("maps LineNotFoundInCurrentRevisionError to a friendly result", async () => {
    approveNewMock.mockRejectedValue(new LineNotFoundInCurrentRevisionError("gone"));
    const result = await approveNewItemClassification(input);
    expect(result).toMatchObject({ ok: false, reason: "line_not_found" });
  });
});

describe("approveExistingItemClassification", () => {
  it("maps ItemNotPendingReviewError to a friendly result", async () => {
    approveExistingMock.mockRejectedValue(new ItemNotPendingReviewError("not confirmed"));
    const result = await approveExistingItemClassification({ purchaseDocumentId: "pd-1", lineKey: "line-1", inventoryItemId: "item-1" });
    expect(result).toMatchObject({ ok: false, reason: "not_pending" });
  });

  it("returns ok with the same inventoryItemId on success", async () => {
    approveExistingMock.mockResolvedValue({ classificationId: "class-1" });
    const result = await approveExistingItemClassification({ purchaseDocumentId: "pd-1", lineKey: "line-1", inventoryItemId: "item-1" });
    expect(result).toEqual({ ok: true, inventoryItemId: "item-1" });
  });
});

describe("markLineNonInventory", () => {
  it("delegates to approveNewItemClassification with disposition forced to NON_INVENTORY and no category/unit", async () => {
    approveNewMock.mockResolvedValue({ inventoryItemId: "item-1", classificationId: "class-1" });
    await markLineNonInventory("pd-1", "line-1", "Delivery Fee");
    expect(approveNewMock).toHaveBeenCalledWith(expect.anything(), {
      purchaseDocumentId: "pd-1",
      lineKey: "line-1",
      organizationId: "org-1",
      appUserId: "user-1",
      finalName: "Delivery Fee",
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId: null,
      baseUnitCode: null,
      pendingItemId: undefined,
      rememberVendorMapping: true,
    });
  });
});

describe("bulkConfirmClassifications", () => {
  it("returns the confirmed ids on success", async () => {
    bulkConfirmMock.mockResolvedValue(["c1", "c2"]);
    const result = await bulkConfirmClassifications(["c1", "c2", "c3"]);
    expect(bulkConfirmMock).toHaveBeenCalledWith(expect.anything(), { classificationIds: ["c1", "c2", "c3"], organizationId: "org-1", appUserId: "user-1" });
    expect(result).toEqual({ ok: true, confirmedIds: ["c1", "c2"] });
  });

  it("returns misconfigured on an unexpected RPC failure", async () => {
    bulkConfirmMock.mockRejectedValue(new Error("boom"));
    const result = await bulkConfirmClassifications(["c1"]);
    expect(result).toEqual({ ok: false, reason: "misconfigured", message: "Could not confirm the selected lines. Try again." });
  });
});
