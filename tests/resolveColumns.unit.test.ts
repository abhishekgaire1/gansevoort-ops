import { describe, expect, it } from "vitest";
import { resolveColumns, unsupportedColumnKeys, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition } from "@/app/lib/reports/registry/types";

// CI-safe: pure logic, no network/DB. Covers Section 20 items 6-9
// (unsupported column rejected, required columns preserved, default
// columns applied, maximum columns enforced).

const COLUMNS: ReportColumnDefinition[] = [
  { key: "a", header: "A", format: "text" },
  { key: "b", header: "B", format: "text" },
  { key: "c", header: "C", format: "text" },
  { key: "d", header: "D", format: "text" },
];

describe("resolveColumns", () => {
  it("uses the report's default columns when none are requested", () => {
    const result = resolveColumns(COLUMNS, undefined, ["a", "b"], [], 10);
    expect(result.map((c) => c.key)).toEqual(["a", "b"]);
  });

  it("silently drops an unsupported (not-allowlisted) requested column", () => {
    const result = resolveColumns(COLUMNS, ["a", "not-a-real-column"], ["a", "b"], [], 10);
    expect(result.map((c) => c.key)).toEqual(["a"]);
  });

  it("always preserves required columns even when not requested", () => {
    const result = resolveColumns(COLUMNS, ["b"], ["a"], ["c"], 10);
    expect(result.map((c) => c.key)).toEqual(expect.arrayContaining(["c", "b"]));
  });

  it("enforces the maximum column count", () => {
    const result = resolveColumns(COLUMNS, ["a", "b", "c", "d"], ["a"], [], 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("preserves the report's own declared column order regardless of request order", () => {
    const result = resolveColumns(COLUMNS, ["d", "a", "c"], ["a"], [], 10);
    expect(result.map((c) => c.key)).toEqual(["a", "c", "d"]);
  });
});

describe("unsupportedColumnKeys", () => {
  it("returns an empty array when nothing was requested", () => {
    expect(unsupportedColumnKeys(COLUMNS, undefined)).toEqual([]);
  });
  it("lists exactly the requested keys not present in the allowlist", () => {
    expect(unsupportedColumnKeys(COLUMNS, ["a", "ghost", "b", "phantom"])).toEqual(["ghost", "phantom"]);
  });
  it("returns an empty array when everything requested is valid", () => {
    expect(unsupportedColumnKeys(COLUMNS, ["a", "b"])).toEqual([]);
  });
});

describe("projectRow", () => {
  it("keeps only the resolved columns' keys, discarding everything else", () => {
    const row = { a: 1, b: "x", c: "hidden", secret: "never shown" };
    const projected = projectRow(row, [COLUMNS[0], COLUMNS[1]]);
    expect(projected).toEqual({ a: 1, b: "x" });
  });
  it("fills a missing field with null rather than throwing", () => {
    const projected = projectRow({ a: 1 }, [COLUMNS[0], COLUMNS[1]]);
    expect(projected).toEqual({ a: 1, b: null });
  });
});
