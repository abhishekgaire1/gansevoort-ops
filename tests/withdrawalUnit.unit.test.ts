import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getWithdrawalUnitForItem } from "@/app/lib/kiosk/withdrawalUnit";

// CI-safe: no network, no database -- fakes the two-query Supabase chain
// (item + base-unit lookup, then confirming an active inventory_item_units
// row exists for that same base unit -- the "is this item withdrawable"
// data-completeness check).

interface FakeSupabaseOptions {
  item: Record<string, unknown> | null;
  itemError?: unknown;
  entryUnitRow?: Record<string, unknown> | null;
  entryUnitError?: unknown;
}

function createFakeSupabase({ item, itemError = null, entryUnitRow = null, entryUnitError = null }: FakeSupabaseOptions) {
  const itemMaybeSingle = vi.fn().mockResolvedValue({ data: item, error: itemError });
  const itemEqOrg = vi.fn().mockReturnValue({ maybeSingle: itemMaybeSingle });
  const itemEqId = vi.fn().mockReturnValue({ eq: itemEqOrg });
  const itemSelect = vi.fn().mockReturnValue({ eq: itemEqId });

  const entryUnitMaybeSingle = vi.fn().mockResolvedValue({ data: entryUnitRow, error: entryUnitError });
  const entryUnitEqActive = vi.fn().mockReturnValue({ maybeSingle: entryUnitMaybeSingle });
  const entryUnitEqUnit = vi.fn().mockReturnValue({ eq: entryUnitEqActive });
  const entryUnitEqItem = vi.fn().mockReturnValue({ eq: entryUnitEqUnit });
  const entryUnitSelect = vi.fn().mockReturnValue({ eq: entryUnitEqItem });

  const from = vi.fn((table: string) => {
    if (table === "inventory_items") return { select: itemSelect };
    if (table === "inventory_item_units") return { select: entryUnitSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    itemEqId,
    itemEqOrg,
    entryUnitSelect,
    entryUnitEqItem,
    entryUnitEqUnit,
    entryUnitEqActive,
  };
}

describe("getWithdrawalUnitForItem", () => {
  it("returns item_not_found and never queries inventory_item_units when the item doesn't resolve in the caller's org", async () => {
    const { client, from } = createFakeSupabase({ item: null });
    const result = await getWithdrawalUnitForItem(client, "org-1", "item-1");
    expect(result).toEqual({ ok: false, reason: "item_not_found" });
    expect(from).not.toHaveBeenCalledWith("inventory_item_units");
  });

  it("scopes the item lookup by both id and organization_id", async () => {
    const { client, itemEqId, itemEqOrg } = createFakeSupabase({
      item: { id: "item-1", base_unit_id: "unit-lb", units: { code: "LB", name: "Pound", unit_type: "WEIGHT" } },
      entryUnitRow: { id: "iiu-1" },
    });
    await getWithdrawalUnitForItem(client, "org-1", "item-1");
    expect(itemEqId).toHaveBeenCalledWith("id", "item-1");
    expect(itemEqOrg).toHaveBeenCalledWith("organization_id", "org-1");
  });

  it("returns unit_not_configured when the item's base unit has no active self-referencing inventory_item_units row", async () => {
    const { client, entryUnitEqUnit } = createFakeSupabase({
      item: { id: "item-1", base_unit_id: "unit-lb", units: { code: "LB", name: "Pound", unit_type: "WEIGHT" } },
      entryUnitRow: null,
    });
    const result = await getWithdrawalUnitForItem(client, "org-1", "item-1");
    expect(result).toEqual({ ok: false, reason: "unit_not_configured" });
    expect(entryUnitEqUnit).toHaveBeenCalledWith("unit_id", "unit-lb");
  });

  it("returns the item's base unit id/code/name/type once its self-referencing entry unit is confirmed active", async () => {
    const { client, entryUnitEqItem, entryUnitEqActive } = createFakeSupabase({
      item: { id: "item-1", base_unit_id: "unit-lb", units: { code: "LB", name: "Pound", unit_type: "WEIGHT" } },
      entryUnitRow: { id: "iiu-1" },
    });

    const result = await getWithdrawalUnitForItem(client, "org-1", "item-1");
    expect(entryUnitEqItem).toHaveBeenCalledWith("inventory_item_id", "item-1");
    expect(entryUnitEqActive).toHaveBeenCalledWith("is_active", true);
    expect(result).toEqual({
      ok: true,
      unit: {
        baseUnitId: "unit-lb",
        baseUnitCode: "LB",
        baseUnitName: "Pound",
        baseUnitType: "WEIGHT",
      },
    });
  });

  it("only ever queries for the item's own base_unit_id, by bare existence -- never returns or leaks any other configured unit (e.g. BOX/CASE)", async () => {
    // Even though the item may have other, packaging-style
    // inventory_item_units rows (BOX, CASE, ...), this function has no
    // code path that can surface them: it selects a bare "id" existence
    // check scoped to unit_id = the item's own base_unit_id, never a list
    // of the item's configured units.
    const { client, entryUnitSelect, entryUnitEqUnit } = createFakeSupabase({
      item: { id: "item-1", base_unit_id: "unit-lb", units: { code: "LB", name: "Pound", unit_type: "WEIGHT" } },
      entryUnitRow: { id: "iiu-1" },
    });

    const result = await getWithdrawalUnitForItem(client, "org-1", "item-1");
    expect(entryUnitSelect).toHaveBeenCalledWith("id");
    expect(entryUnitEqUnit).toHaveBeenCalledWith("unit_id", "unit-lb");
    expect(entryUnitEqUnit).not.toHaveBeenCalledWith("unit_id", "unit-box");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.unit)).toEqual(["baseUnitId", "baseUnitCode", "baseUnitName", "baseUnitType"]);
    }
  });

  it("throws on a Postgres error from the entry-unit query", async () => {
    const { client } = createFakeSupabase({
      item: { id: "item-1", base_unit_id: "unit-lb", units: { code: "LB", name: "Pound", unit_type: "WEIGHT" } },
      entryUnitError: { message: "boom" },
    });
    await expect(getWithdrawalUnitForItem(client, "org-1", "item-1")).rejects.toThrow("boom");
  });
});
