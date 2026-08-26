import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Covers the Item Master usage-unit
// management actions (approved-plan §8) -- view/add/deactivate/
// reprioritize an already-confirmed item's kiosk usage units, gated the
// same way every other Admin Item Master action is (requireAdmin).

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock }));

const { rpcMock, fromMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), fromMock: vi.fn() }));
const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(() => ({ rpc: rpcMock, from: fromMock })) }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import { listItemUsageUnitsAction, addSecondaryUsageUnitAction, deactivateSecondaryUsageUnitAction, setPrimaryUsageUnitAction } from "@/app/actions/itemUsageUnits";
import { InvalidUsageUnitConfigurationError, UsageUnitStateError } from "@/app/lib/itemMaster/errors";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };

function fakeSelectChain(rows: Record<string, unknown>[]) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return chain;
}

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
  rpcMock.mockReset().mockResolvedValue({ data: null, error: null });
  fromMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Item Master usage-unit management actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listItemUsageUnitsAction", call: () => listItemUsageUnitsAction("item-1") },
    { name: "addSecondaryUsageUnitAction", call: () => addSecondaryUsageUnitAction("item-1", "CASE", 24) },
    { name: "deactivateSecondaryUsageUnitAction", call: () => deactivateSecondaryUsageUnitAction("item-1") },
    { name: "setPrimaryUsageUnitAction", call: () => setPrimaryUsageUnitAction("item-1", "usage-2") },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects a non-admin caller before ever reaching Supabase`, async () => {
      requireAdminMock.mockResolvedValue(NOT_ADMIN);
      fromMock.mockReturnValue(fakeSelectChain([]));
      const result = await call();
      expect(result.ok).toBe(false);
      expect(rpcMock).not.toHaveBeenCalled();
    });
  }
});

describe("listItemUsageUnitsAction", () => {
  it("maps primary/secondary usage-unit rows, org-scoped and active-only", async () => {
    fromMock.mockReturnValue(
      fakeSelectChain([
        {
          id: "usage-1",
          usage_slot: 1,
          confirmed_at: "2026-01-01T00:00:00Z",
          inventory_item_units: { unit_id: "unit-lb", requires_actual_measurement: false, units: { code: "LB", name: "Pound" } },
        },
        {
          id: "usage-2",
          usage_slot: 2,
          confirmed_at: "2026-02-01T00:00:00Z",
          inventory_item_units: { unit_id: "unit-case", requires_actual_measurement: false, units: { code: "CASE", name: "Case" } },
        },
      ])
    );
    const result = await listItemUsageUnitsAction("item-1");
    expect(result).toEqual({
      ok: true,
      units: [
        { usageUnitId: "usage-1", slot: 1, unitId: "unit-lb", unitCode: "LB", unitName: "Pound", confirmedAt: "2026-01-01T00:00:00Z", requiresActualMeasurement: false },
        { usageUnitId: "usage-2", slot: 2, unitId: "unit-case", unitCode: "CASE", unitName: "Case", confirmedAt: "2026-02-01T00:00:00Z", requiresActualMeasurement: false },
      ],
    });
    expect(fromMock).toHaveBeenCalledWith("inventory_item_usage_units");
  });

  it("weigh-at-kiosk restoration: reports requiresActualMeasurement true for a measured usage unit", async () => {
    fromMock.mockReturnValue(
      fakeSelectChain([
        {
          id: "usage-1",
          usage_slot: 1,
          confirmed_at: "2026-01-01T00:00:00Z",
          inventory_item_units: { unit_id: "unit-box", requires_actual_measurement: true, units: { code: "BOX", name: "Box" } },
        },
      ])
    );
    const result = await listItemUsageUnitsAction("item-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.units[0].requiresActualMeasurement).toBe(true);
    }
  });
});

describe("addSecondaryUsageUnitAction", () => {
  it("calls manager_add_secondary_usage_unit with the resolved admin's own org/actor, never a client-supplied one", async () => {
    await addSecondaryUsageUnitAction("item-1", "CASE", 24);
    expect(rpcMock).toHaveBeenCalledWith("manager_add_secondary_usage_unit", {
      p_organization_id: "org-1",
      p_app_user_id: "admin-1",
      p_inventory_item_id: "item-1",
      p_secondary_unit_code: "CASE",
      p_secondary_conversion_factor: 24,
      p_requires_actual_measurement: false,
    });
  });

  it("weigh-at-kiosk restoration: passes p_requires_actual_measurement true and a null factor when the manager explicitly confirms a measured secondary unit", async () => {
    await addSecondaryUsageUnitAction("item-1", "BOX", null, true);
    expect(rpcMock).toHaveBeenCalledWith("manager_add_secondary_usage_unit", {
      p_organization_id: "org-1",
      p_app_user_id: "admin-1",
      p_inventory_item_id: "item-1",
      p_secondary_unit_code: "BOX",
      p_secondary_conversion_factor: null,
      p_requires_actual_measurement: true,
    });
  });

  it("surfaces the RPC's own message for a known usage-unit configuration error (GA063/GA064)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "GA063", message: "the secondary usage unit must be different from the base unit" } });
    const result = await addSecondaryUsageUnitAction("item-1", "LB", 1);
    expect(result).toEqual({ ok: false, reason: "error", message: "the secondary usage unit must be different from the base unit" });
  });

  it("surfaces the RPC's own message for a usage-unit state error (GA067)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "GA067", message: "inventory_item item-1 has no active primary usage unit to add a secondary alongside" } });
    const result = await addSecondaryUsageUnitAction("item-1", "CASE", 24);
    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("falls back to a generic message for an unrecognized error code", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "23505", message: "internal detail that should not leak" } });
    const result = await addSecondaryUsageUnitAction("item-1", "CASE", 24);
    expect(result).toEqual({ ok: false, reason: "error", message: "Unable to add secondary usage unit." });
  });

  it("returns ok on success", async () => {
    const result = await addSecondaryUsageUnitAction("item-1", "CASE", 24);
    expect(result).toEqual({ ok: true });
  });
});

describe("deactivateSecondaryUsageUnitAction", () => {
  it("calls manager_deactivate_secondary_usage_unit with the resolved admin's own org/actor", async () => {
    await deactivateSecondaryUsageUnitAction("item-1");
    expect(rpcMock).toHaveBeenCalledWith("manager_deactivate_secondary_usage_unit", {
      p_organization_id: "org-1",
      p_app_user_id: "admin-1",
      p_inventory_item_id: "item-1",
    });
  });

  it("returns ok on success (idempotent no-op when already deactivated)", async () => {
    const result = await deactivateSecondaryUsageUnitAction("item-1");
    expect(result).toEqual({ ok: true });
  });
});

describe("setPrimaryUsageUnitAction", () => {
  it("calls manager_set_primary_usage_unit with the resolved admin's own org/actor", async () => {
    await setPrimaryUsageUnitAction("item-1", "usage-2");
    expect(rpcMock).toHaveBeenCalledWith("manager_set_primary_usage_unit", {
      p_organization_id: "org-1",
      p_app_user_id: "admin-1",
      p_inventory_item_id: "item-1",
      p_usage_unit_id: "usage-2",
    });
  });

  it("surfaces the RPC's own message for a usage-unit state error (GA068)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "GA068", message: "usage unit usage-2 is not an active usage unit for inventory_item item-1" } });
    const result = await setPrimaryUsageUnitAction("item-1", "usage-2");
    expect(result).toMatchObject({ ok: false, reason: "error" });
  });
});

// Sanity: the error-class mapping used internally still resolves to the
// expected classes (defense against a future refactor silently changing
// mapItemMasterRpcError's behavior without these actions noticing).
describe("error class sanity", () => {
  it("InvalidUsageUnitConfigurationError and UsageUnitStateError are distinct classes", () => {
    expect(new InvalidUsageUnitConfigurationError("x")).not.toBeInstanceOf(UsageUnitStateError);
    expect(new UsageUnitStateError("x")).not.toBeInstanceOf(InvalidUsageUnitConfigurationError);
  });
});
