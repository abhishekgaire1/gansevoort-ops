import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActiveItemUnitsForItem } from "@/app/lib/kiosk/inventoryItemUnits";

// CI-safe: no network, no database -- fakes the two-query Supabase chain
// (item existence/org-scope check, then its active units).

interface FakeSupabaseOptions {
  item: Record<string, unknown> | null;
  itemError?: unknown;
  unitRows?: Record<string, unknown>[] | null;
  unitsError?: unknown;
}

function createFakeSupabase({ item, itemError = null, unitRows = [], unitsError = null }: FakeSupabaseOptions) {
  const itemMaybeSingle = vi.fn().mockResolvedValue({ data: item, error: itemError });
  const itemEqOrg = vi.fn().mockReturnValue({ maybeSingle: itemMaybeSingle });
  const itemEqId = vi.fn().mockReturnValue({ eq: itemEqOrg });
  const itemSelect = vi.fn().mockReturnValue({ eq: itemEqId });

  const unitsEqActive = vi.fn().mockResolvedValue({ data: unitRows, error: unitsError });
  const unitsEqItem = vi.fn().mockReturnValue({ eq: unitsEqActive });
  const unitsSelect = vi.fn().mockReturnValue({ eq: unitsEqItem });

  const from = vi.fn((table: string) => {
    if (table === "inventory_items") return { select: itemSelect };
    if (table === "inventory_item_units") return { select: unitsSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  return { client: { from } as unknown as SupabaseClient, from, itemEqId, itemEqOrg, unitsEqItem, unitsEqActive };
}

describe("listActiveItemUnitsForItem", () => {
  it("returns item_not_found and never queries units when the item doesn't resolve in the caller's org", async () => {
    const { client, from } = createFakeSupabase({ item: null });
    const result = await listActiveItemUnitsForItem(client, "org-1", "item-1");
    expect(result).toEqual({ ok: false, reason: "item_not_found" });
    expect(from).not.toHaveBeenCalledWith("inventory_item_units");
  });

  it("scopes the item lookup by both id and organization_id", async () => {
    const { client, itemEqId, itemEqOrg } = createFakeSupabase({
      item: { id: "item-1", units: { code: "LB", name: "Pound" } },
      unitRows: [],
    });
    await listActiveItemUnitsForItem(client, "org-1", "item-1");
    expect(itemEqId).toHaveBeenCalledWith("id", "item-1");
    expect(itemEqOrg).toHaveBeenCalledWith("organization_id", "org-1");
  });

  it("returns the item's base unit code/name alongside its active entry units", async () => {
    const { client, unitsEqItem, unitsEqActive } = createFakeSupabase({
      item: { id: "item-1", units: { code: "LB", name: "Pound" } },
      unitRows: [
        {
          unit_id: "unit-box",
          conversion_factor: null,
          requires_actual_measurement: true,
          is_default_entry_unit: true,
          units: { code: "BOX", name: "Box" },
        },
        {
          unit_id: "unit-case",
          conversion_factor: "10",
          requires_actual_measurement: false,
          is_default_entry_unit: false,
          units: { code: "CASE", name: "Case" },
        },
      ],
    });

    const result = await listActiveItemUnitsForItem(client, "org-1", "item-1");
    expect(unitsEqItem).toHaveBeenCalledWith("inventory_item_id", "item-1");
    expect(unitsEqActive).toHaveBeenCalledWith("is_active", true);
    expect(result).toEqual({
      ok: true,
      baseUnitCode: "LB",
      baseUnitName: "Pound",
      units: [
        {
          unitId: "unit-box",
          unitCode: "BOX",
          unitName: "Box",
          conversionFactor: null,
          requiresActualMeasurement: true,
          isDefaultEntryUnit: true,
        },
        {
          unitId: "unit-case",
          unitCode: "CASE",
          unitName: "Case",
          conversionFactor: "10",
          requiresActualMeasurement: false,
          isDefaultEntryUnit: false,
        },
      ],
    });
  });

  it("throws on a Postgres error from the units query", async () => {
    const { client } = createFakeSupabase({
      item: { id: "item-1", units: { code: "LB", name: "Pound" } },
      unitsError: { message: "boom" },
    });
    await expect(listActiveItemUnitsForItem(client, "org-1", "item-1")).rejects.toThrow("boom");
  });
});
