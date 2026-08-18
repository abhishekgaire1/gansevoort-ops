import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { rejectMock } = vi.hoisted(() => ({ rejectMock: vi.fn() }));
vi.mock("@/app/lib/itemMaster/rejectItemProposalRpc", () => ({ rejectItemProposalRpc: rejectMock }));

import { rejectItemProposal, listInventoryItems } from "@/app/actions/itemMaster";
import { ItemProposalReferencedError, ItemNotPendingReviewError } from "@/app/lib/itemMaster/errors";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  rejectMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("rejectItemProposal", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await rejectItemProposal("item-1");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(rejectMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity and reason through to the RPC", async () => {
    rejectMock.mockResolvedValue(undefined);
    const result = await rejectItemProposal("item-1", "duplicate of an existing item");
    expect(rejectMock).toHaveBeenCalledWith(expect.anything(), {
      inventoryItemId: "item-1",
      organizationId: "org-1",
      appUserId: "user-1",
      reason: "duplicate of an existing item",
    });
    expect(result).toEqual({ ok: true });
  });

  it("maps ItemProposalReferencedError to a friendly referenced result", async () => {
    rejectMock.mockRejectedValue(new ItemProposalReferencedError("still referenced"));
    const result = await rejectItemProposal("item-1");
    expect(result).toMatchObject({ ok: false, reason: "referenced" });
  });

  it("maps ItemNotPendingReviewError to a friendly not_pending result", async () => {
    rejectMock.mockRejectedValue(new ItemNotPendingReviewError("already confirmed"));
    const result = await rejectItemProposal("item-1");
    expect(result).toMatchObject({ ok: false, reason: "not_pending" });
  });
});

describe("listInventoryItems", () => {
  it("rejects unauthenticated callers before querying", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await listInventoryItems();
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(getServiceRoleClientMock).not.toHaveBeenCalled();
  });

  it("filters to approval_status=CONFIRMED by default", async () => {
    const eqApproval = vi.fn().mockResolvedValue({ data: [], error: null });
    const limit = vi.fn().mockReturnValue({ eq: eqApproval });
    const order = vi.fn().mockReturnValue({ limit });
    const eqOrg = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq: eqOrg });
    const from = vi.fn().mockReturnValue({ select });
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await listInventoryItems();
    expect(eqApproval).toHaveBeenCalledWith("approval_status", "CONFIRMED");
    expect(result).toEqual({ ok: true, items: [] });
  });
});
