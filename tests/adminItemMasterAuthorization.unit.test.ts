import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves every Item Master Server
// Action gates on requireManagerOrAdmin() -- per the 2026-09-16 product
// decision the Item Master is a full-capability surface for ALL managers
// (this replaced the earlier tiered-permissions design), so a plain
// manager succeeds on every action while an unauthenticated or
// non-manager caller is rejected before any RPC is ever reached.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

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
    disposition: "INVENTORY",
    spendCategoryId: null,
    spendCategoryName: null,
    defaultReceivingLocationId: null,
    defaultReceivingLocationName: null,
  })),
  findSimilarItems: vi.fn(async () => []),
  createAdminItem: vi.fn(async () => ({ itemId: "item-new", itemNumber: "ITEM-000002" })),
  updateAdminItemDetails: vi.fn(async () => undefined),
  setAdminItemBaseUnit: vi.fn(async () => undefined),
  setAdminItemStatus: vi.fn(async () => undefined),
  bulkImportAdminItems: vi.fn(async () => []),
}));
vi.mock("@/app/lib/admin/items", () => adminItemsLib);

vi.mock("@/app/lib/admin/itemWorkspace", () => ({
  getItemWorkspaceOverview: vi.fn(async () => ({ item: {}, totalOnHandQuantity: 0, locationBalances: [], estimatedTotalValue: null, estimatedUnitCost: null })),
  getAdminItemArchiveDependencies: vi.fn(async () => ({ hasPositiveStock: false, positiveStockLocations: [], activeVendorMappingCount: 0, activeUsageUnitCount: 0, openDocumentLineCount: 0 })),
}));
vi.mock("@/app/lib/admin/itemHistory", () => ({ listItemHistory: vi.fn(async () => []) }));
vi.mock("@/app/lib/admin/vendorPackages", () => ({
  listItemVendorPackages: vi.fn(async () => []),
  setVendorPurchasePackage: vi.fn(async () => ({ vendorItemPurchaseUnitId: "vpu-1" })),
  listReceiptsUsingVendorPackage: vi.fn(async () => []),
  correctReceiptPackageFactor: vi.fn(async () => ({ correctionIds: ["c-1"], replayed: false })),
}));
vi.mock("@/app/lib/inventory/corrections", () => ({
  recordInventoryCorrection: vi.fn(async () => ({ correctionId: "c-1", movementId: "m-1", previousBalance: 0, newBalance: 1, replayed: false })),
  previewInventoryCorrection: vi.fn(async () => ({ previousBalance: 0, proposedBalance: 1, delta: 1, wouldGoNegative: false, baseUnitCode: "LB" })),
}));

import {
  listAdminItemsAction,
  getAdminItemAction,
  getItemWorkspaceOverviewAction,
  listItemVendorPackagesAction,
  listItemHistoryAction,
  listAllAdminItemKeysAction,
  findSimilarItemsAction,
  createAdminItemAction,
  updateAdminItemDetailsAction,
  setAdminItemBaseUnitAction,
  setAdminItemStatusAction,
  bulkImportAdminItemsAction,
  getAdminItemArchiveDependenciesAction,
  listReceiptsUsingVendorPackageAction,
  setVendorPurchasePackageAction,
  correctReceiptPackageFactorAction,
  previewInventoryCorrectionAction,
  recordInventoryCorrectionAction,
} from "@/app/actions/adminItems";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const MANAGER_ONLY = { ok: true as const, manager: { appUserId: "mgr-1", organizationId: "org-1", authUserId: "auth-2", roles: ["manager"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(ADMIN);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Item Master actions -- authorization gate (requireManagerOrAdmin, full manager capability)", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listAdminItemsAction", call: () => listAdminItemsAction(null, null, null, null) },
    { name: "getAdminItemAction", call: () => getAdminItemAction("item-1") },
    { name: "getItemWorkspaceOverviewAction", call: () => getItemWorkspaceOverviewAction("item-1") },
    { name: "listItemVendorPackagesAction", call: () => listItemVendorPackagesAction("item-1") },
    { name: "listItemHistoryAction", call: () => listItemHistoryAction("item-1") },
    { name: "updateAdminItemDetailsAction", call: () => updateAdminItemDetailsAction("item-1", "Test Item", "cat-1") },
    { name: "createAdminItemAction", call: () => createAdminItemAction("Test Item", "cat-1", "unit-1") },
    { name: "findSimilarItemsAction", call: () => findSimilarItemsAction("Test Item") },
    { name: "listAllAdminItemKeysAction", call: () => listAllAdminItemKeysAction() },
    { name: "setAdminItemBaseUnitAction", call: () => setAdminItemBaseUnitAction("item-1", "unit-1") },
    { name: "setAdminItemStatusAction", call: () => setAdminItemStatusAction("item-1", "inactive") },
    { name: "bulkImportAdminItemsAction", call: () => bulkImportAdminItemsAction("test.csv", [{ rowIndex: 1, name: "X", categoryId: "cat-1", baseUnitId: "unit-1" }]) },
    { name: "getAdminItemArchiveDependenciesAction", call: () => getAdminItemArchiveDependenciesAction("item-1") },
    { name: "setVendorPurchasePackageAction", call: () => setVendorPurchasePackageAction("mapping-1", "PACK", "FIXED_CONVERSION", 10, false) },
    { name: "listReceiptsUsingVendorPackageAction", call: () => listReceiptsUsingVendorPackageAction("vpu-1") },
    { name: "correctReceiptPackageFactorAction", call: () => correctReceiptPackageFactorAction(["pl-1"], "vpu-2", "test reason", "req-1") },
    { name: "previewInventoryCorrectionAction", call: () => previewInventoryCorrectionAction("item-1", "loc-1", "COUNTED", 10, null) },
    { name: "recordInventoryCorrectionAction", call: () => recordInventoryCorrectionAction("item-1", "loc-1", "COUNTED", 10, null, "test reason", "req-1") },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects an unauthenticated caller`, async () => {
      requireManagerOrAdminMock.mockResolvedValue(NOT_AUTHENTICATED);
      const result = await call();
      expect(result.ok).toBe(false);
    });

    it(`${name} rejects a caller with no manager/admin role`, async () => {
      requireManagerOrAdminMock.mockResolvedValue(NOT_ADMIN);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
    });

    it(`${name} succeeds for a plain manager caller (no admin role required)`, async () => {
      requireManagerOrAdminMock.mockResolvedValue(MANAGER_ONLY);
      const result = await call();
      expect(result.ok).toBe(true);
    });

    it(`${name} succeeds for an admin caller`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
    });
  }
});

describe("createAdminItemAction -- always uses the authenticated caller's own org/actor, never a client-supplied one", () => {
  it("passes organizationId/actorAppUserId derived from requireManagerOrAdmin(), never from the caller", async () => {
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
