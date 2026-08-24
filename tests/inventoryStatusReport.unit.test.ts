import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryBalanceRow } from "@/app/lib/inventory/listInventoryBalances";

// CI-safe: no network, no database -- mocks listInventoryBalances directly.

const { listInventoryBalancesMock } = vi.hoisted(() => ({ listInventoryBalancesMock: vi.fn() }));
vi.mock("@/app/lib/inventory/listInventoryBalances", () => ({ listInventoryBalances: listInventoryBalancesMock }));

import { getInventoryStatusReport } from "@/app/lib/reports/inventoryStatusReport";

function balance(overrides: Partial<InventoryBalanceRow> = {}): InventoryBalanceRow {
  return {
    inventoryItemId: "item-1",
    itemName: "Heavy Cream",
    locationId: "loc-1",
    locationName: "Central Walk-In",
    baseUnitCode: "PIECE",
    balance: 100,
    fullReferenceQuantity: 100,
    referenceSource: "RESTOCK",
    referenceSetAt: "2026-08-01T00:00:00Z",
    includesLegacyEstimate: false,
    ...overrides,
  };
}

beforeEach(() => {
  listInventoryBalancesMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getInventoryStatusReport", () => {
  it("uses the SAME authoritative balance read model Current Inventory itself uses -- never a second definition of low stock", async () => {
    listInventoryBalancesMock.mockResolvedValue([
      balance({ inventoryItemId: "item-full", balance: 100, fullReferenceQuantity: 100 }), // FULL
      balance({ inventoryItemId: "item-healthy", balance: 80, fullReferenceQuantity: 100 }), // HEALTHY
      balance({ inventoryItemId: "item-low", balance: 20, fullReferenceQuantity: 100 }), // LOW
      balance({ inventoryItemId: "item-empty", balance: 0, fullReferenceQuantity: 100 }), // EMPTY
    ]);

    const report = await getInventoryStatusReport({} as never, "org-1");

    expect(report.lowStockCount).toBe(1);
    expect(report.outOfStockCount).toBe(1);
    expect(report.healthyCount).toBe(2); // FULL + HEALTHY
  });

  it("the rows list contains only Low/Out-of-Stock items -- Full/Healthy items never clutter the drill-down list", async () => {
    listInventoryBalancesMock.mockResolvedValue([
      balance({ inventoryItemId: "item-full", balance: 100, fullReferenceQuantity: 100 }),
      balance({ inventoryItemId: "item-low", balance: 20, fullReferenceQuantity: 100 }),
      balance({ inventoryItemId: "item-empty", balance: 0, fullReferenceQuantity: 100 }),
    ]);

    const report = await getInventoryStatusReport({} as never, "org-1");

    expect(report.rows.map((r) => r.inventoryItemId).sort()).toEqual(["item-empty", "item-low"]);
  });

  it("Out of Stock rows sort before Low Stock rows", async () => {
    listInventoryBalancesMock.mockResolvedValue([
      balance({ inventoryItemId: "item-low", balance: 20, fullReferenceQuantity: 100 }),
      balance({ inventoryItemId: "item-empty", balance: 0, fullReferenceQuantity: 100 }),
    ]);

    const report = await getInventoryStatusReport({} as never, "org-1");

    expect(report.rows[0].stockLevel).toBe("EMPTY");
    expect(report.rows[1].stockLevel).toBe("LOW");
  });

  it("filters by location", async () => {
    listInventoryBalancesMock.mockResolvedValue([
      balance({ inventoryItemId: "item-a", locationId: "loc-1", balance: 0, fullReferenceQuantity: 100 }),
      balance({ inventoryItemId: "item-b", locationId: "loc-2", balance: 0, fullReferenceQuantity: 100 }),
    ]);

    const report = await getInventoryStatusReport({} as never, "org-1", { locationId: "loc-1" });

    expect(report.rows.map((r) => r.inventoryItemId)).toEqual(["item-a"]);
  });

  it("filters by category, resolving item->category from inventory_items only when a category filter is actually applied", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [
        { id: "item-a", category_id: "cat-dairy" },
        { id: "item-b", category_id: "cat-beverages" },
      ],
    });
    const supabase = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) } as never;
    listInventoryBalancesMock.mockResolvedValue([
      balance({ inventoryItemId: "item-a", balance: 0, fullReferenceQuantity: 100 }),
      balance({ inventoryItemId: "item-b", balance: 0, fullReferenceQuantity: 100 }),
    ]);

    const report = await getInventoryStatusReport(supabase, "org-1", { categoryId: "cat-dairy" });

    expect(report.rows.map((r) => r.inventoryItemId)).toEqual(["item-a"]);
  });

  it("never queries inventory_items when no category filter is applied", async () => {
    const from = vi.fn();
    const supabase = { from } as never;
    listInventoryBalancesMock.mockResolvedValue([balance()]);

    await getInventoryStatusReport(supabase, "org-1");

    expect(from).not.toHaveBeenCalled();
  });

  it("an item with no reference quantity at all (never restocked) is never miscounted as low/out of stock", async () => {
    listInventoryBalancesMock.mockResolvedValue([balance({ balance: 0, fullReferenceQuantity: null })]);

    const report = await getInventoryStatusReport({} as never, "org-1");

    expect(report.rows).toEqual([]);
    expect(report.lowStockCount).toBe(0);
    expect(report.outOfStockCount).toBe(0);
  });
});
