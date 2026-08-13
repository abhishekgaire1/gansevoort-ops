import { describe, expect, it } from "vitest";
import { normalizeVendorName } from "@/app/lib/vendors/normalizeVendorName";

describe("normalizeVendorName", () => {
  it("trims, collapses internal whitespace, and uppercases", () => {
    expect(normalizeVendorName("  Baldor   Foods  ")).toBe("BALDOR FOODS");
  });

  it("distinct vendor names normalize to distinct values", () => {
    expect(normalizeVendorName("Baldor")).not.toBe(normalizeVendorName("Baldor Specialty Foods"));
  });

  it("is idempotent", () => {
    const once = normalizeVendorName("Baldor Foods");
    expect(normalizeVendorName(once)).toBe(once);
  });
});
