import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActiveInventoryItemsForOrganization } from "@/app/lib/kiosk/inventoryItems";

// CI-safe: no network, no database -- fakes the two-call chain: (1) the
// list_kiosk_available_inventory RPC (20260811100077 -- ONLY items with a
// positive available balance somewhere, per Milestone 2A.5's kiosk-grid
// correction), then (2) which of those items have an active PRIMARY kiosk
// usage unit (purchase-versus-usage unit model, 20260811100119/100120) --
// the "is this item withdrawable" catalog-level filter that keeps a
// misconfigured item off the employee withdrawal screen entirely, instead
// of surfacing a configuration error after it's been selected. Deliberately
// checks the usage-unit relationship itself, never `unit_id = base_unit_id`
// -- a confirmed primary usage unit need not be the item's own base unit.

interface FakeSupabaseOptions {
  rpcRows: Record<string, unknown>[] | null;
  rpcError?: unknown;
  usageUnitRows?: Record<string, unknown>[] | null;
  usageUnitsError?: unknown;
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

function createFakeSupabase({ rpcRows, rpcError = null, usageUnitRows = [], usageUnitsError = null }: FakeSupabaseOptions) {
  const rpc = vi.fn().mockResolvedValue({ data: rpcRows, error: rpcError });

  const usageUnitsEqIiuActive = vi.fn().mockResolvedValue({ data: usageUnitRows, error: usageUnitsError });
  const usageUnitsEqActive = vi.fn().mockReturnValue({ eq: usageUnitsEqIiuActive });
  const usageUnitsEqSlot = vi.fn().mockReturnValue({ eq: usageUnitsEqActive });
  const usageUnitsIn = vi.fn().mockReturnValue({ eq: usageUnitsEqSlot });
  const usageUnitsSelect = vi.fn().mockReturnValue({ in: usageUnitsIn });

  const from = vi.fn((table: string) => {
    if (table === "inventory_item_usage_units") return { select: usageUnitsSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    client: { from, rpc } as unknown as SupabaseClient,
    from,
    rpc,
    usageUnitsSelect,
    usageUnitsIn,
    usageUnitsEqSlot,
    usageUnitsEqActive,
    usageUnitsEqIiuActive,
  };
}

describe("listActiveInventoryItemsForOrganization", () => {
  it("calls list_kiosk_available_inventory scoped to the organization", async () => {
    const { client, rpc } = createFakeSupabase({ rpcRows: [] });
    await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(rpc).toHaveBeenCalledWith("list_kiosk_available_inventory", { p_organization_id: "org-1" });
  });

  it("never queries inventory_item_usage_units when nothing is currently available", async () => {
    const { client, from } = createFakeSupabase({ rpcRows: [] });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
    expect(from).not.toHaveBeenCalledWith("inventory_item_usage_units");
  });

  it("includes an item with an active primary kiosk usage unit, mapping every availability field", async () => {
    const { client } = createFakeSupabase({
      rpcRows: [baseRpcRow()],
      usageUnitRows: [{ inventory_item_id: "item-1" }],
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
      usageUnitRows: [{ inventory_item_id: "item-1" }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items[0].singleLocation).toBeNull();
    expect(items[0].positiveLocationCount).toBe(2);
  });

  it("excludes an item with no active primary usage unit -- even though it has positive available stock", async () => {
    // This is exactly the bug this filter fixes: an item with only a
    // vendor purchase-only unit configured (or a since-deactivated
    // primary slot) must not appear in the employee withdrawal catalog
    // even if list_kiosk_available_inventory already found it has real
    // stock somewhere.
    const { client } = createFakeSupabase({ rpcRows: [baseRpcRow()], usageUnitRows: [] });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
  });

  it("filters each item independently in a mixed catalog", async () => {
    const { client } = createFakeSupabase({
      rpcRows: [baseRpcRow({ out_inventory_item_id: "item-1" }), baseRpcRow({ out_inventory_item_id: "item-2", out_item_name: "Eggs" })],
      // item-1 has no active primary usage unit (excluded); item-2 does.
      usageUnitRows: [{ inventory_item_id: "item-2" }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items.map((i) => i.id)).toEqual(["item-2"]);
  });

  it("scopes the primary-usage-unit lookup to the RPC-returned items' ids, usage_slot 1, and both is_active flags", async () => {
    const { client, usageUnitsSelect, usageUnitsIn, usageUnitsEqSlot, usageUnitsEqActive, usageUnitsEqIiuActive } = createFakeSupabase({
      rpcRows: [baseRpcRow()],
      usageUnitRows: [{ inventory_item_id: "item-1" }],
    });
    await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(usageUnitsSelect).toHaveBeenCalledWith("inventory_item_id, inventory_item_units!inner(is_active)");
    expect(usageUnitsIn).toHaveBeenCalledWith("inventory_item_id", ["item-1"]);
    expect(usageUnitsEqSlot).toHaveBeenCalledWith("usage_slot", 1);
    expect(usageUnitsEqActive).toHaveBeenCalledWith("is_active", true);
    expect(usageUnitsEqIiuActive).toHaveBeenCalledWith("inventory_item_units.is_active", true);
  });

  it("throws on a Postgres error from list_kiosk_available_inventory", async () => {
    const { client } = createFakeSupabase({ rpcRows: null, rpcError: { message: "boom" } });
    await expect(listActiveInventoryItemsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });

  it("throws on a Postgres error from the primary-usage-unit query", async () => {
    const { client } = createFakeSupabase({ rpcRows: [baseRpcRow()], usageUnitsError: { message: "boom" } });
    await expect(listActiveInventoryItemsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });
});
