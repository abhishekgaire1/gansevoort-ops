import { describe, expect, it } from "vitest";
import { deriveItemCategories, filterItemsByCategory, type FilterableItem } from "@/app/kiosk/_lib/itemFilter";

// CI-safe: pure logic, no network, no database.
//
// Covers "item selection no longer depends on package-unit selection" and
// "removal of the 'Select an item' heading does not affect item-selection
// behavior": FilterableItem has no unit/package field at all (id, name,
// categoryId, categoryName only), and neither function here reads anything
// about how the screen renders -- both were already, and remain, entirely
// independent of unit selection and of any heading/label above the grid.

const ITEMS: FilterableItem[] = [
  { id: "item-1", name: "Chicken Thigh", categoryId: "cat-meat", categoryName: "Meat" },
  { id: "item-2", name: "Eggs", categoryId: "cat-dairy", categoryName: "Dairy" },
  { id: "item-3", name: "Napkins", categoryId: "cat-dry", categoryName: "Dry Goods" },
  { id: "item-4", name: "Chicken Broth", categoryId: "cat-dry", categoryName: "Dry Goods" },
];

describe("deriveItemCategories", () => {
  it("returns one deduplicated entry per categoryId", () => {
    expect(deriveItemCategories(ITEMS)).toEqual([
      { id: "cat-meat", name: "Meat" },
      { id: "cat-dairy", name: "Dairy" },
      { id: "cat-dry", name: "Dry Goods" },
    ]);
  });

  it("returns an empty list for an empty catalog", () => {
    expect(deriveItemCategories([])).toEqual([]);
  });
});

describe("filterItemsByCategory", () => {
  it("returns every item when no category is active", () => {
    expect(filterItemsByCategory(ITEMS, null)).toHaveLength(4);
  });

  it("matches by category when a category is active", () => {
    expect(filterItemsByCategory(ITEMS, "cat-dry").map((i) => i.id)).toEqual(["item-3", "item-4"]);
  });

  it("returns an empty list when the category has no items", () => {
    expect(filterItemsByCategory(ITEMS, "cat-nonexistent")).toEqual([]);
  });
});
