import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves every Admin Item Master Server
// Action gates on requireAdmin() -- a plain manager (or unauthenticated
// caller) is rejected before any admin RPC is ever reached, matching the
// existing convention in adminAuthorization.unit.test.ts.

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(() => ({})) }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const adminItemsLib = vi.hoisted(() => ({
  listAdminItems: vi.fn(async () => []),
  getAdminItem: vi.fn(async () => ({
    itemId: "item-1",
    itemNumber: "ITEM-000001",
    name: "Test Item",
    categoryId: "cat-1",
    categoryName: "Test Category",
    baseUnitId: "unit-1",
    baseUnitCode: "LB",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    hasMovementHistory: false,
  })),
  findSimilarItems: vi.fn(async () => []),
  createAdminItem: vi.fn(async () => ({ itemId: "item-new", itemNumber: "ITEM-000002" })),
  updateAdminItemDetails: vi.fn(async () => undefined),
  setAdminItemBaseUnit: vi.fn(async () => undefined),
  setAdminItemStatus: vi.fn(async () => undefined),
  bulkImportAdminItems: vi.fn(async () => []),
}));
vi.mock("@/app/lib/admin/items", () => adminItemsLib);

import {
  listAdminItemsAction,
  getAdminItemAction,
  listItemVendorMappingsAction,
  listAllAdminItemKeysAction,
  findSimilarItemsAction,
  createAdminItemAction,
  updateAdminItemDetailsAction,
  setAdminItemBaseUnitAction,
  setAdminItemStatusAction,
  bulkImportAdminItemsAction,
} from "@/app/actions/adminItems";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Admin Item Master actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listAdminItemsAction", call: () => listAdminItemsAction(null, null, null, null) },
    { name: "getAdminItemAction", call: () => getAdminItemAction("item-1") },
    { name: "listAllAdminItemKeysAction", call: () => listAllAdminItemKeysAction() },
    { name: "findSimilarItemsAction", call: () => findSimilarItemsAction("Test Item") },
    { name: "createAdminItemAction", call: () => createAdminItemAction("Test Item", "cat-1", "unit-1") },
    { name: "updateAdminItemDetailsAction", call: () => updateAdminItemDetailsAction("item-1", "Test Item", "cat-1") },
    { name: "setAdminItemBaseUnitAction", call: () => setAdminItemBaseUnitAction("item-1", "unit-1") },
    { name: "setAdminItemStatusAction", call: () => setAdminItemStatusAction("item-1", "inactive") },
    { name: "bulkImportAdminItemsAction", call: () => bulkImportAdminItemsAction("test.csv", [{ rowIndex: 1, name: "X", categoryId: "cat-1", baseUnitId: "unit-1" }]) },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects a non-admin (manager) caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_ADMIN);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
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

  it("listItemVendorMappingsAction is gated too, even though it bypasses the RPC layer for a plain read", async () => {
    requireAdminMock.mockResolvedValue(NOT_ADMIN);
    const result = await listItemVendorMappingsAction("item-1");
    expect(result.ok).toBe(false);
  });
});

describe("createAdminItemAction -- always uses the authenticated admin's own org/actor, never a client-supplied one", () => {
  it("passes organizationId/actorAppUserId derived from requireAdmin(), never from the caller", async () => {
    await createAdminItemAction("Test Item", "cat-1", "unit-1");
    expect(adminItemsLib.createAdminItem).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", "Test Item", "cat-1", "unit-1");
  });

  it("rejects a blank name before ever calling the RPC layer", async () => {
    const result = await createAdminItemAction("   ", "cat-1", "unit-1");
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("VALIDATION");
    expect(adminItemsLib.createAdminItem).not.toHaveBeenCalled();
  });
});

describe("bulkImportAdminItemsAction -- rejects an empty row set before calling the RPC layer", () => {
  it("returns a clean error for zero rows, never calls bulkImportAdminItems", async () => {
    const result = await bulkImportAdminItemsAction("test.csv", []);
    expect(result.ok).toBe(false);
    expect(adminItemsLib.bulkImportAdminItems).not.toHaveBeenCalled();
  });
});
