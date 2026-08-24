import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import { createVendorFromReceiving, listVendors, searchVendors } from "@/app/actions/vendors";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

/** Any method call continues the same chain; only `.then` resolves it --
 * lets a single fake support the variable-length filter chains vendors.ts
 * builds (e.g. an extra conditional `.eq("is_active", true)`). */
function createChainable(result: { data: unknown; error: unknown }, onCall?: (method: string, args: unknown[]) => void): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => Promise.resolve(result).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        onCall?.(String(prop), args);
        return proxy;
      };
    },
  };
  const proxy: unknown = new Proxy(() => {}, handler);
  return proxy;
}

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listVendors / searchVendors", () => {
  it("rejects unauthenticated callers", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await listVendors();
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
  });

  it("maps rows to VendorSummary", async () => {
    const from = vi.fn(() => createChainable({ data: [{ id: "v-1", name: "Baldor", is_active: true }], error: null }));
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await listVendors();
    expect(result).toEqual({ ok: true, vendors: [{ id: "v-1", name: "Baldor", isActive: true }] });
  });
});

describe("searchVendors", () => {
  it("returns active vendors matching the query", async () => {
    const from = vi.fn(() => createChainable({ data: [{ id: "v-1", name: "Baldor", is_active: true }], error: null }));
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await searchVendors("bal");
    expect(result.ok).toBe(true);
  });
});

/**
 * Admin Master Data milestone: general Vendor administration
 * (createVendor/setVendorActive) moved to app/actions/adminVendors.ts,
 * Admin-only -- see adminVendorsAuthorization.unit.test.ts. What remains
 * Manager-callable here is ONLY this narrowly-scoped exception (Part
 * 15-17/42): a Manager reviewing a real invoice may create a vendor by
 * name when no existing match is found, so Receiving never stalls
 * waiting on an Admin.
 */
describe("createVendorFromReceiving", () => {
  it("rejects unauthenticated callers without calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const rpc = vi.fn();
    getServiceRoleClientMock.mockReturnValue({ rpc });

    const result = await createVendorFromReceiving("Baldor Foods");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a blank name without calling the RPC", async () => {
    const rpc = vi.fn();
    getServiceRoleClientMock.mockReturnValue({ rpc });

    const result = await createVendorFromReceiving("   ");
    expect(result).toEqual({ ok: false, reason: "invalid_name", message: "Vendor name is required." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls create_vendor_from_receiving with the authenticated manager's own org/actor, never a client-supplied one", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ out_vendor_id: "v-new", out_name: "Baldor Foods" }], error: null });
    getServiceRoleClientMock.mockReturnValue({ rpc });

    const result = await createVendorFromReceiving("  Baldor Foods  ", "pd-1");

    expect(rpc).toHaveBeenCalledWith("create_vendor_from_receiving", {
      p_organization_id: "org-1",
      p_actor_app_user_id: "user-1",
      p_vendor_name: "Baldor Foods",
      p_purchase_document_id: "pd-1",
    });
    expect(result).toEqual({ ok: true, vendor: { id: "v-new", name: "Baldor Foods", isActive: true } });
  });

  it("defaults p_purchase_document_id to null when the caller doesn't supply one (the pre-upload quick-create context, before any document exists)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ out_vendor_id: "v-new", out_name: "Baldor Foods" }], error: null });
    getServiceRoleClientMock.mockReturnValue({ rpc });

    await createVendorFromReceiving("Baldor Foods");

    expect(rpc).toHaveBeenCalledWith("create_vendor_from_receiving", expect.objectContaining({ p_purchase_document_id: null }));
  });

  it("maps a GA052 duplicate error to a friendly, typed result carrying the existing vendor's id/name -- never a raw Postgres error", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "GA052", message: 'a vendor named "Baldor Foods" already exists', details: JSON.stringify({ existingVendorId: "v-1", existingVendorName: "Baldor Foods" }) },
    });
    getServiceRoleClientMock.mockReturnValue({ rpc });

    const result = await createVendorFromReceiving("Baldor Foods");
    expect(result).toEqual({
      ok: false,
      reason: "duplicate",
      message: 'a vendor named "Baldor Foods" already exists',
      existingVendorId: "v-1",
      existingVendorName: "Baldor Foods",
    });
  });

  it("maps any other RPC error to a generic, safe message -- never a raw Postgres error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "XX000", message: "internal server crash detail" } });
    getServiceRoleClientMock.mockReturnValue({ rpc });

    const result = await createVendorFromReceiving("Baldor Foods");
    expect(result).toEqual({ ok: false, reason: "misconfigured", message: "Could not create the vendor. Try again." });
  });
});
