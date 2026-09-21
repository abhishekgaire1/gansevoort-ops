import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenSpendCategoryPaths } from "@/app/lib/itemMaster/spendCategoryPaths";

// CI-safe: no network, no database. Covers (a) that the catch-all
// "requires explanation" flag flows through the flattened expense-category
// picker paths, and (b) that the category description admin actions are
// Admin-gated and derive org/actor from requireAdmin().

describe("flattenSpendCategoryPaths carries requiresExplanation", () => {
  it("passes the catch-all flag through to each path", () => {
    const paths = flattenSpendCategoryPaths([
      { id: "a", name: "Utilities", parentId: null },
      { id: "b", name: "Other Non-inventory Expense", parentId: null, requiresExplanation: true },
    ]);
    expect(paths.find((p) => p.id === "a")!.requiresExplanation).toBe(false);
    expect(paths.find((p) => p.id === "b")!.requiresExplanation).toBe(true);
  });
});

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock, requireManagerOrAdmin: vi.fn() }));
const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(() => ({})) }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const rpcMocks = vi.hoisted(() => ({
  createInventoryCategoryRpc: vi.fn(),
  createSpendCategoryRpc: vi.fn(),
  renameInventoryCategoryRpc: vi.fn(),
  setInventoryCategoryActiveRpc: vi.fn(),
  renameSpendCategoryRpc: vi.fn(),
  setSpendCategoryActiveRpc: vi.fn(),
  updateInventoryCategoryDescriptionRpc: vi.fn(async () => undefined),
  updateSpendCategoryDescriptionRpc: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/itemMaster/createCategoryRpc", () => rpcMocks);
vi.mock("@/app/lib/itemMaster/rejectItemProposalRpc", () => ({ rejectItemProposalRpc: vi.fn() }));

import { updateInventoryCategoryDescription, updateSpendCategoryDescription } from "@/app/actions/itemMaster";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
});
afterEach(() => vi.clearAllMocks());

describe("category description admin actions", () => {
  for (const [name, call, rpc] of [
    ["updateInventoryCategoryDescription", () => updateInventoryCategoryDescription("c1", "desc"), rpcMocks.updateInventoryCategoryDescriptionRpc],
    ["updateSpendCategoryDescription", () => updateSpendCategoryDescription("c1", "desc"), rpcMocks.updateSpendCategoryDescriptionRpc],
  ] as const) {
    it(`${name} rejects a non-admin`, async () => {
      requireAdminMock.mockResolvedValue(NOT_ADMIN);
      const result = await call();
      expect(result.ok).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    });

    it(`${name} succeeds for an admin and derives org/actor from requireAdmin`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
      expect(rpc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: "org-1", appUserId: "admin-1", categoryId: "c1", description: "desc" }));
    });
  }
});
