import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves the Manager Categories
// milestone's read-only surface gates on requireManagerOrAdmin() (Part
// 47) -- NOT requireAdmin() -- so a plain Manager can view, matching
// "Manager -> read, Admin -> read" (never write) for this route family.
// Also proves invalid custom-range rejection happens before any
// aggregation query.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: vi.fn(() => ({})) }));

vi.mock("@/app/lib/dateRanges/organizationTimezone", () => ({ resolveOrganizationTimezone: vi.fn(async () => "America/New_York") }));

const inventoryLib = vi.hoisted(() => ({
  listManagerInventoryCategories: vi.fn(async () => []),
  getManagerInventoryCategory: vi.fn(async () => ({ categoryId: "cat-1", name: "Dairy", isActive: true })),
  listManagerInventoryCategoryItems: vi.fn(async () => []),
}));
vi.mock("@/app/lib/categories/managerInventoryCategories", () => inventoryLib);

const expenseLib = vi.hoisted(() => ({
  listManagerExpenseCategories: vi.fn(async () => []),
  getManagerExpenseCategory: vi.fn(async (): Promise<{ categoryId: string; name: string; isActive: boolean } | null> => ({ categoryId: "cat-1", name: "Repairs & Maintenance", isActive: true })),
  getManagerExpenseCategorySummary: vi.fn(async () => ({ totalAmount: 0, lineCount: 0, excludedCreditMemoCount: 0 })),
  listManagerExpenseCategoryLines: vi.fn(async () => []),
}));
vi.mock("@/app/lib/categories/managerExpenseCategories", () => expenseLib);

import {
  listManagerInventoryCategoriesAction,
  getManagerInventoryCategoryAction,
  listManagerExpenseCategoriesAction,
  getManagerExpenseCategoryAction,
} from "@/app/actions/managerCategories";

const MANAGER = { ok: true as const, manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] } };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Manager Categories actions -- read access for a plain Manager (never requireAdmin)", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listManagerInventoryCategoriesAction", call: () => listManagerInventoryCategoriesAction() },
    { name: "getManagerInventoryCategoryAction", call: () => getManagerInventoryCategoryAction("cat-1") },
    { name: "listManagerExpenseCategoriesAction", call: () => listManagerExpenseCategoriesAction() },
    { name: "getManagerExpenseCategoryAction", call: () => getManagerExpenseCategoryAction("cat-1", "TODAY") },
  ];

  for (const { name, call } of cases) {
    it(`${name} succeeds for a plain (non-admin) Manager`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
    });

    it(`${name} rejects an unauthenticated caller`, async () => {
      requireManagerOrAdminMock.mockResolvedValue(NOT_AUTHENTICATED);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
    });
  }
});

describe("getManagerExpenseCategoryAction -- custom range validation", () => {
  it("rejects start after end without calling the summary/lines RPCs", async () => {
    const result = await getManagerExpenseCategoryAction("cat-1", "CUSTOM", "2026-08-20", "2026-08-01");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("invalid_range");
    expect(expenseLib.getManagerExpenseCategorySummary).not.toHaveBeenCalled();
  });

  it("rejects a custom period with missing dates", async () => {
    const result = await getManagerExpenseCategoryAction("cat-1", "CUSTOM");
    expect(result.ok).toBe(false);
    expect(expenseLib.getManagerExpenseCategorySummary).not.toHaveBeenCalled();
  });

  it("returns not_found for a category that doesn't exist in this org", async () => {
    expenseLib.getManagerExpenseCategory.mockResolvedValueOnce(null);
    const result = await getManagerExpenseCategoryAction("cat-missing", "TODAY");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("not_found");
  });
});

describe("No mutation capability exists on this surface", () => {
  it("the actions module exports only read functions", async () => {
    const mod = await import("@/app/actions/managerCategories");
    const exportNames = Object.keys(mod);
    for (const name of exportNames) {
      expect(name).not.toMatch(/create|rename|deactivate|reactivate|set.*Active|delete/i);
    }
  });
});
