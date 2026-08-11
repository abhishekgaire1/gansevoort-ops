import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActiveInventoryItemsForOrganization } from "@/app/lib/kiosk/inventoryItems";

// CI-safe: no network, no database -- fakes the Supabase query builder chain.

function createFakeSupabase(rows: Record<string, unknown>[] | null, error: unknown = null) {
  const order = vi.fn().mockResolvedValue({ data: rows, error });
  const eqStatus = vi.fn().mockReturnValue({ order });
  const eqOrg = vi.fn().mockReturnValue({ eq: eqStatus });
  const select = vi.fn().mockReturnValue({ eq: eqOrg });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as unknown as SupabaseClient, from, select, eqOrg, eqStatus, order };
}

describe("listActiveInventoryItemsForOrganization", () => {
  it("queries inventory_items scoped to organization_id and status='active', ordered by name", async () => {
    const { client, from, select, eqOrg, eqStatus, order } = createFakeSupabase([]);
    await listActiveInventoryItemsForOrganization(client, "org-1");

    expect(from).toHaveBeenCalledWith("inventory_items");
    expect(select).toHaveBeenCalledWith("id, name, category_id, inventory_categories(name)");
    expect(eqOrg).toHaveBeenCalledWith("organization_id", "org-1");
    expect(eqStatus).toHaveBeenCalledWith("status", "active");
    expect(order).toHaveBeenCalledWith("name");
  });

  it("maps a nested inventory_categories object to categoryName", async () => {
    const { client } = createFakeSupabase([
      { id: "item-1", name: "Chicken Thigh", category_id: "cat-1", inventory_categories: { name: "Meat" } },
    ]);
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items).toEqual([{ id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" }]);
  });

  it("maps a nested inventory_categories array (single-row embed) to categoryName", async () => {
    const { client } = createFakeSupabase([
      { id: "item-1", name: "Eggs", category_id: "cat-2", inventory_categories: [{ name: "Dairy" }] },
    ]);
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items[0].categoryName).toBe("Dairy");
  });

  it("falls back to an empty categoryName when the category embed is null", async () => {
    const { client } = createFakeSupabase([
      { id: "item-1", name: "Napkins", category_id: "cat-3", inventory_categories: null },
    ]);
    const items = await listActiveInventoryItemsForOrganization(client, "org-1");
    expect(items[0].categoryName).toBe("");
  });

  it("throws on a Postgres error", async () => {
    const { client } = createFakeSupabase(null, { message: "boom" });
    await expect(listActiveInventoryItemsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });
});
