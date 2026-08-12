import { describe, expect, it } from "vitest";
import { deriveItemCategories, filterItems, type FilterableItem } from "@/app/kiosk/_lib/itemFilter";

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

describe("filterItems", () => {
  it("returns every item for an empty query and no category filter", () => {
    expect(filterItems(ITEMS, "", null)).toHaveLength(4);
  });

  it("matches by case-insensitive substring on name", () => {
    expect(filterItems(ITEMS, "chicken", null).map((i) => i.id)).toEqual(["item-1", "item-4"]);
    expect(filterItems(ITEMS, "CHICKEN", null).map((i) => i.id)).toEqual(["item-1", "item-4"]);
  });

  it("trims surrounding whitespace from the query", () => {
    expect(filterItems(ITEMS, "  eggs  ", null).map((i) => i.id)).toEqual(["item-2"]);
  });

  it("matches by category when a category is active", () => {
    expect(filterItems(ITEMS, "", "cat-dry").map((i) => i.id)).toEqual(["item-3", "item-4"]);
  });

  it("combines query and category with AND", () => {
    expect(filterItems(ITEMS, "chicken", "cat-dry").map((i) => i.id)).toEqual(["item-4"]);
    expect(filterItems(ITEMS, "chicken", "cat-dairy")).toEqual([]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterItems(ITEMS, "nonexistent item", null)).toEqual([]);
  });
});
