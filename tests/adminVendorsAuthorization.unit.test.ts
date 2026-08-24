import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves every Admin Vendors Server
// Action gates on requireAdmin() -- a plain manager (or unauthenticated
// caller) is rejected before any admin RPC is ever reached, matching the
// existing convention in adminItemMasterAuthorization.unit.test.ts. This is
// the exact gap the Admin Master Data milestone closes: createVendor/
// setVendorActive used to be reachable by ANY manager.

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(() => ({})) }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const adminVendorsLib = vi.hoisted(() => ({
  listAdminVendors: vi.fn(async () => []),
  getAdminVendor: vi.fn(async () => ({
    vendorId: "vendor-1",
    name: "Test Vendor",
    legalName: null,
    accountNumber: null,
    contactName: null,
    email: null,
    phone: null,
    notes: null,
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
  })),
  listVendorAliases: vi.fn(async () => []),
  getVendorItemMappings: vi.fn(async () => []),
  findSimilarVendors: vi.fn(async () => []),
  createAdminVendor: vi.fn(async () => ({ vendorId: "vendor-new" })),
  updateAdminVendorDetails: vi.fn(async () => undefined),
  setAdminVendorActive: vi.fn(async () => undefined),
  addAdminVendorAlias: vi.fn(async () => ({ aliasId: "alias-1" })),
  removeAdminVendorAlias: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/admin/vendors", () => adminVendorsLib);

import {
  listAdminVendorsAction,
  getAdminVendorAction,
  findSimilarVendorsAction,
  createAdminVendorAction,
  updateAdminVendorDetailsAction,
  setAdminVendorActiveAction,
  addAdminVendorAliasAction,
  removeAdminVendorAliasAction,
} from "@/app/actions/adminVendors";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Admin Vendors actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listAdminVendorsAction", call: () => listAdminVendorsAction(null, null) },
    { name: "getAdminVendorAction", call: () => getAdminVendorAction("vendor-1") },
    { name: "findSimilarVendorsAction", call: () => findSimilarVendorsAction("Test Vendor") },
    { name: "createAdminVendorAction", call: () => createAdminVendorAction({ name: "Test Vendor" }) },
    { name: "updateAdminVendorDetailsAction", call: () => updateAdminVendorDetailsAction("vendor-1", { name: "Test Vendor" }) },
    { name: "setAdminVendorActiveAction", call: () => setAdminVendorActiveAction("vendor-1", false) },
    { name: "addAdminVendorAliasAction", call: () => addAdminVendorAliasAction("vendor-1", "ALIAS") },
    { name: "removeAdminVendorAliasAction", call: () => removeAdminVendorAliasAction("alias-1") },
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
});

describe("createAdminVendorAction -- always uses the authenticated admin's own org/actor, never a client-supplied one", () => {
  it("passes organizationId/actorAppUserId derived from requireAdmin(), never from the caller", async () => {
    await createAdminVendorAction({ name: "Test Vendor" });
    expect(adminVendorsLib.createAdminVendor).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", { name: "Test Vendor" });
  });

  it("rejects a blank name before ever calling the RPC layer", async () => {
    const result = await createAdminVendorAction({ name: "   " });
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("VALIDATION");
    expect(adminVendorsLib.createAdminVendor).not.toHaveBeenCalled();
  });
});

describe("addAdminVendorAliasAction -- rejects blank alias text before calling the RPC layer", () => {
  it("returns a clean validation error, never calls addAdminVendorAlias", async () => {
    const result = await addAdminVendorAliasAction("vendor-1", "   ");
    expect(result.ok).toBe(false);
    expect(adminVendorsLib.addAdminVendorAlias).not.toHaveBeenCalled();
  });
});
