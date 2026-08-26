import "server-only";
import { getWasteCostReport } from "@/app/lib/reports/wasteCostReport";
import { resolveInventoryItemByName, resolveLocationByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import { WASTE_REASON_CODES } from "@/app/lib/inventory/wasteReasons";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";
import type { ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- Waste report definition. Reuses
 * getWasteCostReport (event-level, org+date-range-scoped, the ONE
 * genuinely bulk-safe transaction-detail source among the registered
 * reports) for both the priced and unpriced case -- includePricing only
 * decides whether historical-price resolution runs at all, never a
 * separate calculation path.
 */

const PRICING_COLUMN_KEYS = ["unitPrice", "estimatedCost", "costBasisDate", "costBasisVendorName", "costBasisDocumentReference", "pricingStatus", "pricingLimitation"];

const DETAIL_COLUMNS: ReportColumnDefinition[] = [
  { key: "wasteDate", header: "Waste Date", format: "date" },
  { key: "wasteTime", header: "Waste Time", format: "text" },
  { key: "locationName", header: "Storage Location", format: "text" },
  { key: "itemName", header: "Item", format: "text" },
  { key: "categoryName", header: "Category", format: "text" },
  { key: "reasonLabel", header: "Waste Reason", format: "text" },
  { key: "quantity", header: "Wasted Quantity", format: "decimal" },
  { key: "baseUnitCode", header: "Base Unit", format: "text" },
  { key: "unitPrice", header: "Verified Unit Purchase Price", format: "currency" },
  { key: "estimatedCost", header: "Estimated Waste Cost", format: "currency" },
  { key: "costBasisDate", header: "Cost-Basis Purchase Date", format: "date" },
  { key: "costBasisVendorName", header: "Cost-Basis Vendor", format: "text" },
  { key: "costBasisDocumentReference", header: "Cost-Basis Purchase Document Reference", format: "text" },
  { key: "pricingStatus", header: "Pricing Status", format: "text" },
  { key: "pricingLimitation", header: "Pricing Limitation", format: "text" },
  { key: "movementId", header: "Waste Movement Reference", format: "text" },
];
const DEFAULT_COLUMN_KEYS = DETAIL_COLUMNS.map((c) => c.key);
const REQUIRED_COLUMN_KEYS = ["wasteDate", "itemName", "quantity", "baseUnitCode"];

const DISCLAIMER =
  "Estimated waste costs use the latest eligible verified purchase price available on or before each waste event. They exclude unallocated tax, freight and document-level fees and are operational estimates, not accounting inventory valuation or COGS.";

export const wasteReportDefinition: ReportDefinition = {
  id: "waste",
  name: "Waste Report",
  datasetDescription: "Storage waste events (tracked-inventory loss recorded via Record Waste) -- never station/prep waste, which is not modeled in this system.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [
    { key: "item", label: "Item", kind: "lookup", description: "An inventory item name.", resolve: (ctx, raw) => resolveInventoryItemByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "location", label: "Storage Location", kind: "lookup", description: "A storage location name.", resolve: (ctx, raw) => resolveLocationByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "reason", label: "Waste Reason", kind: "enum", description: "One of the fixed waste reason codes.", allowedValues: WASTE_REASON_CODES },
  ],
  requiredFilterKeys: [],
  groupings: [
    { key: "by_item", label: "By Item" },
    { key: "by_reason", label: "By Reason" },
  ],
  defaultGrouping: null,
  columns: DETAIL_COLUMNS,
  defaultColumnKeys: DEFAULT_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_COLUMN_KEYS,
  maxColumns: 16,
  pricingMode: "estimated",
  datasetLimitations: [
    "Reflects storage waste recorded via Record Waste only -- station/prep waste is not tracked in this system.",
    "Estimated costs use the latest eligible verified purchase price on or before the waste event -- unpriced lines are left blank, never substituted with a current or average price.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const itemFilter = spec.filters.find((f) => f.key === "item");
    const locationFilter = spec.filters.find((f) => f.key === "location");
    const reasonFilter = spec.filters.find((f) => f.key === "reason");

    const result = await getWasteCostReport(ctx.supabase, ctx.organizationId, ctx.timeZone, spec.dateRange.startDate, spec.dateRange.endDate, {
      inventoryItemId: itemFilter?.id ?? null,
      locationId: locationFilter?.id ?? null,
      reasonCode: reasonFilter?.id ?? null,
      includePricing: spec.includePricing,
    });

    if (!result.ok) {
      return { summaryMetrics: [], tables: [], isEmpty: true, recordCount: 0, pricedCount: null, unpricedCount: null, limitations: [result.message] };
    }
    const report = result.report;

    let detailColumns = resolveColumns(DETAIL_COLUMNS, spec.columns, DEFAULT_COLUMN_KEYS, REQUIRED_COLUMN_KEYS, spec.columns.length > 0 ? 16 : DEFAULT_COLUMN_KEYS.length);
    if (!spec.includePricing) detailColumns = detailColumns.filter((c) => !PRICING_COLUMN_KEYS.includes(c.key));

    const detailRows = report.lines.map((line) =>
      projectRow(
        {
          wasteDate: line.wasteDate,
          wasteTime: line.wasteTime,
          locationName: line.locationName,
          itemName: line.itemName,
          categoryName: line.categoryName,
          reasonLabel: line.reasonLabel,
          quantity: line.quantity,
          baseUnitCode: line.baseUnitCode,
          unitPrice: line.unitPrice,
          estimatedCost: line.estimatedCost,
          costBasisDate: line.costBasisDate,
          costBasisVendorName: line.costBasisVendorName,
          costBasisDocumentReference: line.costBasisDocumentNumber ?? line.costBasisDocumentId,
          pricingStatus: line.pricingStatus === "priced" ? "Priced" : line.pricingStatus === "unpriced" ? "Price unavailable" : "Not requested",
          pricingLimitation: line.pricingLimitation,
          movementId: line.movementId,
        },
        detailColumns
      )
    );

    const tables: ReportExportTable[] = [
      { sheetName: "Waste Details", title: "Waste Details", columns: detailColumns, rows: detailRows, isPrimaryDetail: true, pdf: { include: true, maxRows: 25 } },
    ];

    if (!spec.grouping || spec.grouping === "by_item") {
      tables.push({
        sheetName: "By Item",
        title: "By Item",
        columns: [
          { key: "itemName", header: "Item", format: "text" },
          { key: "categoryName", header: "Category", format: "text" },
          { key: "wasteQuantity", header: "Waste Quantity", format: "decimal" },
          { key: "baseUnitCode", header: "Base Unit", format: "text" },
          { key: "eventCount", header: "Waste Events", format: "integer" },
          ...(spec.includePricing
            ? [
                { key: "pricedCount", header: "Priced Lines", format: "integer" as const },
                { key: "unpricedCount", header: "Unpriced Lines", format: "integer" as const },
                { key: "estimatedCost", header: "Estimated Waste Cost", format: "currency" as const },
                { key: "priceCoveragePercent", header: "Price Coverage %", format: "percent" as const },
              ]
            : []),
        ],
        rows: report.byItem.map((r) => ({
          itemName: r.itemName,
          categoryName: r.categoryName,
          wasteQuantity: r.wasteQuantity,
          baseUnitCode: r.baseUnitCode,
          eventCount: r.eventCount,
          pricedCount: r.pricedCount,
          unpricedCount: r.unpricedCount,
          estimatedCost: r.estimatedCost,
          priceCoveragePercent: Math.round(r.priceCoveragePercent * 10) / 10,
        })),
        pdf: { include: true, maxRows: 25 },
      });
    }
    if (!spec.grouping || spec.grouping === "by_reason") {
      tables.push({
        sheetName: "By Reason",
        title: "By Reason",
        columns: [
          { key: "reasonLabel", header: "Waste Reason", format: "text" },
          { key: "lineCount", header: "Waste Lines", format: "integer" },
          ...(spec.includePricing
            ? [
                { key: "pricedCount", header: "Priced Lines", format: "integer" as const },
                { key: "unpricedCount", header: "Unpriced Lines", format: "integer" as const },
                { key: "estimatedCost", header: "Estimated Waste Cost", format: "currency" as const },
                { key: "priceCoveragePercent", header: "Price Coverage %", format: "percent" as const },
              ]
            : []),
        ],
        rows: report.byReason.map((r) => ({
          reasonLabel: r.reasonLabel,
          lineCount: r.lineCount,
          pricedCount: r.pricedCount,
          unpricedCount: r.unpricedCount,
          estimatedCost: r.estimatedCost,
          priceCoveragePercent: Math.round(r.priceCoveragePercent * 10) / 10,
        })),
        pdf: { include: true, maxRows: 25 },
      });
    }

    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [
      { label: "Waste Events", value: report.eventCount, format: "integer" },
      { label: "Waste Lines", value: report.lineCount, format: "integer" },
    ];
    if (spec.includePricing) {
      summaryMetrics.push(
        { label: "Priced Lines", value: report.pricedCount, format: "integer" as const },
        { label: "Unpriced Lines", value: report.unpricedCount, format: "integer" as const },
        { label: "Price Coverage", value: Math.round(report.priceCoveragePercent * 10) / 10, format: "percent" as const }
      );
      for (const total of report.currencyTotals) {
        summaryMetrics.push({ label: `Total Estimated Waste Cost (${total.currency})`, value: total.estimatedCost, format: "currency" as const });
      }
      if (report.currencyTotals.length === 0) summaryMetrics.push({ label: "Total Estimated Waste Cost", value: 0, format: "currency" as const });
    }

    const limitations = [...wasteReportDefinition.datasetLimitations];
    if (report.eventCount === 0) limitations.push("No waste was recorded during this period.");
    if (spec.includePricing) limitations.push(DISCLAIMER);

    return {
      summaryMetrics,
      tables,
      isEmpty: report.eventCount === 0,
      recordCount: report.lineCount,
      pricedCount: spec.includePricing ? report.pricedCount : null,
      unpricedCount: spec.includePricing ? report.unpricedCount : null,
      limitations,
    };
  },
};
