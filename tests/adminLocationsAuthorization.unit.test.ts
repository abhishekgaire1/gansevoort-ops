import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves every Admin Storage Locations
// Server Action gates on requireAdmin() -- a plain manager (or
// unauthenticated caller) is rejected before any admin RPC is reached, and
// that mutations always use the authenticated admin's own org/actor, never
// a client-supplied one. Mirrors adminVendorsAuthorization.unit.test.ts.

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(() => ({})) }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const adminLocationsLib = vi.hoisted(() => ({
  listAdminLocations: vi.fn(async () => []),
  createLocation: vi.fn(async () => "location-new"),
  updateLocationName: vi.fn(async () => undefined),
  setLocationStorageEligible: vi.fn(async () => undefined),
  setLocationStatus: vi.fn(async () => undefined),
  setDefaultLocation: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/admin/locations", () => adminLocationsLib);

import {
  listAdminLocationsAction,
  createLocationAction,
  updateLocationNameAction,
  setLocationStorageEligibleAction,
  setLocationStatusAction,
  setDefaultLocationAction,
} from "@/app/actions/adminLocations";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Admin Storage Locations actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listAdminLocationsAction", call: () => listAdminLocationsAction() },
    { name: "createLocationAction", call: () => createLocationAction("Central Walk-In", true) },
    { name: "updateLocationNameAction", call: () => updateLocationNameAction("location-1", "New Name") },
    { name: "setLocationStorageEligibleAction", call: () => setLocationStorageEligibleAction("location-1", false) },
    { name: "setLocationStatusAction", call: () => setLocationStatusAction("location-1", false) },
    { name: "setDefaultLocationAction", call: () => setDefaultLocationAction("location-1") },
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

describe("mutations use the authenticated admin's own org/actor", () => {
  it("createLocationAction derives org/actor from requireAdmin(), never the caller", async () => {
    await createLocationAction("Central Walk-In", true);
    expect(adminLocationsLib.createLocation).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", "Central Walk-In", true);
  });

  it("setDefaultLocationAction derives org/actor from requireAdmin()", async () => {
    await setDefaultLocationAction("location-1");
    expect(adminLocationsLib.setDefaultLocation).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", "location-1");
  });
});
