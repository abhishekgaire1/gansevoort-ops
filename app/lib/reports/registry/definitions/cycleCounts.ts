import "server-only";
import { listCycleCountSummaries } from "@/app/lib/inventory/cycleCounts";
import { resolveLocationByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";
import type { ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- Cycle Counts report definition. One row per
 * cycle-count SESSION (list_cycle_count_summaries) -- per-item variance
 * detail lives on each count's own detail page (list_cycle_count_lines),
 * which is scoped to ONE cycle count at a time and not safe to expand
 * into a bulk, org-wide, date-ranged dataset here.
 *
 * list_cycle_count_summaries has NO native date-range parameter of its
 * own (only organization/status/location/limit) -- so date filtering is
 * applied CLIENT-SIDE, and is only ever safe to do because completeness
 * is proven first: the full (status+location-filtered) set is fetched
 * with a limit-plus-one overflow check exactly like waste-event
 * discovery, and date filtering only proceeds once that set is PROVEN
 * complete (fetched count <= MAX_CYCLE_COUNT_ROWS). If the org has more
 * sessions than that for the requested statuses/location, the request
 * fails closed rather than silently missing older sessions that
 * happened to fall outside a truncated fetch.
 */

const MAX_CYCLE_COUNT_ROWS = 1000;

const COLUMNS: ReportColumnDefinition[] = [
  { key: "locationName", header: "Location", format: "text" },
  { key: "status", header: "Status", format: "text" },
  { key: "startedAt", header: "Started", format: "text" },
  { key: "startedByName", header: "Started By", format: "text" },
  { key: "completedAt", header: "Completed", format: "text" },
  { key: "completedByName", header: "Completed By", format: "text" },
  { key: "countedItemCount", header: "Items Counted", format: "integer" },
  { key: "varianceItemCount", header: "Items With Variance", format: "integer" },
];
const DEFAULT_COLUMN_KEYS = COLUMNS.map((c) => c.key);
const REQUIRED_COLUMN_KEYS = ["locationName", "status", "startedAt"];

export const cycleCountsReportDefinition: ReportDefinition = {
  id: "cycle_counts",
  name: "Cycle Count Report",
  datasetDescription: "Cycle count sessions (one row per count), their status, and their item/variance counts.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [
    { key: "location", label: "Location", kind: "lookup", description: "A storage location name.", resolve: (ctx, raw) => resolveLocationByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "status", label: "Status", kind: "enum", description: "DRAFT, COMPLETED, or CANCELLED.", allowedValues: ["DRAFT", "COMPLETED", "CANCELLED"] },
    { key: "varianceState", label: "Variance", kind: "enum", description: "ZERO_VARIANCE or NONZERO_VARIANCE (completed counts only).", allowedValues: ["ZERO_VARIANCE", "NONZERO_VARIANCE"] },
  ],
  requiredFilterKeys: [],
  groupings: [{ key: "by_location", label: "By Location" }],
  defaultGrouping: null,
  columns: COLUMNS,
  defaultColumnKeys: DEFAULT_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_COLUMN_KEYS,
  maxColumns: 8,
  pricingMode: "not_supported",
  datasetLimitations: [
    "One row per cycle-count session -- per-item variance detail is available on each count's own detail page, not as a bulk export.",
    "Date filtering is applied after fetching the full (status/location-filtered) set of sessions -- if an organization has more than 1000 matching sessions, the request fails closed rather than silently truncating.",
    "This dataset carries no purchasing dollar amounts -- pricing is not available for cycle counts.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const locationFilter = spec.filters.find((f) => f.key === "location");
    const statusFilter = spec.filters.find((f) => f.key === "status");
    const varianceFilter = spec.filters.find((f) => f.key === "varianceState");

    const statuses = statusFilter ? [statusFilter.id as "DRAFT" | "COMPLETED" | "CANCELLED"] : (["DRAFT", "COMPLETED", "CANCELLED"] as const);
    const summaries = await listCycleCountSummaries(ctx.supabase, {
      organizationId: ctx.organizationId,
      currentActorAppUserId: "", // not used for filtering -- isOwnedByCurrentManager is not surfaced in this report
      statuses: [...statuses],
      locationId: locationFilter?.id ?? null,
      limit: MAX_CYCLE_COUNT_ROWS + 1,
    });

    if (summaries.length > MAX_CYCLE_COUNT_ROWS) {
      return {
        summaryMetrics: [],
        tables: [],
        isEmpty: true,
        recordCount: 0,
        pricedCount: null,
        unpricedCount: null,
        limitations: [`This organization has more than ${MAX_CYCLE_COUNT_ROWS} matching cycle-count sessions -- narrow by location or status and try again.`],
      };
    }

    const inRange = summaries.filter((s) => {
      const startedDate = s.startedAt.slice(0, 10);
      return startedDate >= spec.dateRange.startDate && startedDate <= spec.dateRange.endDate;
    });
    const filtered = varianceFilter
      ? inRange.filter((s) => (varianceFilter.id === "ZERO_VARIANCE" ? s.varianceItemCount === 0 : s.varianceItemCount > 0))
      : inRange;

    const columns = resolveColumns(COLUMNS, spec.columns, DEFAULT_COLUMN_KEYS, REQUIRED_COLUMN_KEYS, 8);
    const detailTable: ReportExportTable = {
      sheetName: "Cycle Counts",
      title: "Cycle Counts",
      columns,
      rows: filtered.map((s) =>
        projectRow(
          {
            locationName: s.locationName,
            status: s.status,
            startedAt: s.startedAt,
            startedByName: s.startedByName,
            completedAt: s.completedAt,
            completedByName: s.completedByName,
            countedItemCount: s.countedItemCount,
            varianceItemCount: s.varianceItemCount,
          },
          columns
        )
      ),
      isPrimaryDetail: true,
      pdf: { include: true, maxRows: 25 },
    };

    const tables: ReportExportTable[] = [detailTable];
    if (spec.grouping === "by_location") {
      const map = new Map<string, { locationName: string; sessionCount: number; countedItemCount: number; varianceItemCount: number }>();
      for (const s of filtered) {
        if (!map.has(s.locationName)) map.set(s.locationName, { locationName: s.locationName, sessionCount: 0, countedItemCount: 0, varianceItemCount: 0 });
        const agg = map.get(s.locationName)!;
        agg.sessionCount += 1;
        agg.countedItemCount += s.countedItemCount;
        agg.varianceItemCount += s.varianceItemCount;
      }
      tables.push({
        sheetName: "By Location",
        title: "By Location",
        columns: [
          { key: "locationName", header: "Location", format: "text" },
          { key: "sessionCount", header: "Cycle Counts", format: "integer" },
          { key: "countedItemCount", header: "Items Counted", format: "integer" },
          { key: "varianceItemCount", header: "Items With Variance", format: "integer" },
        ],
        rows: Array.from(map.values()),
        pdf: { include: true, maxRows: 25 },
      });
    }

    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [
      { label: "Cycle Counts", value: filtered.length, format: "integer" },
      { label: "Completed", value: filtered.filter((s) => s.status === "COMPLETED").length, format: "integer" },
      { label: "With Variance", value: filtered.filter((s) => s.varianceItemCount > 0).length, format: "integer" },
    ];

    return {
      summaryMetrics,
      tables,
      isEmpty: filtered.length === 0,
      recordCount: filtered.length,
      pricedCount: null,
      unpricedCount: null,
      limitations: [...cycleCountsReportDefinition.datasetLimitations, ...(filtered.length === 0 ? ["No cycle counts matched this request."] : [])],
    };
  },
};
