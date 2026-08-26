import "server-only";
import { getPurchasingReport, getPurchasingReportPriceChanges } from "@/app/lib/reports/purchasingReport";
import { resolveVendorByName, resolveInventoryCategoryByName, resolveInventoryItemByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";
import type { ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- Purchasing report definition. get_purchasing_report
 * is a server-aggregated RPC (By Vendor/By Category/By Item totals) --
 * there is no bulk, date-ranged per-document/per-line transaction detail
 * exposed anywhere in this codebase, so this report's finest available
 * grain IS its aggregate breakdowns; a fabricated line-item "Details"
 * sheet would misrepresent data that doesn't exist as a bulk dataset.
 */

const BREAKDOWN_COLUMNS: ReportColumnDefinition[] = [
  { key: "name", header: "Name", format: "text" },
  { key: "totalValue", header: "Total Verified Purchase Value", format: "currency" },
];
const DEFAULT_COLUMN_KEYS = ["name", "totalValue"];
const REQUIRED_COLUMN_KEYS = ["name", "totalValue"];

export const purchasingReportDefinition: ReportDefinition = {
  id: "purchasing",
  name: "Purchasing Report",
  datasetDescription: "Verified, posted purchasing totals by vendor, category and item, plus recent unit-price changes.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [
    { key: "vendor", label: "Vendor", kind: "lookup", description: "A vendor name.", resolve: (ctx, raw) => resolveVendorByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "category", label: "Category", kind: "lookup", description: "An inventory category name.", resolve: (ctx, raw) => resolveInventoryCategoryByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "item", label: "Item", kind: "lookup", description: "An inventory item name.", resolve: (ctx, raw) => resolveInventoryItemByName(ctx.supabase, ctx.organizationId, raw) },
  ],
  requiredFilterKeys: [],
  groupings: [
    { key: "by_vendor", label: "By Vendor" },
    { key: "by_category", label: "By Category" },
    { key: "by_item", label: "By Item" },
    { key: "price_changes", label: "Price Changes" },
  ],
  defaultGrouping: null,
  columns: BREAKDOWN_COLUMNS,
  defaultColumnKeys: DEFAULT_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_COLUMN_KEYS,
  maxColumns: 2,
  pricingMode: "actual",
  datasetLimitations: [
    "Provides vendor/category/item aggregate totals only -- per-document or per-line purchasing transaction detail is not currently exposed as a bulk, date-ranged dataset.",
    "Reflects the verified purchase line amount only -- excludes unallocated document-level tax, freight, or other charges.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const vendorFilter = spec.filters.find((f) => f.key === "vendor");
    const categoryFilter = spec.filters.find((f) => f.key === "category");
    const itemFilter = spec.filters.find((f) => f.key === "item");

    const [report, priceChanges] = await Promise.all([
      getPurchasingReport(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate, {
        vendorId: vendorFilter?.id ?? null,
        inventoryCategoryId: categoryFilter?.id ?? null,
        inventoryItemId: itemFilter?.id ?? null,
      }),
      getPurchasingReportPriceChanges(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate, vendorFilter?.id ?? null, categoryFilter?.id ?? null),
    ]);

    const columns = resolveColumns(BREAKDOWN_COLUMNS, spec.columns, DEFAULT_COLUMN_KEYS, REQUIRED_COLUMN_KEYS, 2);
    const toRows = (rows: { name: string; totalValue: number }[]) => rows.map((r) => projectRow({ name: r.name, totalValue: r.totalValue }, columns));

    const tables: ReportExportTable[] = [];
    const includeAll = !spec.grouping;
    if (includeAll || spec.grouping === "by_vendor") {
      tables.push({ sheetName: "By Vendor", title: "By Vendor", columns, rows: toRows(report.byVendor), isPrimaryDetail: tables.length === 0, pdf: { include: true, maxRows: 25 } });
    }
    if (includeAll || spec.grouping === "by_category") {
      tables.push({ sheetName: "By Category", title: "By Category", columns, rows: toRows(report.byCategory), isPrimaryDetail: tables.length === 0, pdf: { include: true, maxRows: 25 } });
    }
    if (includeAll || spec.grouping === "by_item") {
      tables.push({ sheetName: "By Item", title: "By Item", columns, rows: toRows(report.byItem), isPrimaryDetail: tables.length === 0, pdf: { include: true, maxRows: 25 } });
    }
    if (includeAll || spec.grouping === "price_changes") {
      const priceChangeRows = [...priceChanges.increases.map((r) => ({ direction: "Increase", ...r })), ...priceChanges.decreases.map((r) => ({ direction: "Decrease", ...r }))];
      tables.push({
        sheetName: "Price Changes",
        title: "Price Changes",
        columns: [
          { key: "direction", header: "Direction", format: "text" },
          { key: "itemName", header: "Item", format: "text" },
          { key: "vendorName", header: "Vendor", format: "text" },
          { key: "baseUnitCode", header: "Unit", format: "text" },
          { key: "currentUnitCost", header: "Current Cost", format: "currency" },
          { key: "previousUnitCost", header: "Previous Cost", format: "currency" },
          { key: "deltaAbs", header: "Change", format: "currency" },
          { key: "deltaPct", header: "Change %", format: "percent" },
          { key: "currentDocumentNumber", header: "Current Document", format: "text" },
          { key: "previousDocumentNumber", header: "Previous Document", format: "text" },
        ],
        rows: priceChangeRows.map((r) => ({
          direction: r.direction,
          itemName: r.itemName,
          vendorName: r.vendorName,
          baseUnitCode: r.baseUnitCode,
          currentUnitCost: r.currentUnitCost,
          previousUnitCost: r.previousUnitCost,
          deltaAbs: r.deltaAbs,
          deltaPct: r.deltaPct,
          currentDocumentNumber: r.currentDocumentNumber,
          previousDocumentNumber: r.previousDocumentNumber,
        })),
        isPrimaryDetail: tables.length === 0,
        pdf: { include: true, maxRows: 25 },
      });
    }

    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [
      { label: "Total Verified Purchase Value", value: report.totalPurchaseValue, format: "currency" },
      { label: "Documents", value: report.documentCount, format: "integer" },
      { label: "Vendors", value: report.vendorCount, format: "integer" },
      { label: "Items", value: report.itemCount, format: "integer" },
    ];

    return {
      summaryMetrics,
      tables,
      isEmpty: report.documentCount === 0,
      recordCount: report.documentCount,
      pricedCount: null,
      unpricedCount: null,
      limitations: [...purchasingReportDefinition.datasetLimitations, ...(report.documentCount === 0 ? ["No purchasing activity was recorded during this period."] : [])],
    };
  },
};
