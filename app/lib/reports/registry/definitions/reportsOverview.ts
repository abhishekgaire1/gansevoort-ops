import "server-only";
import { getPurchasingReport } from "@/app/lib/reports/purchasingReport";
import { getReceivingReport } from "@/app/lib/reports/receivingReport";
import { getUsageReport } from "@/app/lib/reports/usageReport";
import { getWasteReport } from "@/app/lib/reports/wasteReport";
import { getInventoryStatusReport } from "@/app/lib/reports/inventoryStatusReport";
import type { ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";

/**
 * General Report Builder -- Reports Overview definition. Composes the
 * SAME five report functions every other overview view (on-screen and
 * the static export) already uses -- never a new computation. No
 * filters/groupings are registered: this is a fixed, whole-organization
 * summary by design, matching the existing Overview page/export.
 */

export const reportsOverviewDefinition: ReportDefinition = {
  id: "reports_overview",
  name: "Reports Overview",
  datasetDescription: "A general operational summary across purchasing, receiving, usage, waste and current inventory status.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [],
  requiredFilterKeys: [],
  groupings: [],
  defaultGrouping: null,
  columns: [
    { key: "metric", header: "Metric", format: "text" },
    { key: "value", header: "Value", format: "text" },
  ],
  defaultColumnKeys: ["metric", "value"],
  requiredColumnKeys: ["metric", "value"],
  maxColumns: 2,
  pricingMode: "actual",
  datasetLimitations: [
    "A fixed, whole-organization summary -- no filters or groupings are available for this report.",
    "Purchase Value is the only dollar figure in this report and is always a direct verified total, not an estimate.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const [purchasing, receiving, usage, waste, inventoryStatus] = await Promise.all([
      getPurchasingReport(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate),
      getReceivingReport(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate),
      getUsageReport(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate),
      getWasteReport(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate),
      getInventoryStatusReport(ctx.supabase, ctx.organizationId),
    ]);

    const metricRows: { metric: string; value: string }[] = [];
    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [];
    function addMetric(label: string, value: number, format: "currency" | "integer") {
      summaryMetrics.push({ label, value, format });
      metricRows.push({ metric: label, value: format === "currency" ? value.toLocaleString(undefined, { style: "currency", currency: "USD" }) : String(value) });
    }
    addMetric("Purchase Value", purchasing.totalPurchaseValue, "currency");
    addMetric("Purchasing Documents", purchasing.documentCount, "integer");
    addMetric("Receiving Documents Processed", receiving.documentCount, "integer");
    addMetric("Ready to Post", receiving.readyToPostCount, "integer");
    addMetric("Partially Posted", receiving.partiallyPostedCount, "integer");
    addMetric("Low Stock", inventoryStatus.lowStockCount, "integer");
    addMetric("Out of Stock", inventoryStatus.outOfStockCount, "integer");
    addMetric("Withdrawal Movements", usage.movementCount, "integer");
    addMetric("Waste Events", waste.eventCount, "integer");

    return {
      summaryMetrics,
      tables: [
        {
          sheetName: "Metrics",
          title: "Summary Metrics",
          columns: [
            { key: "metric", header: "Metric", format: "text" },
            { key: "value", header: "Value", format: "text" },
          ],
          rows: metricRows,
          isPrimaryDetail: true,
          pdf: { include: false },
        },
      ],
      isEmpty: false,
      recordCount: metricRows.length,
      pricedCount: null,
      unpricedCount: null,
      limitations: reportsOverviewDefinition.datasetLimitations,
    };
  },
};
