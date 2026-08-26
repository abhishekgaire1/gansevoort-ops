import { describe, expect, it, vi } from "vitest";
import { revalidateReportSpecification } from "@/app/lib/reports/registry/revalidateSpecification";
import type { ReportDefinition, ReportRuntimeContext } from "@/app/lib/reports/registry/types";

// CI-safe: no network/DB. Covers Section 20 items 31-33 (download route
// independently reauthorizes/revalidates, client tampering cannot
// change organization) at the revalidation-logic level, independent of
// the Route Handler itself.

const ORG_ID = "org-1";
const CTX: ReportRuntimeContext = { supabase: {} as never, organizationId: ORG_ID, timeZone: "America/New_York", now: new Date("2026-08-20T14:00:00Z") };

function def(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    id: "waste",
    name: "Waste Report",
    datasetDescription: "test",
    supportedDateKinds: ["today", "custom_range"],
    isPointInTime: false,
    maxRangeDays: 90,
    filters: [{ key: "item", label: "Item", kind: "lookup", description: "x", resolve: vi.fn(async () => ({ status: "resolved" as const, id: "item-1", name: "Whole Milk Quart" })) }],
    requiredFilterKeys: [],
    groupings: [{ key: "by_item", label: "By Item" }],
    defaultGrouping: null,
    columns: [
      { key: "a", header: "A", format: "text" },
      { key: "b", header: "B", format: "integer" },
    ],
    defaultColumnKeys: ["a", "b"],
    requiredColumnKeys: [],
    maxColumns: 10,
    pricingMode: "estimated",
    datasetLimitations: [],
    loadReport: vi.fn(),
    ...overrides,
  };
}

function validWire(overrides: Record<string, unknown> = {}) {
  return {
    reportId: "waste",
    dateRange: { startDate: "2026-08-16", endDate: "2026-08-20", isPointInTime: false },
    filters: [],
    grouping: null,
    columns: ["a", "b"],
    includePricing: true,
    format: "xlsx",
    ...overrides,
  };
}

describe("revalidateReportSpecification -- malformed/mismatched requests", () => {
  it("rejects a malformed body", async () => {
    const result = await revalidateReportSpecification(CTX, def(), { not: "a spec" });
    expect(result.ok).toBe(false);
  });

  it("rejects a reportId mismatch between the definition and the wire body", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire({ reportId: "purchasing" }));
    expect(result.ok).toBe(false);
  });
});

describe("revalidateReportSpecification -- date range re-validation", () => {
  it("rejects a point-in-time flag mismatch", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire({ dateRange: { startDate: "", endDate: "", isPointInTime: true } }));
    expect(result.ok).toBe(false);
  });

  it("rejects a reversed date range even if it slipped through the client", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire({ dateRange: { startDate: "2026-08-20", endDate: "2026-08-01", isPointInTime: false } }));
    expect(result.ok).toBe(false);
  });

  it("rejects a range wider than the report's own maximum, even if the client claims it's fine", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire({ dateRange: { startDate: "2026-01-01", endDate: "2026-08-20", isPointInTime: false } }));
    expect(result.ok).toBe(false);
  });

  it("accepts a genuinely valid range", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire());
    expect(result.ok).toBe(true);
  });
});

describe("revalidateReportSpecification -- filter re-verification (tampering resistance)", () => {
  it("rejects a filter key that isn't registered for this report", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire({ filters: [{ key: "not-real", label: "X", id: "x", name: "x" }] }));
    expect(result.ok).toBe(false);
  });

  it("rejects an enum filter value outside the allowed set", async () => {
    const withEnum = def({ filters: [{ key: "reason", label: "Reason", kind: "enum", description: "x", allowedValues: ["EXPIRED"] }] });
    const result = await revalidateReportSpecification(CTX, withEnum, validWire({ filters: [{ key: "reason", label: "Reason", id: "DAMAGED", name: "DAMAGED" }] }));
    expect(result.ok).toBe(false);
  });

  it("re-resolves a lookup filter by name and rejects if the re-resolved id no longer matches (e.g. a tampered/foreign id)", async () => {
    const resolve = vi.fn(async () => ({ status: "resolved" as const, id: "item-1", name: "Whole Milk Quart" }));
    const withLookup = def({ filters: [{ key: "item", label: "Item", kind: "lookup", description: "x", resolve }] });
    const result = await revalidateReportSpecification(CTX, withLookup, validWire({ filters: [{ key: "item", label: "Item", id: "item-ATTACKER", name: "Whole Milk Quart" }] }));
    expect(result.ok).toBe(false);
    // The resolver is always called scoped to CTX.organizationId -- a
    // tampered id from another org can never be silently accepted.
    expect(resolve).toHaveBeenCalledWith(CTX, "Whole Milk Quart");
  });

  it("accepts a lookup filter whose id re-resolves to the same value", async () => {
    const resolve = vi.fn(async () => ({ status: "resolved" as const, id: "item-1", name: "Whole Milk Quart" }));
    const withLookup = def({ filters: [{ key: "item", label: "Item", kind: "lookup", description: "x", resolve }] });
    const result = await revalidateReportSpecification(CTX, withLookup, validWire({ filters: [{ key: "item", label: "Item", id: "item-1", name: "Whole Milk Quart" }] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.filters).toEqual([{ key: "item", label: "Item", id: "item-1", name: "Whole Milk Quart" }]);
  });

  it("rejects when a required filter is missing", async () => {
    const withRequired = def({ requiredFilterKeys: ["item"] });
    const result = await revalidateReportSpecification(CTX, withRequired, validWire({ filters: [] }));
    expect(result.ok).toBe(false);
  });
});

describe("revalidateReportSpecification -- grouping/columns/pricing re-validation", () => {
  it("drops an unregistered grouping back to null rather than trusting it", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire({ grouping: "by_nonsense" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.grouping).toBeNull();
  });

  it("strips a column not in the report's allowlist", async () => {
    const result = await revalidateReportSpecification(CTX, def(), validWire({ columns: ["a", "ghost-column"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.columns).toEqual(["a"]);
  });

  it("forces includePricing off for a not_supported dataset regardless of what the client sent", async () => {
    const notSupported = def({ pricingMode: "not_supported" });
    const result = await revalidateReportSpecification(CTX, notSupported, validWire({ includePricing: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.includePricing).toBe(false);
  });
});
