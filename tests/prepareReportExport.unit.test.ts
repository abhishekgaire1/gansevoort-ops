import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportDefinition } from "@/app/lib/reports/registry/types";

// CI-safe: getReportDefinition is mocked with a hand-built fake
// ReportDefinition -- this file tests prepare_report_export's OWN
// orchestration (arg validation, date/filter/grouping/column
// resolution, download construction, dataText assembly), never any one
// real report dataset's behavior (those are covered by
// tests/reportRegistry.unit.test.ts and each dataset's own report-lib
// test file).

const { getReportDefinitionMock } = vi.hoisted(() => ({ getReportDefinitionMock: vi.fn() }));
vi.mock("@/app/lib/reports/registry", () => ({ getReportDefinition: getReportDefinitionMock }));

import { validateToolArgs, executeTool, type ChatToolContext } from "@/app/lib/ai/tasks/chat/toolRegistry";

const ORG_ID = "org-1";
const CTX: ChatToolContext = {
  supabase: {} as never,
  organizationId: ORG_ID,
  currentActorAppUserId: "app-user-1",
  timeZone: "America/New_York",
  now: new Date("2026-08-20T14:00:00Z"),
};

function fakeDefinition(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    id: "waste",
    name: "Waste Report",
    datasetDescription: "test dataset",
    supportedDateKinds: ["today", "yesterday", "last_n_days", "custom_range"],
    isPointInTime: false,
    maxRangeDays: 90,
    filters: [
      { key: "item", label: "Item", kind: "lookup", description: "an item name", resolve: vi.fn(async () => ({ status: "not_found" as const })) },
      { key: "reason", label: "Reason", kind: "enum", description: "a reason code", allowedValues: ["EXPIRED", "DAMAGED"] },
    ],
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
    datasetLimitations: ["A test limitation."],
    loadReport: vi.fn(async () => ({
      summaryMetrics: [{ label: "Records", value: 3, format: "integer" as const }],
      tables: [{ sheetName: "Details", title: "Details", columns: [{ key: "a", header: "A", format: "text" as const }], rows: [{ a: "x" }], isPrimaryDetail: true }],
      isEmpty: false,
      recordCount: 3,
      pricedCount: 2,
      unpricedCount: 1,
      limitations: [],
    })),
    ...overrides,
  };
}

beforeEach(() => {
  getReportDefinitionMock.mockReset();
});

describe("validateToolArgs -- prepare_report_export strict schema", () => {
  it("accepts a minimal valid request", () => {
    const result = validateToolArgs("prepare_report_export", { reportId: "waste", dateRequest: { kind: "last_n_days", days: 10 } });
    expect(result.ok).toBe(true);
  });

  it("rejects an unregistered reportId at the schema level", () => {
    expect(validateToolArgs("prepare_report_export", { reportId: "sales", dateRequest: { kind: "today" } }).ok).toBe(false);
  });

  it("rejects a smuggled organizationId", () => {
    expect(validateToolArgs("prepare_report_export", { reportId: "waste", dateRequest: { kind: "today" }, organizationId: "attacker-org" }).ok).toBe(false);
  });

  it("rejects an unknown date request kind", () => {
    expect(validateToolArgs("prepare_report_export", { reportId: "waste", dateRequest: { kind: "next_week" } }).ok).toBe(false);
  });

  it("rejects a non-xlsx format", () => {
    expect(validateToolArgs("prepare_report_export", { reportId: "waste", dateRequest: { kind: "today" }, format: "csv" }).ok).toBe(false);
  });

  it("rejects more than the maximum number of filters", () => {
    const filters = Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, rawValue: "v" }));
    expect(validateToolArgs("prepare_report_export", { reportId: "waste", dateRequest: { kind: "today" }, filters }).ok).toBe(false);
  });
});

describe("prepare_report_export -- execution", () => {
  it("rejects an unsupported report id at execution time too (defense in depth)", async () => {
    getReportDefinitionMock.mockReturnValue(null);
    const result = await executeTool("prepare_report_export", CTX, { reportId: "sales", dateRequest: { kind: "today" } });
    expect(result).toMatchObject({ ok: true, insufficientData: true });
  });

  it("on success, resolves the date request server-side and never trusts a model-supplied date string beyond kind/day-count/month/year", async () => {
    const def = fakeDefinition();
    getReportDefinitionMock.mockReturnValue(def);
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "last_n_days", days: 10 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insufficientData).toBe(false);
    expect(result.downloads).toHaveLength(1);
    expect(result.downloads?.[0].reportSpecification.dateRange).toEqual({ startDate: "2026-08-11", endDate: "2026-08-20", isPointInTime: false });
  });

  it("rejects a range longer than the report's own maximum", async () => {
    getReportDefinitionMock.mockReturnValue(fakeDefinition());
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "custom_range", startDate: "2026-01-01", endDate: "2026-08-20" } });
    expect(result).toMatchObject({ ok: true, insufficientData: true });
    if (result.ok) expect(result.downloads).toBeUndefined();
  });

  it("an enum filter with an unsupported value is rejected with the allowed values listed", async () => {
    getReportDefinitionMock.mockReturnValue(fakeDefinition());
    const result = await executeTool("prepare_report_export", CTX, {
      reportId: "waste",
      dateRequest: { kind: "today" },
      filters: [{ key: "reason", rawValue: "NOT_A_REASON" }],
    });
    expect(result).toMatchObject({ ok: true, insufficientData: true });
    if (result.ok) expect(result.dataText).toContain("EXPIRED");
  });

  it("an unsupported filter key is ignored (not fatal) and mentioned in the response text", async () => {
    getReportDefinitionMock.mockReturnValue(fakeDefinition());
    const result = await executeTool("prepare_report_export", CTX, {
      reportId: "waste",
      dateRequest: { kind: "today" },
      filters: [{ key: "not-a-real-filter", rawValue: "whatever" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insufficientData).toBe(false);
    expect(result.dataText).toContain("not-a-real-filter");
    expect(result.downloads).toHaveLength(1);
  });

  it("a not_found lookup filter is rejected (insufficientData true, no download)", async () => {
    const def = fakeDefinition({
      filters: [{ key: "item", label: "Item", kind: "lookup", description: "an item name", resolve: vi.fn(async () => ({ status: "not_found" as const })) }],
    });
    getReportDefinitionMock.mockReturnValue(def);
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" }, filters: [{ key: "item", rawValue: "Nonexistent Thing" }] });
    expect(result).toMatchObject({ ok: true, insufficientData: true });
  });

  it("an ambiguous lookup filter reaches synthesis (insufficientData false) so the model can ask which one, and never guesses", async () => {
    const def = fakeDefinition({
      filters: [
        {
          key: "item",
          label: "Item",
          kind: "lookup",
          description: "an item name",
          resolve: vi.fn(async () => ({
            status: "ambiguous" as const,
            candidates: [{ id: "i1", name: "Whole Milk Quart" }, { id: "i2", name: "Whole Milk Half Gallon" }],
          })),
        },
      ],
    });
    getReportDefinitionMock.mockReturnValue(def);
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" }, filters: [{ key: "item", rawValue: "Whole Milk" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insufficientData).toBe(false);
    expect(result.downloads).toBeUndefined();
    expect(result.dataText).toContain("Whole Milk Quart");
    expect(result.dataText).toContain("Whole Milk Half Gallon");
  });

  it("a report with a required filter that wasn't supplied is rejected with a clarifying message", async () => {
    const def = fakeDefinition({ requiredFilterKeys: ["item"] });
    getReportDefinitionMock.mockReturnValue(def);
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" } });
    expect(result).toMatchObject({ ok: true, insufficientData: true });
    if (result.ok) expect(result.dataText).toContain("Item");
  });

  it("an unsupported grouping falls back to the default rather than failing, and says so", async () => {
    getReportDefinitionMock.mockReturnValue(fakeDefinition());
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" }, grouping: "by_nonsense" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.downloads?.[0].reportSpecification.grouping).toBeNull();
    expect(result.dataText).toContain("by_nonsense");
  });

  it("pricing is forced off for a not_supported dataset even if the model asks for it", async () => {
    getReportDefinitionMock.mockReturnValue(fakeDefinition({ pricingMode: "not_supported" }));
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" }, includePricing: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.downloads?.[0].reportSpecification.includePricing).toBe(false);
    expect(result.dataText).toContain("not available");
  });

  it("a loader hard-failure (empty tables and summaryMetrics) is treated as insufficientData, never a download", async () => {
    const def = fakeDefinition({
      loadReport: vi.fn(async () => ({ summaryMetrics: [], tables: [], isEmpty: true, recordCount: 0, pricedCount: null, unpricedCount: null, limitations: ["Something specific broke."] })),
    });
    getReportDefinitionMock.mockReturnValue(def);
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" } });
    expect(result).toMatchObject({ ok: true, insufficientData: true, dataText: "Something specific broke." });
  });

  it("the model can never supply an href/organizationId/token -- the download only ever carries the resolved reportSpecification", async () => {
    getReportDefinitionMock.mockReturnValue(fakeDefinition());
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const download = result.downloads?.[0];
    expect(download).toEqual({
      label: "Download Waste Report",
      format: "xlsx",
      reportSpecification: {
        reportId: "waste",
        dateRange: { startDate: "2026-08-20", endDate: "2026-08-20", isPointInTime: false },
        filters: [],
        grouping: null,
        columns: ["a", "b"],
        includePricing: false,
        format: "xlsx",
      },
    });
    expect(Object.keys(download as object)).not.toContain("href");
    expect(Object.keys(download as object)).not.toContain("organizationId");
  });

  it("states real summary figures from the loader's own recordCount/priced/unpriced counts -- never invented", async () => {
    getReportDefinitionMock.mockReturnValue(fakeDefinition());
    const result = await executeTool("prepare_report_export", CTX, { reportId: "waste", dateRequest: { kind: "today" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataText).toContain("3 record(s) found");
    expect(result.dataText).toContain("Records: 3");
  });
});
