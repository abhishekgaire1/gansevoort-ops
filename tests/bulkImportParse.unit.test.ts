import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseSpreadsheet, validateRows, type ParsedRow } from "@/app/lib/admin/bulkImportParse";

// CI-safe: no network, no database, no live Gemini call. Pure parsing/
// validation logic for the Admin Bulk Import preview (Part 16-19).

const CATEGORIES = [
  { id: "cat-dairy", name: "Dairy" },
  { id: "cat-meat", name: "Meat & Poultry" },
];
const UNITS = [
  { id: "unit-lb", code: "LB" },
  { id: "unit-gal", code: "GAL" },
];

function buildWorkbookBuffer(rows: Record<string, unknown>[]): ArrayBuffer {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const out = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return out as ArrayBuffer;
}

describe("parseSpreadsheet", () => {
  it("parses rows using the standard header names", () => {
    const buffer = buildWorkbookBuffer([
      { "Item Number": "ITEM-000010", "Canonical Name": "Heavy Cream 40% Quart", Category: "Dairy", "Base Unit": "LB", Status: "active" },
      { "Item Number": null, "Canonical Name": "Chicken Thigh Boneless Skinless", Category: "Meat & Poultry", "Base Unit": "LB", Status: null },
    ]);
    const rows = parseSpreadsheet(buffer);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ itemNumber: "ITEM-000010", name: "Heavy Cream 40% Quart", categoryName: "Dairy", baseUnitCode: "LB", status: "active" });
    expect(rows[1]).toMatchObject({ name: "Chicken Thigh Boneless Skinless", categoryName: "Meat & Poultry", baseUnitCode: "LB", itemNumber: null });
  });

  it("tolerates an alternate header naming convention (Name / Inventory Category / Unit)", () => {
    const buffer = buildWorkbookBuffer([{ Name: "Chicken Thigh Boneless Skinless", "Inventory Category": "Meat & Poultry", Unit: "LB" }]);
    const rows = parseSpreadsheet(buffer);
    expect(rows[0]).toMatchObject({ name: "Chicken Thigh Boneless Skinless", categoryName: "Meat & Poultry", baseUnitCode: "LB", itemNumber: null });
  });

  it("row indices account for the header row (1-indexed, starting at row 2)", () => {
    const buffer = buildWorkbookBuffer([{ Name: "A", Category: "Dairy", Unit: "LB" }, { Name: "B", Category: "Dairy", Unit: "LB" }]);
    const rows = parseSpreadsheet(buffer);
    expect(rows[0].rowIndex).toBe(2);
    expect(rows[1].rowIndex).toBe(3);
  });

  it("returns an empty array for an empty sheet", () => {
    const buffer = buildWorkbookBuffer([]);
    expect(parseSpreadsheet(buffer)).toEqual([]);
  });
});

describe("validateRows", () => {
  function row(overrides: Partial<ParsedRow>): ParsedRow {
    return { rowIndex: 2, itemNumber: null, name: "Test Item", categoryName: "Dairy", baseUnitCode: "LB", status: null, ...overrides };
  }

  it("marks a fully valid row as ready", () => {
    const [result] = validateRows([row({})], CATEGORIES, UNITS, new Set(), new Map());
    expect(result.severity).toBe("ready");
    expect(result.issues).toEqual([]);
    expect(result.categoryId).toBe("cat-dairy");
    expect(result.baseUnitId).toBe("unit-lb");
  });

  it("flags a missing name as invalid", () => {
    const [result] = validateRows([row({ name: null })], CATEGORIES, UNITS, new Set(), new Map());
    expect(result.severity).toBe("invalid");
    expect(result.issues).toContain("MISSING_NAME");
  });

  it("flags an unknown category and an unknown unit as invalid", () => {
    const [result] = validateRows([row({ categoryName: "Nonexistent", baseUnitCode: "XYZ" })], CATEGORIES, UNITS, new Set(), new Map());
    expect(result.severity).toBe("invalid");
    expect(result.issues).toContain("UNKNOWN_CATEGORY");
    expect(result.issues).toContain("UNKNOWN_UNIT");
  });

  it("flags duplicate names WITHIN the file, keeping the first occurrence clean", () => {
    const rows = [row({ rowIndex: 2, name: "Same Name" }), row({ rowIndex: 3, name: "same   name" })];
    const results = validateRows(rows, CATEGORIES, UNITS, new Set(), new Map());
    expect(results[0].issues).not.toContain("DUPLICATE_IN_FILE");
    expect(results[1].issues).toContain("DUPLICATE_IN_FILE");
  });

  it("flags duplicate item numbers WITHIN the file", () => {
    const rows = [row({ rowIndex: 2, itemNumber: "ITEM-000001", name: "A" }), row({ rowIndex: 3, itemNumber: "ITEM-000001", name: "B" })];
    const results = validateRows(rows, CATEGORIES, UNITS, new Set(), new Map());
    expect(results[1].issues).toContain("DUPLICATE_ITEM_NUMBER_IN_FILE");
  });

  it("flags an item number that already exists in the catalog", () => {
    const results = validateRows([row({ itemNumber: "ITEM-000005" })], CATEGORIES, UNITS, new Set(["ITEM-000005"]), new Map());
    expect(results[0].issues).toContain("EXISTING_ITEM_NUMBER");
    expect(results[0].severity).toBe("invalid");
  });

  it("marks a name that matches an existing catalog item as needs_review (possible duplicate), not invalid", () => {
    const existing = new Map([["TEST ITEM", { id: "existing-1", name: "Test Item", itemNumber: "ITEM-000099" }]]);
    const results = validateRows([row({ name: "Test Item" })], CATEGORIES, UNITS, new Set(), existing);
    expect(results[0].severity).toBe("needs_review");
    expect(results[0].issues).toEqual(["POSSIBLE_DUPLICATE"]);
  });

  it("an invalid row is never also marked needs_review -- invalid takes precedence", () => {
    const existing = new Map([["TEST ITEM", { id: "existing-1", name: "Test Item", itemNumber: "ITEM-000099" }]]);
    const results = validateRows([row({ name: "Test Item", categoryName: "Nonexistent" })], CATEGORIES, UNITS, new Set(), existing);
    expect(results[0].severity).toBe("invalid");
  });

  it("defaults status to active when not supplied, and passes through an explicit inactive", () => {
    const [ready] = validateRows([row({ status: null })], CATEGORIES, UNITS, new Set(), new Map());
    expect(ready.status).toBe("active");
    const [inactive] = validateRows([row({ status: "inactive" })], CATEGORIES, UNITS, new Set(), new Map());
    expect(inactive.status).toBe("inactive");
  });
});
