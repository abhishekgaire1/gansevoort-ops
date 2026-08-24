import { describe, expect, it } from "vitest";
import {
  buildCycleCountDisplayItems,
  groupDisplayItemsByCategory,
  filterSuggestedItems,
  countExplicitObservations,
  type InventoryBalanceRowLike,
  type SearchableItemLike,
  type CycleCountLineLike,
} from "@/app/manager/(app)/inventory/_lib/cycleCountDisplayItems";

// CI-safe: pure logic, no network, no database. Every input here is
// already-fetched data (mirrors what listInventoryBalancesForOrganization /
// listActiveInventoryItemsForCycleCountAction / listCycleCountLinesAction
// actually return) -- the module under test never issues a request itself,
// which is also the "no N+1" proof (test 11): there is nothing async in its
// signature to make a per-item call with.

const LOCATION_A = "loc-central-walk-in";
const LOCATION_B = "loc-freezer";

const ITEMS: SearchableItemLike[] = [
  { id: "item-cream", name: "Heavy Cream 40%", categoryName: "Dairy & Eggs", baseUnitCode: "LB" },
  { id: "item-sourcream", name: "Farmland Sour Cream 10lb", categoryName: "Dairy & Eggs", baseUnitCode: "LB" },
  { id: "item-oatmilk", name: "Oatly Oat Milk", categoryName: "Beverages", baseUnitCode: "PIECE" },
  { id: "item-mozzarella", name: "Mozzarella", categoryName: "Dairy & Eggs", baseUnitCode: "PIECE" },
];

describe("buildCycleCountDisplayItems", () => {
  it("1. returns positive-balance items at the selected location", () => {
    const balances: InventoryBalanceRowLike[] = [
      { inventoryItemId: "item-cream", locationId: LOCATION_A, balance: 8 },
      { inventoryItemId: "item-oatmilk", locationId: LOCATION_A, balance: 14 },
    ];
    const result = buildCycleCountDisplayItems(LOCATION_A, balances, ITEMS, []);
    expect(result.map((r) => r.inventoryItemId).sort()).toEqual(["item-cream", "item-oatmilk"]);
    expect(result.find((r) => r.inventoryItemId === "item-cream")).toMatchObject({
      lineId: null,
      expectedQuantity: "8",
      physicalCountQuantity: null,
    });
  });

  it("2. an item's balance at a SIBLING location is not auto-listed unless it also has stock here", () => {
    const balances: InventoryBalanceRowLike[] = [{ inventoryItemId: "item-cream", locationId: LOCATION_B, balance: 20 }];
    const result = buildCycleCountDisplayItems(LOCATION_A, balances, ITEMS, []);
    expect(result).toHaveLength(0);

    // Once it ALSO has stock at the selected location, it appears --
    // scoped strictly by locationId, not merely "has stock somewhere."
    const balancesBoth: InventoryBalanceRowLike[] = [
      { inventoryItemId: "item-cream", locationId: LOCATION_B, balance: 20 },
      { inventoryItemId: "item-cream", locationId: LOCATION_A, balance: 3 },
    ];
    const resultBoth = buildCycleCountDisplayItems(LOCATION_A, balancesBoth, ITEMS, []);
    expect(resultBoth).toHaveLength(1);
    expect(resultBoth[0].expectedQuantity).toBe("3");
  });

  it("3. a zero-balance item is NOT auto-listed", () => {
    const balances: InventoryBalanceRowLike[] = [{ inventoryItemId: "item-mozzarella", locationId: LOCATION_A, balance: 0 }];
    expect(buildCycleCountDisplayItems(LOCATION_A, balances, ITEMS, [])).toHaveLength(0);
  });

  it("5-6. merely being displayed never marks an item counted -- blank means no observation", () => {
    const balances: InventoryBalanceRowLike[] = [{ inventoryItemId: "item-cream", locationId: LOCATION_A, balance: 8 }];
    const result = buildCycleCountDisplayItems(LOCATION_A, balances, ITEMS, []);
    expect(result[0].lineId).toBeNull(); // no cycle_count_line exists for it
    expect(result[0].physicalCountQuantity).toBeNull(); // blank, not zero
  });

  it("7. an explicit 0 observation (a real line) is preserved as a genuine zero, never re-derived", () => {
    const lines: CycleCountLineLike[] = [
      {
        id: "line-1",
        inventoryItemId: "item-mozzarella",
        itemName: "Mozzarella",
        categoryName: "Dairy & Eggs",
        baseUnitCode: "PIECE",
        expectedQuantityAtSnapshot: "0",
        physicalCountQuantity: "0",
      },
    ];
    const result = buildCycleCountDisplayItems(LOCATION_A, [], ITEMS, lines);
    expect(result).toHaveLength(1);
    expect(result[0].lineId).toBe("line-1");
    expect(result[0].physicalCountQuantity).toBe("0");
  });

  it("9. resuming preserves existing observations and their ORIGINAL frozen snapshot, not a live re-read", () => {
    // A previous session counted Heavy Cream at 9 when the snapshot was 12
    // -- current balance has since drifted to 20 (e.g. a receipt came in).
    // The displayed expected quantity must stay the FROZEN 12, never 20.
    const balances: InventoryBalanceRowLike[] = [{ inventoryItemId: "item-cream", locationId: LOCATION_A, balance: 20 }];
    const lines: CycleCountLineLike[] = [
      {
        id: "line-cream",
        inventoryItemId: "item-cream",
        itemName: "Heavy Cream 40%",
        categoryName: "Dairy & Eggs",
        baseUnitCode: "LB",
        expectedQuantityAtSnapshot: "12",
        physicalCountQuantity: "9",
      },
    ];
    const result = buildCycleCountDisplayItems(LOCATION_A, balances, ITEMS, lines);
    expect(result).toHaveLength(1); // no duplicate row for the same item
    expect(result[0]).toMatchObject({ lineId: "line-cream", expectedQuantity: "12", physicalCountQuantity: "9" });
  });

  it("10. no duplicate row when an item is both a positive-balance row AND already has a line", () => {
    const balances: InventoryBalanceRowLike[] = [{ inventoryItemId: "item-oatmilk", locationId: LOCATION_A, balance: 14 }];
    const lines: CycleCountLineLike[] = [
      {
        id: "line-oatmilk",
        inventoryItemId: "item-oatmilk",
        itemName: "Oatly Oat Milk",
        categoryName: "Beverages",
        baseUnitCode: "PIECE",
        expectedQuantityAtSnapshot: "14",
        physicalCountQuantity: null,
      },
    ];
    const result = buildCycleCountDisplayItems(LOCATION_A, balances, ITEMS, lines);
    expect(result).toHaveLength(1);
    expect(result[0].lineId).toBe("line-oatmilk"); // the line wins, not the virtual balance row
  });

  it("sorts by category then item name, deterministically", () => {
    const balances: InventoryBalanceRowLike[] = [
      { inventoryItemId: "item-cream", locationId: LOCATION_A, balance: 1 },
      { inventoryItemId: "item-sourcream", locationId: LOCATION_A, balance: 1 },
      { inventoryItemId: "item-oatmilk", locationId: LOCATION_A, balance: 1 },
    ];
    const result = buildCycleCountDisplayItems(LOCATION_A, balances, ITEMS, []);
    expect(result.map((r) => r.itemName)).toEqual(["Oatly Oat Milk", "Farmland Sour Cream 10lb", "Heavy Cream 40%"]);
  });

  it("11. is a pure synchronous function -- no request per item is even possible", () => {
    expect(buildCycleCountDisplayItems.constructor.name).not.toBe("AsyncFunction");
  });
});

describe("groupDisplayItemsByCategory", () => {
  it("groups adjacent same-category items without re-sorting", () => {
    const items = buildCycleCountDisplayItems(
      LOCATION_A,
      [
        { inventoryItemId: "item-cream", locationId: LOCATION_A, balance: 1 },
        { inventoryItemId: "item-oatmilk", locationId: LOCATION_A, balance: 1 },
        { inventoryItemId: "item-sourcream", locationId: LOCATION_A, balance: 1 },
      ],
      ITEMS,
      []
    );
    const groups = groupDisplayItemsByCategory(items);
    expect(groups.map((g) => g.categoryName)).toEqual(["Beverages", "Dairy & Eggs"]);
    expect(groups[1].items.map((i) => i.itemName)).toEqual(["Farmland Sour Cream 10lb", "Heavy Cream 40%"]);
  });
});

describe("filterSuggestedItems -- search for a zero-stock item", () => {
  it("4. a zero-stock item remains discoverable through search", () => {
    const displayedItemIds = new Set<string>(); // nothing auto-listed (all zero stock)
    const results = filterSuggestedItems(ITEMS, displayedItemIds, "mozzarella");
    expect(results.map((i) => i.id)).toEqual(["item-mozzarella"]);
  });

  it("excludes anything already displayed, whether a real line or a live positive-balance row", () => {
    const displayedItemIds = new Set(["item-cream", "item-oatmilk"]);
    const results = filterSuggestedItems(ITEMS, displayedItemIds, "");
    expect(results.map((i) => i.id).sort()).toEqual(["item-mozzarella", "item-sourcream"]);
  });

  it("matches case-insensitively by substring", () => {
    const results = filterSuggestedItems(ITEMS, new Set(), "OAT");
    expect(results.map((i) => i.id)).toEqual(["item-oatmilk"]);
  });
});

describe("countExplicitObservations", () => {
  it("8. counts only rows with an explicit physical observation, never virtual (blank) rows", () => {
    const items = buildCycleCountDisplayItems(
      LOCATION_A,
      [
        { inventoryItemId: "item-cream", locationId: LOCATION_A, balance: 8 }, // virtual, blank
        { inventoryItemId: "item-oatmilk", locationId: LOCATION_A, balance: 14 }, // virtual, blank
      ],
      ITEMS,
      [
        {
          id: "line-sourcream",
          inventoryItemId: "item-sourcream",
          itemName: "Farmland Sour Cream 10lb",
          categoryName: "Dairy & Eggs",
          baseUnitCode: "LB",
          expectedQuantityAtSnapshot: "12",
          physicalCountQuantity: "9", // explicitly counted
        },
        {
          id: "line-mozzarella",
          inventoryItemId: "item-mozzarella",
          itemName: "Mozzarella",
          categoryName: "Dairy & Eggs",
          baseUnitCode: "PIECE",
          expectedQuantityAtSnapshot: "0",
          physicalCountQuantity: null, // added via search, but never actually counted
        },
      ]
    );
    expect(items).toHaveLength(4); // all four items are displayed
    expect(countExplicitObservations(items)).toBe(1); // only the one explicit observation
  });
});
