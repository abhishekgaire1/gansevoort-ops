import { describe, expect, it } from "vitest";
import { normalizeSearchText, rankSearchResults, tokenize, type SearchCandidateItem } from "@/app/kiosk/_lib/search";

// CI-safe: pure logic, no network, no database.

describe("normalizeSearchText", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeSearchText("  Heavy   Cream  ")).toBe("heavy cream");
  });

  it("treats & as and", () => {
    expect(normalizeSearchText("Half & Half")).toBe("half and half");
  });

  it("is punctuation-insensitive", () => {
    expect(normalizeSearchText("Monin, Dark-Chocolate!")).toBe("monin dark chocolate");
  });
});

describe("tokenize", () => {
  it("splits normalized text on spaces", () => {
    expect(tokenize("half and half")).toEqual(["half", "and", "half"]);
  });

  it("returns an empty array for empty text", () => {
    expect(tokenize("")).toEqual([]);
  });
});

function item(overrides: Partial<SearchCandidateItem> & { id: string; name: string }): SearchCandidateItem {
  return { categoryName: "", vendorSkus: [], vendorDescriptions: [], ...overrides };
}

describe("rankSearchResults", () => {
  const halfAndHalf = item({ id: "half-half", name: "Farmland Half & Half Quart", categoryName: "Dairy" });
  const oatMilk = item({ id: "oat-milk", name: "Oatly Oat Milk Quart", categoryName: "Dairy" });
  const chocolateSauce = item({ id: "choc-sauce", name: "Monin Dark Chocolate Sauce", categoryName: "Syrups" });
  const heavyCream = item({ id: "heavy-cream", name: "Heavy Cream 40% Quart", categoryName: "Dairy" });
  const creamCheese = item({ id: "cream-cheese", name: "Cream Cheese", categoryName: "Dairy" });

  it("matches half half / half & half / half and half to Farmland Half & Half Quart", () => {
    for (const query of ["half half", "half & half", "half and half"]) {
      expect(rankSearchResults([halfAndHalf], query).map((i) => i.id)).toEqual(["half-half"]);
    }
  });

  it("matches oatmilk / oat milk / oatly to Oatly Oat Milk Quart", () => {
    for (const query of ["oatmilk", "oat milk", "oatly"]) {
      expect(rankSearchResults([oatMilk], query).map((i) => i.id)).toEqual(["oat-milk"]);
    }
  });

  it("matches choclate / dark chocolate / monin chocolate to Monin Dark Chocolate Sauce", () => {
    for (const query of ["choclate", "dark chocolate", "monin chocolate"]) {
      expect(rankSearchResults([chocolateSauce], query).map((i) => i.id)).toEqual(["choc-sauce"]);
    }
  });

  it("tolerates other reasonable typos (almnd, hevy)", () => {
    const almondMilk = item({ id: "almond-milk", name: "Almond Milk Quart", categoryName: "Dairy" });
    const heavyItem = item({ id: "heavy", name: "Heavy Cream", categoryName: "Dairy" });
    expect(rankSearchResults([almondMilk], "almnd").map((i) => i.id)).toEqual(["almond-milk"]);
    expect(rankSearchResults([heavyItem], "hevy").map((i) => i.id)).toEqual(["heavy"]);
  });

  it("ranks a canonical-prefix match above a fuzzy/unrelated one: heavy cream beats cream cheese", () => {
    const results = rankSearchResults([creamCheese, heavyCream], "heavy cream");
    expect(results.map((i) => i.id)).toEqual(["heavy-cream"]);
  });

  it("ranks exact canonical name above a prefix match", () => {
    const exact = item({ id: "exact", name: "Eggs" });
    const prefixOnly = item({ id: "prefix", name: "Eggs Large" });
    const results = rankSearchResults([prefixOnly, exact], "eggs");
    expect(results.map((i) => i.id)).toEqual(["exact", "prefix"]);
  });

  it("matches a confirmed vendor description when the canonical name doesn't match", () => {
    const target = item({
      id: "target",
      name: "Farmland Half & Half Quart",
      vendorDescriptions: ["half n half qt"],
    });
    expect(rankSearchResults([target], "half n half").map((i) => i.id)).toEqual(["target"]);
  });

  it("matches an exact vendor SKU (punctuation-insensitively, since both sides are normalized)", () => {
    const target = item({ id: "target", name: "Some Canonical Name", vendorSkus: ["SKU-4471"] });
    expect(rankSearchResults([target], "sku-4471").map((i) => i.id)).toEqual(["target"]);
    expect(rankSearchResults([target], "sku 4471").map((i) => i.id)).toEqual(["target"]);
    expect(rankSearchResults([target], "sku-9999")).toEqual([]);
  });

  it("matches by category as a last resort", () => {
    const target = item({ id: "target", name: "Something Unrelated", categoryName: "Dry Goods" });
    expect(rankSearchResults([target], "dry goods").map((i) => i.id)).toEqual(["target"]);
  });

  it("excludes items that match nothing", () => {
    expect(rankSearchResults([halfAndHalf, oatMilk], "burrata")).toEqual([]);
  });

  it("returns an empty list for a blank query", () => {
    expect(rankSearchResults([halfAndHalf], "   ")).toEqual([]);
  });
});
