import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getKioskUsageUnitsForItem } from "@/app/lib/kiosk/withdrawalUnit";

// CI-safe: no network, no database -- fakes the two-query Supabase chain
// under the purchase-versus-usage unit model (20260811100113): an item
// lookup (org-scoped existence check), then the item's confirmed kiosk
// usage units (inventory_item_usage_units joined to inventory_item_units/
// units) -- one required primary (usage_slot 1), one optional secondary
// (usage_slot 2). Deliberately never fetches or returns conversion_factor
// -- the server always re-derives the authoritative factor itself at
// withdrawal time (approved-plan §11).

interface FakeSupabaseOptions {
  item: Record<string, unknown> | null;
  itemError?: unknown;
  usageUnitRows?: Record<string, unknown>[] | null;
  usageUnitsError?: unknown;
}

function usageUnitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "usage-1",
    usage_slot: 1,
    inventory_item_units: { unit_id: "unit-lb", is_active: true, requires_actual_measurement: false, units: { code: "LB", name: "Pound" } },
    ...overrides,
  };
}

function createFakeSupabase({ item, itemError = null, usageUnitRows = [], usageUnitsError = null }: FakeSupabaseOptions) {
  const itemMaybeSingle = vi.fn().mockResolvedValue({ data: item, error: itemError });
  const itemEqOrg = vi.fn().mockReturnValue({ maybeSingle: itemMaybeSingle });
  const itemEqId = vi.fn().mockReturnValue({ eq: itemEqOrg });
  const itemSelect = vi.fn().mockReturnValue({ eq: itemEqId });

  const usageUnitsOrder = vi.fn().mockResolvedValue({ data: usageUnitRows, error: usageUnitsError });
  const usageUnitsEqIiuActive = vi.fn().mockReturnValue({ order: usageUnitsOrder });
  const usageUnitsEqActive = vi.fn().mockReturnValue({ eq: usageUnitsEqIiuActive });
  const usageUnitsEqItem = vi.fn().mockReturnValue({ eq: usageUnitsEqActive });
  const usageUnitsEqOrg = vi.fn().mockReturnValue({ eq: usageUnitsEqItem });
  const usageUnitsSelect = vi.fn().mockReturnValue({ eq: usageUnitsEqOrg });

  const from = vi.fn((table: string) => {
    if (table === "inventory_items") return { select: itemSelect };
    if (table === "inventory_item_usage_units") return { select: usageUnitsSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    itemEqId,
    itemEqOrg,
    usageUnitsSelect,
    usageUnitsEqOrg,
    usageUnitsEqItem,
    usageUnitsEqActive,
    usageUnitsEqIiuActive,
    usageUnitsOrder,
  };
}

describe("getKioskUsageUnitsForItem", () => {
  it("returns item_not_found and never queries usage units when the item doesn't resolve in the caller's org", async () => {
    const { client, from } = createFakeSupabase({ item: null });
    const result = await getKioskUsageUnitsForItem(client, "org-1", "item-1");
    expect(result).toEqual({ ok: false, reason: "item_not_found" });
    expect(from).not.toHaveBeenCalledWith("inventory_item_usage_units");
  });

  it("scopes the item lookup by both id and organization_id", async () => {
    const { client, itemEqId, itemEqOrg } = createFakeSupabase({ item: { id: "item-1" }, usageUnitRows: [usageUnitRow()] });
    await getKioskUsageUnitsForItem(client, "org-1", "item-1");
    expect(itemEqId).toHaveBeenCalledWith("id", "item-1");
    expect(itemEqOrg).toHaveBeenCalledWith("organization_id", "org-1");
  });

  it("returns unit_not_configured when there is no active primary (slot 1) usage unit", async () => {
    const { client } = createFakeSupabase({ item: { id: "item-1" }, usageUnitRows: [] });
    const result = await getKioskUsageUnitsForItem(client, "org-1", "item-1");
    expect(result).toEqual({ ok: false, reason: "unit_not_configured" });
  });

  it("returns a one-unit result (no selector needed) when only a primary usage unit exists", async () => {
    const { client } = createFakeSupabase({
      item: { id: "item-1" },
      usageUnitRows: [usageUnitRow({ id: "usage-1", usage_slot: 1 })],
    });
    const result = await getKioskUsageUnitsForItem(client, "org-1", "item-1");
    expect(result).toEqual({
      ok: true,
      units: {
        primary: { usageUnitId: "usage-1", unitId: "unit-lb", unitCode: "LB", unitName: "Pound", slot: 1 },
        secondary: null,
        needsSelector: false,
      },
    });
  });

  it("returns needsSelector true with both units when a secondary usage unit is also confirmed", async () => {
    const { client } = createFakeSupabase({
      item: { id: "item-1" },
      usageUnitRows: [
        usageUnitRow({ id: "usage-1", usage_slot: 1 }),
        usageUnitRow({
          id: "usage-2",
          usage_slot: 2,
          inventory_item_units: { unit_id: "unit-case", is_active: true, requires_actual_measurement: false, units: { code: "CASE", name: "Case" } },
        }),
      ],
    });
    const result = await getKioskUsageUnitsForItem(client, "org-1", "item-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.units.needsSelector).toBe(true);
      expect(result.units.secondary).toEqual({ usageUnitId: "usage-2", unitId: "unit-case", unitCode: "CASE", unitName: "Case", slot: 2 });
    }
  });

  it("never includes a conversion factor anywhere in the result -- display fields only", async () => {
    const { client } = createFakeSupabase({ item: { id: "item-1" }, usageUnitRows: [usageUnitRow()] });
    const result = await getKioskUsageUnitsForItem(client, "org-1", "item-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.units.primary)).toEqual(["usageUnitId", "unitId", "unitCode", "unitName", "slot"]);
    }
  });

  it("scopes the usage-unit query to the organization, the item, both is_active flags, and orders by usage_slot ascending", async () => {
    const { client, usageUnitsSelect, usageUnitsEqOrg, usageUnitsEqItem, usageUnitsEqActive, usageUnitsEqIiuActive, usageUnitsOrder } = createFakeSupabase({
      item: { id: "item-1" },
      usageUnitRows: [usageUnitRow()],
    });
    await getKioskUsageUnitsForItem(client, "org-1", "item-1");
    expect(usageUnitsSelect).toHaveBeenCalledWith("id, usage_slot, inventory_item_units!inner(unit_id, is_active, requires_actual_measurement, units(code, name))");
    expect(usageUnitsEqOrg).toHaveBeenCalledWith("organization_id", "org-1");
    expect(usageUnitsEqItem).toHaveBeenCalledWith("inventory_item_id", "item-1");
    expect(usageUnitsEqActive).toHaveBeenCalledWith("is_active", true);
    expect(usageUnitsEqIiuActive).toHaveBeenCalledWith("inventory_item_units.is_active", true);
    expect(usageUnitsOrder).toHaveBeenCalledWith("usage_slot", { ascending: true });
  });

  it("throws on a Postgres error from the item lookup", async () => {
    const { client } = createFakeSupabase({ item: null, itemError: { message: "boom" } });
    await expect(getKioskUsageUnitsForItem(client, "org-1", "item-1")).rejects.toThrow("boom");
  });

  it("throws on a Postgres error from the usage-unit query", async () => {
    const { client } = createFakeSupabase({ item: { id: "item-1" }, usageUnitsError: { message: "boom" } });
    await expect(getKioskUsageUnitsForItem(client, "org-1", "item-1")).rejects.toThrow("boom");
  });
});
