import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves the server-side enforcement of
// "Other Non-inventory Expense" (and any expense category flagged
// requires_explanation): a non-inventory line classified to it is rejected
// unless a written explanation is supplied, and the explanation is
// persisted via set_line_classification_explanation once it is.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { approveNewMock } = vi.hoisted(() => ({ approveNewMock: vi.fn() }));
vi.mock("@/app/lib/itemMaster/approveLineClassificationNewItemRpc", () => ({ approveLineClassificationNewItemRpc: approveNewMock }));
vi.mock("@/app/lib/itemMaster/classifyPurchaseDocumentLines", () => ({ classifyPurchaseDocumentLines: vi.fn() }));
vi.mock("@/app/lib/itemMaster/approveLineClassificationExistingItemRpc", () => ({ approveLineClassificationExistingItemRpc: vi.fn() }));
vi.mock("@/app/lib/itemMaster/bulkConfirmLineClassificationsRpc", () => ({ bulkConfirmLineClassificationsRpc: vi.fn() }));

import { approveNewItemClassification } from "@/app/actions/itemClassification";

const MANAGER = { ok: true as const, manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] } };

let rpcSpy: ReturnType<typeof vi.fn>;
function mockClient(requiresExplanation: boolean) {
  rpcSpy = vi.fn(async () => ({ error: null }));
  const maybeSingle = vi.fn(async () => ({ data: { requires_explanation: requiresExplanation } }));
  return {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }),
    rpc: rpcSpy,
  };
}

const baseInput = {
  purchaseDocumentId: "doc-1",
  lineKey: "line-1",
  finalName: "One-time cleaning service",
  disposition: "NON_INVENTORY" as const,
  categoryId: null,
  spendCategoryId: "expense-other",
  baseUnitCode: null,
  pendingItemId: null,
};

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  approveNewMock.mockReset().mockResolvedValue({ inventoryItemId: "item-1" });
});
afterEach(() => vi.clearAllMocks());

describe("expense line explanation enforcement", () => {
  it("rejects a catch-all expense line with no explanation and never persists it", async () => {
    getServiceRoleClientMock.mockReturnValue(mockClient(true));
    const result = await approveNewItemClassification(baseInput);
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("explanation_required");
    expect(approveNewMock).not.toHaveBeenCalled();
  });

  it("accepts the line when an explanation is supplied and persists it", async () => {
    getServiceRoleClientMock.mockReturnValue(mockClient(true));
    const result = await approveNewItemClassification({ ...baseInput, explanation: "Deep clean after inspection" });
    expect(result.ok).toBe(true);
    expect(approveNewMock).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith("set_line_classification_explanation", expect.objectContaining({ p_explanation: "Deep clean after inspection", p_line_key: "line-1" }));
  });

  it("does not require an explanation for a normal expense category", async () => {
    getServiceRoleClientMock.mockReturnValue(mockClient(false));
    const result = await approveNewItemClassification(baseInput);
    expect(result.ok).toBe(true);
    expect(approveNewMock).toHaveBeenCalledTimes(1);
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});
