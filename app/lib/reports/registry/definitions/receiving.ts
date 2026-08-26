import "server-only";
import { getReceivingReport } from "@/app/lib/reports/receivingReport";
import { resolveVendorByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";
import type { ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- Receiving report definition. get_receiving_report
 * exposes document/posting-status counts only -- it carries no purchasing
 * dollar figures at all, so pricing is genuinely not_supported here
 * (never a value borrowed from the Purchasing dataset instead).
 */

const BREAKDOWN_COLUMNS: ReportColumnDefinition[] = [
  { key: "name", header: "Name", format: "text" },
  { key: "count", header: "Documents", format: "integer" },
];
const DEFAULT_COLUMN_KEYS = ["name", "count"];
const REQUIRED_COLUMN_KEYS = ["name", "count"];

export const receivingReportDefinition: ReportDefinition = {
  id: "receiving",
  name: "Receiving Report",
  datasetDescription: "Receiving document counts and posting status (ready to post, partially posted, posted, credit lines), by vendor and by status.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [{ key: "vendor", label: "Vendor", kind: "lookup", description: "A vendor name.", resolve: (ctx, raw) => resolveVendorByName(ctx.supabase, ctx.organizationId, raw) }],
  requiredFilterKeys: [],
  groupings: [
    { key: "by_vendor", label: "By Vendor" },
    { key: "by_status", label: "By Status" },
  ],
  defaultGrouping: null,
  columns: BREAKDOWN_COLUMNS,
  defaultColumnKeys: DEFAULT_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_COLUMN_KEYS,
  maxColumns: 2,
  pricingMode: "not_supported",
  datasetLimitations: [
    "Provides document counts and posting status only -- this dataset carries no purchasing dollar amounts, so pricing is not available here at all.",
    "Provides vendor and status aggregate counts only -- per-document/per-line receiving detail is not currently exposed as a bulk, date-ranged dataset.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const vendorFilter = spec.filters.find((f) => f.key === "vendor");
    const report = await getReceivingReport(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate, vendorFilter?.id ?? null);

    const columns = resolveColumns(BREAKDOWN_COLUMNS, spec.columns, DEFAULT_COLUMN_KEYS, REQUIRED_COLUMN_KEYS, 2);
    const tables: ReportExportTable[] = [];
    const includeAll = !spec.grouping;
    if (includeAll || spec.grouping === "by_vendor") {
      tables.push({
        sheetName: "By Vendor",
        title: "By Vendor",
        columns,
        rows: report.byVendor.map((r) => projectRow({ name: r.vendorName, count: r.count }, columns)),
        isPrimaryDetail: tables.length === 0,
        pdf: { include: true, maxRows: 25 },
      });
    }
    if (includeAll || spec.grouping === "by_status") {
      tables.push({
        sheetName: "By Status",
        title: "By Status",
        columns,
        rows: report.byStatus.map((r) => projectRow({ name: r.status, count: r.count }, columns)),
        isPrimaryDetail: tables.length === 0,
        pdf: { include: true, maxRows: 25 },
      });
    }

    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [
      { label: "Documents", value: report.documentCount, format: "integer" },
      { label: "Ready to Post", value: report.readyToPostCount, format: "integer" },
      { label: "Partially Posted", value: report.partiallyPostedCount, format: "integer" },
      { label: "Posted", value: report.postedCount, format: "integer" },
      { label: "Credit Lines", value: report.creditLineCount, format: "integer" },
    ];

    return {
      summaryMetrics,
      tables,
      isEmpty: report.documentCount === 0,
      recordCount: report.documentCount,
      pricedCount: null,
      unpricedCount: null,
      limitations: [...receivingReportDefinition.datasetLimitations, ...(report.documentCount === 0 ? ["No receiving activity was recorded during this period."] : [])],
    };
  },
};
