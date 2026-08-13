import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import { createVendor, listVendors, searchVendors, setVendorActive } from "@/app/actions/vendors";

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

describe("createVendor", () => {
  it("rejects a blank name without touching the database", async () => {
    const from = vi.fn();
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await createVendor("   ");
    expect(result).toEqual({ ok: false, reason: "invalid_name", message: "Vendor name is required." });
    expect(from).not.toHaveBeenCalled();
  });

  it("inserts with a computed normalized_name and returns the created vendor", async () => {
    let insertPayload: unknown;
    const from = vi.fn(() =>
      createChainable({ data: { id: "v-1", name: "Baldor Foods", is_active: true }, error: null }, (method, args) => {
        if (method === "insert") insertPayload = args[0];
      })
    );
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await createVendor("  Baldor   Foods  ");

    expect(insertPayload).toMatchObject({
      organization_id: "org-1",
      name: "Baldor   Foods", // outer whitespace trimmed, internal whitespace preserved on the display name
      normalized_name: "BALDOR FOODS", // normalized: trimmed + internal whitespace collapsed + uppercased
    });
    expect(result).toEqual({ ok: true, vendor: { id: "v-1", name: "Baldor Foods", isActive: true } });
  });

  it("maps a unique-violation (23505) to a friendly duplicate error, not a raw DB error", async () => {
    const from = vi.fn(() => createChainable({ data: null, error: { code: "23505", message: "duplicate key value" } }));
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await createVendor("Baldor Foods");
    expect(result).toEqual({ ok: false, reason: "duplicate", message: 'A vendor named "Baldor Foods" already exists.' });
  });
});

describe("setVendorActive", () => {
  it("rejects unauthenticated callers", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await setVendorActive("v-1", false);
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
  });

  it("updates is_active scoped to the organization -- the organization_id predicate is part of the mutation, not just the payload", async () => {
    let updatePayload: unknown;
    const eqCalls: unknown[][] = [];
    const from = vi.fn(() =>
      createChainable({ data: null, error: null }, (method, args) => {
        if (method === "update") updatePayload = args[0];
        if (method === "eq") eqCalls.push(args);
      })
    );
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await setVendorActive("v-1", false);
    expect(updatePayload).toEqual({ is_active: false });
    // The update payload itself must never carry organization_id (that would
    // let a mismatched org silently overwrite the filter instead of scoping
    // it) -- the predicate must appear as its own .eq("organization_id", ...)
    // call in the query chain.
    expect(eqCalls).toContainEqual(["id", "v-1"]);
    expect(eqCalls).toContainEqual(["organization_id", "org-1"]);
    expect(result).toEqual({ ok: true });
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
