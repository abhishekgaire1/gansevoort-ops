import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportExportCellFormat, ReportExportMetric, ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- the ONE typed contract every registered
 * report definition implements (Section 6/8). A future report is added
 * by registering a new ReportDefinition (see registry/definitions/*.ts
 * and registry/index.ts) -- never by teaching the planner, the chat
 * tool, the download route, or the Excel writer about a new report by
 * name. Nothing here is a general-purpose query mechanism: every
 * definition's loadReport calls an already-existing, already-
 * organization-scoped report/data function -- it can never select an
 * arbitrary table or column.
 */

export const REPORT_IDS = [
  "purchasing",
  "receiving",
  "inventory_status",
  "usage",
  "waste",
  "cycle_counts",
  "inventory_alerts",
  "reports_overview",
  "item_cost_history",
] as const;
export type ReportId = (typeof REPORT_IDS)[number];

/** A dataset's own fixed pricing capability -- never a per-request
 * choice the model can override. `actual` means the figure is a direct
 * verified transactional value; `estimated` means it is derived from the
 * latest eligible verified purchase price as of an event (never a future
 * purchase, never invented); `not_supported` means this dataset has no
 * safe pricing basis at all and `includePricing` is always ignored. */
export type PricingMode = "actual" | "estimated" | "not_supported";

export const DATE_REQUEST_KINDS = [
  "today",
  "yesterday",
  "last_n_days",
  "current_week",
  "previous_week",
  "current_month",
  "previous_month",
  "calendar_month",
  "custom_range",
  "point_in_time",
] as const;
export type DateRequestKind = (typeof DATE_REQUEST_KINDS)[number];

/** The model's request for a date period -- never raw computed dates
 * except for custom_range/calendar_month, where it may only supply the
 * literal values the manager actually named; the SERVER always resolves
 * the concrete calendar boundaries (see resolveDateRequest.ts). */
export interface DateRequest {
  kind: DateRequestKind;
  /** last_n_days only. */
  days?: number;
  /** calendar_month only, 1-12. */
  month?: number;
  /** calendar_month only. */
  year?: number;
  /** custom_range only, "YYYY-MM-DD". */
  startDate?: string;
  /** custom_range only, "YYYY-MM-DD". */
  endDate?: string;
}

export interface ResolvedDateRange {
  /** Inclusive, "YYYY-MM-DD", org-timezone calendar date. Empty string
   * for a point-in-time report (no range at all). */
  startDate: string;
  endDate: string;
  isPointInTime: boolean;
}

/** A single filter VALUE as the model supplies it -- a plain name/search
 * term (for lookup filters) or a literal enum value (for enum filters).
 * Never an id; ids only ever come out of resolution, never in. */
export interface ReportFilterRequest {
  key: string;
  rawValue: string;
}

/** A resolved, organization-scoped filter -- what the tool/route actually
 * applies. `id` is the trusted, org-checked identifier (or the literal
 * enum value for enum filters, which need no id). */
export interface ResolvedReportFilter {
  key: string;
  label: string;
  id: string;
  name: string;
}

export type FilterResolutionOutcome =
  | { status: "resolved"; id: string; name: string }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] };

export interface ReportRuntimeContext {
  supabase: SupabaseClient;
  organizationId: string;
  timeZone: string;
  now: Date;
}

interface ReportFilterDefinitionBase {
  key: string;
  label: string;
  /** Chat-facing description of what this filter accepts, used only in
   * the tool catalog description shown to the model -- never persisted,
   * never sent to the client. */
  description: string;
}

/** A "lookup" filter resolves a manager-supplied name/search term to an
 * organization-scoped id via an already-existing table -- never a raw id
 * accepted from the model. An "enum" filter has a small fixed set of
 * literal values (status codes, reason codes) needing no database
 * lookup at all -- the raw value is validated directly against
 * `allowedValues`, never used to construct a query fragment. */
export type ReportFilterDefinition =
  | (ReportFilterDefinitionBase & { kind: "lookup"; resolve: (ctx: ReportRuntimeContext, rawValue: string) => Promise<FilterResolutionOutcome> })
  | (ReportFilterDefinitionBase & { kind: "enum"; allowedValues: readonly string[] });

export interface ReportGroupingDefinition {
  key: string;
  label: string;
}

export interface ReportColumnDefinition {
  key: string;
  header: string;
  format: ReportExportCellFormat;
}

/** The fully validated, server-trusted request the tool hands to the
 * orchestrator and the client hands (unchanged) to the download route.
 * The download route treats this as a REQUEST, never as authorization --
 * every field is independently re-validated against the registry and the
 * authenticated organization before any data is loaded (Section 11). */
export interface ResolvedReportSpecification {
  reportId: ReportId;
  dateRange: ResolvedDateRange;
  filters: ResolvedReportFilter[];
  grouping: string | null;
  columns: string[];
  includePricing: boolean;
  format: "xlsx";
}

export interface ReportLoadResult {
  summaryMetrics: ReportExportMetric[];
  tables: ReportExportTable[];
  /** True when the underlying dataset had zero rows for this request --
   * the workbook is still built (Section 14 "Empty report"), this flag
   * only drives the chat summary's wording. */
  isEmpty: boolean;
  /** Recorded counts a chat answer may truthfully cite (e.g. "42 waste
   * records, 37 priced") -- always taken from here, never invented by
   * the model. */
  recordCount: number;
  pricedCount: number | null;
  unpricedCount: number | null;
  /** Plain-language limitations specific to THIS load (e.g. an ambiguous
   * pricing gap, a truncated vendor pool) -- appended to the workbook's
   * Summary sheet and safe to repeat in the chat answer. */
  limitations: string[];
}

export interface ReportDefinition {
  id: ReportId;
  name: string;
  datasetDescription: string;
  supportedDateKinds: readonly DateRequestKind[];
  isPointInTime: boolean;
  /** null when this report has no transactional-detail range ceiling
   * (point-in-time reports only). */
  maxRangeDays: number | null;
  filters: ReportFilterDefinition[];
  /** Filter keys (from `filters` above) that MUST be present and resolved
   * before this report can run at all (Section 12 "item_cost_history:
   * Require a resolved item") -- enforced generically by the tool, never
   * a special case hardcoded per report id. */
  requiredFilterKeys: string[];
  groupings: ReportGroupingDefinition[];
  defaultGrouping: string | null;
  columns: ReportColumnDefinition[];
  defaultColumnKeys: string[];
  requiredColumnKeys: string[];
  maxColumns: number;
  pricingMode: PricingMode;
  /** Plain-language capability notes always surfaced (both in the chat
   * tool catalog and in every generated workbook) -- e.g. "no per-
   * transaction line detail; totals only." Never silently omitted. */
  datasetLimitations: string[];
  loadReport: (ctx: ReportRuntimeContext, spec: ResolvedReportSpecification) => Promise<ReportLoadResult>;
}
