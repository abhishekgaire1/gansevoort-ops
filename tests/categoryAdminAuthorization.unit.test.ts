import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves the Admin Master Data
// milestone's category-creation lockdown: createInventoryCategory/
// createSpendCategory/rename*/set*Active now gate on requireAdmin(), not
// requireManagerOrAdmin() -- previously ANY manager could create a new
// canonical category "on the spot" from inside Receiving (Part 23/41).
// Read paths (listInventoryCategories/listSpendCategories) are
// deliberately untouched -- Managers still SELECT approved categories.

const { requireAdminMock, requireManagerOrAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn(), requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock, requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(() => ({})) }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const createCategoryRpc = vi.hoisted(() => ({
  createInventoryCategoryRpc: vi.fn(async () => ({ categoryId: "cat-new" })),
  createSpendCategoryRpc: vi.fn(async () => ({ categoryId: "cat-new" })),
  renameInventoryCategoryRpc: vi.fn(async () => undefined),
  setInventoryCategoryActiveRpc: vi.fn(async () => undefined),
  renameSpendCategoryRpc: vi.fn(async () => undefined),
  setSpendCategoryActiveRpc: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/itemMaster/createCategoryRpc", () => createCategoryRpc);

vi.mock("@/app/lib/itemMaster/rejectItemProposalRpc", () => ({ rejectItemProposalRpc: vi.fn() }));

import { createInventoryCategory, createSpendCategory, renameInventoryCategory, setInventoryCategoryActive, renameSpendCategory, setSpendCategoryActive } from "@/app/actions/itemMaster";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
  requireManagerOrAdminMock.mockReset().mockResolvedValue(ADMIN);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Category creation/mutation actions -- Admin-only gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "createInventoryCategory", call: () => createInventoryCategory("Dairy") },
    { name: "createSpendCategory", call: () => createSpendCategory("Repairs") },
    { name: "renameInventoryCategory", call: () => renameInventoryCategory("cat-1", "Dairy Renamed") },
    { name: "setInventoryCategoryActive", call: () => setInventoryCategoryActive("cat-1", false) },
    { name: "renameSpendCategory", call: () => renameSpendCategory("cat-1", "Repairs Renamed") },
    { name: "setSpendCategoryActive", call: () => setSpendCategoryActive("cat-1", false) },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects a non-admin manager caller (message says Admin, never generic 'manager or admin')`, async () => {
      requireAdminMock.mockResolvedValue(NOT_ADMIN);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
      expect((result as { message?: string }).message).toBe("You must be signed in as an Admin.");
    });

    it(`${name} rejects an unauthenticated caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_AUTHENTICATED);
      const result = await call();
      expect(result.ok).toBe(false);
    });

    it(`${name} succeeds for an admin caller`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
    });
  }
});

describe("setInventoryCategoryActive / setSpendCategoryActive -- surface the deactivation-blocked error distinctly", () => {
  it("maps CategoryDeactivationBlockedError to reason 'blocked' with the RPC's own message, not a generic failure", async () => {
    const { CategoryDeactivationBlockedError } = await import("@/app/lib/itemMaster/errors");
    createCategoryRpc.setInventoryCategoryActiveRpc.mockRejectedValueOnce(
      new CategoryDeactivationBlockedError("this category cannot be deactivated because 3 active inventory items use it -- reassign those items first")
    );

    const result = await setInventoryCategoryActive("cat-1", false);
    expect(result).toEqual({
      ok: false,
      reason: "blocked",
      message: "this category cannot be deactivated because 3 active inventory items use it -- reassign those items first",
    });
  });

  it("maps CategoryDeactivationBlockedError for spend categories the same way", async () => {
    const { CategoryDeactivationBlockedError } = await import("@/app/lib/itemMaster/errors");
    createCategoryRpc.setSpendCategoryActiveRpc.mockRejectedValueOnce(new CategoryDeactivationBlockedError("this category cannot be deactivated because 2 active subcategories depend on it"));

    const result = await setSpendCategoryActive("cat-1", false);
    expect(result).toEqual({ ok: false, reason: "blocked", message: "this category cannot be deactivated because 2 active subcategories depend on it" });
  });
});
