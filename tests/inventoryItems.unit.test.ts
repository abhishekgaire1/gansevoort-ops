import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActiveInventoryItemsForOrganization } from "@/app/lib/kiosk/inventoryItems";

// CI-safe: no network, no database -- fakes the two-call chain: (1) the
// list_kiosk_available_inventory RPC (20260811100077 -- ONLY items with a
// positive available balance somewhere, per Milestone 2A.5's kiosk-grid
// correction), then (2) which of those items have an active
// self-referencing base-unit inventory_item_units row -- the "is this
// item withdrawable" catalog-level filter that keeps a misconfigured item
// off the employee withdrawal screen entirely, instead of surfacing a
// configuration error after it's been selected.

interface FakeSupabaseOptions {
  rpcRows: Record<string, unknown>[] | null;
  rpcError?: unknown;
  entryUnitRows?: Record<string, unknown>[] | null;
  entryUnitsError?: unknown;
}

function baseRpcRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    out_inventory_item_id: "item-1",
    out_item_name: "Chicken Thigh",
    out_category_id: "cat-1",
    out_category_name: "Meat",
    out_base_unit_code: "LB",
    out_total_available_quantity: 42,
    out_positive_location_count: 1,
    out_single_location_id: "loc-1",
    out_single_location_name: "Central Walk-In",
    out_single_location_full_reference_quantity: 50,
    out_single_location_reference_source: "RESTOCK",
    ...overrides,
  };
}

function createFakeSupabase({ rpcRows, rpcError = null, entryUnitRows = [], entryUnitsError = null }: FakeSupabaseOptions) {
  const rpc = vi.fn().mockResolvedValue({ data: rpcRows, error: rpcError });

  const entryUnitsEqActive = vi.fn().mockResolvedValue({ data: entryUnitRows, error: entryUnitsError });
  const entryUnitsIn = vi.fn().mockReturnValue({ eq: entryUnitsEqActive });
  const entryUnitsSelect = vi.fn().mockReturnValue({ in: entryUnitsIn });

  const from = vi.fn((table: string) => {
    if (table === "inventory_items") return { select: entryUnitsSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    client: { from, rpc } as unknown as SupabaseClient,
    from,
    rpc,
    entryUnitsSelect,
    entryUnitsIn,
    entryUnitsEqActive,
  };
}

describe("listActiveInventoryItemsForOrganization", () => {
  it("calls list_kiosk_available_inventory scoped to the organization", async () => {
    const { client, rpc } = createFakeSupabase({ rpcRows: [] });
    await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(rpc).toHaveBeenCalledWith("list_kiosk_available_inventory", { p_organization_id: "org-1" });
  });

  it("never queries inventory_item_units when nothing is currently available", async () => {
    const { client, from } = createFakeSupabase({ rpcRows: [] });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
    expect(from).not.toHaveBeenCalledWith("inventory_items");
  });

  it("includes an item whose base unit has an active self-referencing inventory_item_units row, mapping every availability field", async () => {
    const { client } = createFakeSupabase({
      rpcRows: [baseRpcRow()],
      entryUnitRows: [{ id: "item-1", base_unit_id: "unit-lb", inventory_item_units: [{ unit_id: "unit-lb" }] }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([
      {
        id: "item-1",
        name: "Chicken Thigh",
        categoryId: "cat-1",
        categoryName: "Meat",
        baseUnitCode: "LB",
        totalAvailableQuantity: 42,
        positiveLocationCount: 1,
        singleLocation: { locationId: "loc-1", locationName: "Central Walk-In", fullReferenceQuantity: 50, referenceSource: "RESTOCK" },
      },
    ]);
  });

  it("singleLocation is null when more than one location has positive stock", async () => {
    const { client } = createFakeSupabase({
      rpcRows: [
        baseRpcRow({
          out_positive_location_count: 2,
          out_single_location_id: null,
          out_single_location_name: null,
          out_single_location_full_reference_quantity: null,
          out_single_location_reference_source: null,
        }),
      ],
      entryUnitRows: [{ id: "item-1", base_unit_id: "unit-lb", inventory_item_units: [{ unit_id: "unit-lb" }] }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items[0].singleLocation).toBeNull();
    expect(items[0].positiveLocationCount).toBe(2);
  });

  it("excludes an item whose only configured unit is a packaging unit (e.g. BOX), not its own base unit -- even though it has positive available stock", async () => {
    // This is exactly the bug this filter fixes: an item seeded with only a
    // BOX entry (for a since-removed variable-weight package workflow) has
    // inventory_item_units rows, just never one matching its own
    // base_unit_id -- it must not appear in the employee withdrawal
    // catalog even if list_kiosk_available_inventory already found it has
    // real stock somewhere.
    const { client } = createFakeSupabase({
      rpcRows: [baseRpcRow()],
      entryUnitRows: [{ id: "item-1", base_unit_id: "unit-lb", inventory_item_units: [{ unit_id: "unit-box" }] }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
  });

  it("excludes an item with zero configured inventory_item_units rows", async () => {
    const { client } = createFakeSupabase({ rpcRows: [baseRpcRow()], entryUnitRows: [] });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
  });

  it("filters each item independently in a mixed catalog", async () => {
    const { client } = createFakeSupabase({
      rpcRows: [baseRpcRow({ out_inventory_item_id: "item-1" }), baseRpcRow({ out_inventory_item_id: "item-2", out_item_name: "Eggs" })],
      entryUnitRows: [
        { id: "item-1", base_unit_id: "unit-lb", inventory_item_units: [{ unit_id: "unit-box" }] }, // packaging only -- excluded
        { id: "item-2", base_unit_id: "unit-lb", inventory_item_units: [{ unit_id: "unit-lb" }] }, // base unit -- included
      ],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items.map((i) => i.id)).toEqual(["item-2"]);
  });

  it("scopes the inventory_item_units lookup to the RPC-returned items' ids and is_active=true", async () => {
    const { client, entryUnitsSelect, entryUnitsIn, entryUnitsEqActive } = createFakeSupabase({
      rpcRows: [baseRpcRow()],
      entryUnitRows: [{ id: "item-1", base_unit_id: "unit-lb", inventory_item_units: [{ unit_id: "unit-lb" }] }],
    });
    await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(entryUnitsSelect).toHaveBeenCalledWith("id, base_unit_id, inventory_item_units!inner(unit_id, is_active)");
    expect(entryUnitsIn).toHaveBeenCalledWith("id", ["item-1"]);
    expect(entryUnitsEqActive).toHaveBeenCalledWith("inventory_item_units.is_active", true);
  });

  it("throws on a Postgres error from list_kiosk_available_inventory", async () => {
    const { client } = createFakeSupabase({ rpcRows: null, rpcError: { message: "boom" } });
    await expect(listActiveInventoryItemsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });

  it("throws on a Postgres error from the entry-units query", async () => {
    const { client } = createFakeSupabase({ rpcRows: [baseRpcRow()], entryUnitsError: { message: "boom" } });
    await expect(listActiveInventoryItemsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });
});
