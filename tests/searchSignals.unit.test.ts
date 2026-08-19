import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listInventoryItemSearchSignals } from "@/app/lib/kiosk/searchSignals";

// CI-safe: no network, no database -- fakes list_inventory_item_search_signals.

function createFakeSupabase(rows: Record<string, unknown>[] | null, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: rows, error });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("listInventoryItemSearchSignals", () => {
  it("calls the RPC scoped to the organization", async () => {
    const { client, rpc } = createFakeSupabase([]);
    await listInventoryItemSearchSignals(client, "org-1");
    expect(rpc).toHaveBeenCalledWith("list_inventory_item_search_signals", { p_organization_id: "org-1" });
  });

  it("groups vendor SKU and description rows by item id", async () => {
    const { client } = createFakeSupabase([
      { out_inventory_item_id: "item-1", out_vendor_sku: "SKU-1", out_normalized_description: null },
      { out_inventory_item_id: "item-1", out_vendor_sku: null, out_normalized_description: "half n half qt" },
      { out_inventory_item_id: "item-2", out_vendor_sku: "SKU-2", out_normalized_description: null },
    ]);
    const signals = await listInventoryItemSearchSignals(client, "org-1");
    expect(signals).toEqual({
      "item-1": { vendorSkus: ["SKU-1"], vendorDescriptions: ["half n half qt"] },
      "item-2": { vendorSkus: ["SKU-2"], vendorDescriptions: [] },
    });
  });

  it("returns an empty object when there are no confirmed mappings", async () => {
    const { client } = createFakeSupabase([]);
    expect(await listInventoryItemSearchSignals(client, "org-1")).toEqual({});
  });

  it("returns an empty object when data is null", async () => {
    const { client } = createFakeSupabase(null);
    expect(await listInventoryItemSearchSignals(client, "org-1")).toEqual({});
  });

  it("throws on a Postgres error", async () => {
    const { client } = createFakeSupabase(null, { message: "boom" });
    await expect(listInventoryItemSearchSignals(client, "org-1")).rejects.toThrow("boom");
  });
});
