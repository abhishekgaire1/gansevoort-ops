import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActiveInventoryItemsForOrganization } from "@/app/lib/kiosk/inventoryItems";

// CI-safe: no network, no database -- fakes the two-query Supabase chain
// (active items, then which of those items have an active self-referencing
// base-unit inventory_item_units row -- the "is this item withdrawable"
// catalog-level filter that keeps a misconfigured item off the employee
// withdrawal screen entirely, instead of surfacing a configuration error
// after it's been selected).

interface FakeSupabaseOptions {
  itemRows: Record<string, unknown>[] | null;
  itemsError?: unknown;
  entryUnitRows?: Record<string, unknown>[] | null;
  entryUnitsError?: unknown;
}

function createFakeSupabase({ itemRows, itemsError = null, entryUnitRows = [], entryUnitsError = null }: FakeSupabaseOptions) {
  const order = vi.fn().mockResolvedValue({ data: itemRows, error: itemsError });
  const itemsEqApprovalStatus = vi.fn().mockReturnValue({ order });
  const itemsEqStatus = vi.fn().mockReturnValue({ eq: itemsEqApprovalStatus });
  const itemsEqOrg = vi.fn().mockReturnValue({ eq: itemsEqStatus });
  const itemsSelect = vi.fn().mockReturnValue({ eq: itemsEqOrg });

  const entryUnitsEqActive = vi.fn().mockResolvedValue({ data: entryUnitRows, error: entryUnitsError });
  const entryUnitsIn = vi.fn().mockReturnValue({ eq: entryUnitsEqActive });
  const entryUnitsSelect = vi.fn().mockReturnValue({ in: entryUnitsIn });

  const from = vi.fn((table: string) => {
    if (table === "inventory_items") return { select: itemsSelect };
    if (table === "inventory_item_units") return { select: entryUnitsSelect };
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    itemsSelect,
    itemsEqOrg,
    itemsEqStatus,
    itemsEqApprovalStatus,
    order,
    entryUnitsSelect,
    entryUnitsIn,
    entryUnitsEqActive,
  };
}

describe("listActiveInventoryItemsForOrganization", () => {
  it("queries inventory_items scoped to organization_id, status='active', and approval_status='CONFIRMED', ordered by name", async () => {
    const { client, from, itemsSelect, itemsEqOrg, itemsEqStatus, itemsEqApprovalStatus, order } = createFakeSupabase({ itemRows: [] });
    await listActiveInventoryItemsForOrganization(client, "org-1");

    expect(from).toHaveBeenCalledWith("inventory_items");
    expect(itemsSelect).toHaveBeenCalledWith("id, name, category_id, base_unit_id, inventory_categories(name)");
    expect(itemsEqOrg).toHaveBeenCalledWith("organization_id", "org-1");
    expect(itemsEqStatus).toHaveBeenCalledWith("status", "active");
    expect(itemsEqApprovalStatus).toHaveBeenCalledWith("approval_status", "CONFIRMED");
    expect(order).toHaveBeenCalledWith("name");
  });

  it("never queries inventory_item_units when the org has no active items", async () => {
    const { client, from } = createFakeSupabase({ itemRows: [] });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
    expect(from).not.toHaveBeenCalledWith("inventory_item_units");
  });

  it("includes an item whose base unit has an active self-referencing inventory_item_units row", async () => {
    const { client } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Chicken Thigh", category_id: "cat-1", base_unit_id: "unit-lb", inventory_categories: { name: "Meat" } }],
      entryUnitRows: [{ inventory_item_id: "item-1", unit_id: "unit-lb" }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([{ id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" }]);
  });

  it("excludes an item whose only configured unit is a packaging unit (e.g. BOX), not its own base unit", async () => {
    // This is exactly the bug this filter fixes: an item seeded with only a
    // BOX entry (for a since-removed variable-weight package workflow) has
    // inventory_item_units rows, just never one matching its own
    // base_unit_id -- it must not appear in the employee withdrawal catalog.
    const { client } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Chicken Thigh", category_id: "cat-1", base_unit_id: "unit-lb", inventory_categories: { name: "Meat" } }],
      entryUnitRows: [{ inventory_item_id: "item-1", unit_id: "unit-box" }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
  });

  it("excludes an item with zero configured inventory_item_units rows", async () => {
    const { client } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Chicken Thigh", category_id: "cat-1", base_unit_id: "unit-lb", inventory_categories: { name: "Meat" } }],
      entryUnitRows: [],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([]);
  });

  it("filters each item independently in a mixed catalog", async () => {
    const { client } = createFakeSupabase({
      itemRows: [
        { id: "item-1", name: "Chicken Thigh", category_id: "cat-1", base_unit_id: "unit-lb", inventory_categories: { name: "Meat" } },
        { id: "item-2", name: "Eggs", category_id: "cat-2", base_unit_id: "unit-piece", inventory_categories: { name: "Dairy" } },
      ],
      entryUnitRows: [
        { inventory_item_id: "item-1", unit_id: "unit-box" }, // packaging only -- excluded
        { inventory_item_id: "item-2", unit_id: "unit-piece" }, // base unit -- included
      ],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items.map((i) => i.id)).toEqual(["item-2"]);
  });

  it("scopes the inventory_item_units lookup to the fetched items' ids and is_active=true", async () => {
    const { client, entryUnitsSelect, entryUnitsIn, entryUnitsEqActive } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Chicken Thigh", category_id: "cat-1", base_unit_id: "unit-lb", inventory_categories: { name: "Meat" } }],
      entryUnitRows: [{ inventory_item_id: "item-1", unit_id: "unit-lb" }],
    });
    await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(entryUnitsSelect).toHaveBeenCalledWith("inventory_item_id, unit_id");
    expect(entryUnitsIn).toHaveBeenCalledWith("inventory_item_id", ["item-1"]);
    expect(entryUnitsEqActive).toHaveBeenCalledWith("is_active", true);
  });

  it("maps a nested inventory_categories object to categoryName", async () => {
    const { client } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Chicken Thigh", category_id: "cat-1", base_unit_id: "unit-lb", inventory_categories: { name: "Meat" } }],
      entryUnitRows: [{ inventory_item_id: "item-1", unit_id: "unit-lb" }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([{ id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" }]);
  });

  it("maps a nested inventory_categories array (single-row embed) to categoryName", async () => {
    const { client } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Eggs", category_id: "cat-2", base_unit_id: "unit-piece", inventory_categories: [{ name: "Dairy" }] }],
      entryUnitRows: [{ inventory_item_id: "item-1", unit_id: "unit-piece" }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items[0].categoryName).toBe("Dairy");
  });

  it("falls back to an empty categoryName when the category embed is null", async () => {
    const { client } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Napkins", category_id: "cat-3", base_unit_id: "unit-piece", inventory_categories: null }],
      entryUnitRows: [{ inventory_item_id: "item-1", unit_id: "unit-piece" }],
    });
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items[0].categoryName).toBe("");
  });

  it("throws on a Postgres error from the items query", async () => {
    const { client } = createFakeSupabase({ itemRows: null, itemsError: { message: "boom" } });
    await expect(listActiveInventoryItemsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });

  it("throws on a Postgres error from the entry-units query", async () => {
    const { client } = createFakeSupabase({
      itemRows: [{ id: "item-1", name: "Chicken Thigh", category_id: "cat-1", base_unit_id: "unit-lb", inventory_categories: { name: "Meat" } }],
      entryUnitsError: { message: "boom" },
    });
    await expect(listActiveInventoryItemsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });
});
