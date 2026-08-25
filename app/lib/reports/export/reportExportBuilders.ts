import type { PurchasingReportSummary, PurchasingPriceChanges } from "@/app/lib/reports/purchasingReport";
import type { UsageReport } from "@/app/lib/reports/usageReport";
import type { WasteReport } from "@/app/lib/reports/wasteReport";
import type { ReceivingReport } from "@/app/lib/reports/receivingReport";
import type { InventoryStatusReport } from "@/app/lib/reports/inventoryStatusReport";
import { WASTE_REASON_LABEL } from "@/app/lib/reports/wasteReasonLabels";
import { receivingStatusPresentation } from "@/app/manager/(app)/receiving/_lib/receivingPresentation";
import type { ReceivingItemStatus } from "@/app/lib/documents/documentStatus";
import type { ReportExportDateRange, ReportExportDocument, ReportExportFilterDescriptor } from "./reportExportModel";

/**
 * Reports export foundation -- SINGLE DATA AUTHORITY (Section 4). Every
 * function here takes an ALREADY-fetched, already-authoritative report
 * result -- the exact same object each report page's Server Component
 * already rendered -- and only re-shapes it into the shared
 * ReportExportDocument. Nothing here queries the database, calls an RPC,
 * or recomputes a total; the screen and every export format are
 * guaranteed to agree because they are two views of the identical
 * report-service output.
 */

export interface ExportBuilderContext {
  organizationName: string;
  timeZone: string;
  generatedAt: Date;
  dateRange: ReportExportDateRange | null;
  filters: ReportExportFilterDescriptor[];
}

export function buildPurchasingExportDocument(ctx: ExportBuilderContext, report: PurchasingReportSummary, priceChanges: PurchasingPriceChanges): ReportExportDocument {
  const priceChangeRows = [
    ...priceChanges.increases.map((r) => ({ direction: "Increase", ...r })),
    ...priceChanges.decreases.map((r) => ({ direction: "Decrease", ...r })),
  ];

  return {
    reportType: "purchasing",
    reportTitle: "Purchasing Report",
    organizationName: ctx.organizationName,
    timeZone: ctx.timeZone,
    generatedAt: ctx.generatedAt,
    dateRange: ctx.dateRange,
    filters: ctx.filters,
    summaryMetrics: [
      { label: "Total Purchase Value", value: report.totalPurchaseValue, format: "currency" },
      { label: "Documents", value: report.documentCount, format: "integer" },
      { label: "Vendors", value: report.vendorCount, format: "integer" },
      { label: "Items", value: report.itemCount, format: "integer" },
    ],
    tables: [
      {
        sheetName: "Vendors",
        title: "By Vendor",
        columns: [
          { key: "name", header: "Vendor", format: "text" },
          { key: "totalValue", header: "Total Value", format: "currency" },
        ],
        rows: report.byVendor.map((r) => ({ name: r.name, totalValue: r.totalValue })),
        pdf: { include: true, maxRows: 25 },
      },
      {
        sheetName: "Categories",
        title: "By Category",
        columns: [
          { key: "name", header: "Category", format: "text" },
          { key: "totalValue", header: "Total Value", format: "currency" },
        ],
        rows: report.byCategory.map((r) => ({ name: r.name, totalValue: r.totalValue })),
        pdf: { include: true, maxRows: 25 },
      },
      {
        sheetName: "Items",
        title: "By Item",
        columns: [
          { key: "name", header: "Item", format: "text" },
          { key: "totalValue", header: "Total Value", format: "currency" },
        ],
        rows: report.byItem.map((r) => ({ name: r.name, totalValue: r.totalValue })),
        isPrimaryDetail: true,
        pdf: { include: true, maxRows: 25 },
      },
      {
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
        pdf: { include: true, maxRows: 25 },
      },
    ],
  };
}

export function buildUsageExportDocument(ctx: ExportBuilderContext, report: UsageReport): ReportExportDocument {
  return {
    reportType: "usage",
    reportTitle: "Inventory Usage Report",
    organizationName: ctx.organizationName,
    timeZone: ctx.timeZone,
    generatedAt: ctx.generatedAt,
    dateRange: ctx.dateRange,
    filters: ctx.filters,
    summaryMetrics: [{ label: "Withdrawal Movements", value: report.movementCount, format: "integer" }],
    tables: [
      {
        sheetName: "By Item",
        title: "By Item",
        columns: [
          { key: "itemName", header: "Item", format: "text" },
          { key: "quantity", header: "Quantity", format: "decimal" },
          { key: "baseUnitCode", header: "Unit", format: "text" },
        ],
        rows: report.byItem.map((r) => ({ itemName: r.itemName, quantity: r.quantity, baseUnitCode: r.baseUnitCode })),
        isPrimaryDetail: true,
        pdf: { include: true, maxRows: 25 },
      },
      {
        sheetName: "By Station",
        title: "By Station",
        columns: [
          { key: "stationName", header: "Station", format: "text" },
          { key: "movementCount", header: "Movements", format: "integer" },
        ],
        rows: report.byStation.map((r) => ({ stationName: r.stationName, movementCount: r.movementCount })),
        pdf: { include: true, maxRows: 25 },
      },
    ],
  };
}

export function buildWasteExportDocument(ctx: ExportBuilderContext, report: WasteReport): ReportExportDocument {
  return {
    reportType: "waste",
    reportTitle: "Waste Report",
    organizationName: ctx.organizationName,
    timeZone: ctx.timeZone,
    generatedAt: ctx.generatedAt,
    dateRange: ctx.dateRange,
    filters: ctx.filters,
    summaryMetrics: [{ label: "Waste Events", value: report.eventCount, format: "integer" }],
    tables: [
      {
        sheetName: "By Item",
        title: "Quantity by Item",
        columns: [
          { key: "itemName", header: "Item", format: "text" },
          { key: "quantity", header: "Quantity", format: "decimal" },
          { key: "unitCode", header: "Unit", format: "text" },
        ],
        rows: report.byItem.map((r) => ({ itemName: r.itemName, quantity: r.quantity, unitCode: r.unitCode })),
        isPrimaryDetail: true,
        pdf: { include: true, maxRows: 25 },
      },
      {
        sheetName: "By Reason",
        title: "Events by Reason",
        columns: [
          { key: "reason", header: "Reason", format: "text" },
          { key: "eventCount", header: "Events", format: "integer" },
        ],
        rows: report.byReason.map((r) => ({ reason: WASTE_REASON_LABEL[r.reasonCode] ?? r.reasonCode, eventCount: r.eventCount })),
        pdf: { include: true, maxRows: 25 },
      },
    ],
  };
}

export function buildReceivingExportDocument(ctx: ExportBuilderContext, report: ReceivingReport): ReportExportDocument {
  return {
    reportType: "receiving",
    reportTitle: "Receiving Report",
    organizationName: ctx.organizationName,
    timeZone: ctx.timeZone,
    generatedAt: ctx.generatedAt,
    dateRange: ctx.dateRange,
    filters: ctx.filters,
    summaryMetrics: [
      { label: "Documents", value: report.documentCount, format: "integer" },
      { label: "Ready to Post", value: report.readyToPostCount, format: "integer" },
      { label: "Partially Posted", value: report.partiallyPostedCount, format: "integer" },
      { label: "Posted", value: report.postedCount, format: "integer" },
      { label: "Credit Lines", value: report.creditLineCount, format: "integer" },
    ],
    tables: [
      {
        sheetName: "By Vendor",
        title: "By Vendor",
        columns: [
          { key: "vendorName", header: "Vendor", format: "text" },
          { key: "count", header: "Documents", format: "integer" },
        ],
        rows: report.byVendor.map((r) => ({ vendorName: r.vendorName, count: r.count })),
        isPrimaryDetail: true,
        pdf: { include: true, maxRows: 25 },
      },
      {
        sheetName: "By Status",
        title: "By Status",
        columns: [
          { key: "status", header: "Status", format: "text" },
          { key: "count", header: "Documents", format: "integer" },
        ],
        rows: report.byStatus.map((r) => ({ status: receivingStatusPresentation(r.status as ReceivingItemStatus).label, count: r.count })),
        pdf: { include: true, maxRows: 25 },
      },
    ],
  };
}

export function buildInventoryStatusExportDocument(ctx: ExportBuilderContext, report: InventoryStatusReport): ReportExportDocument {
  return {
    reportType: "inventory-status",
    reportTitle: "Inventory Status Report",
    organizationName: ctx.organizationName,
    timeZone: ctx.timeZone,
    generatedAt: ctx.generatedAt,
    dateRange: null,
    filters: ctx.filters,
    summaryMetrics: [
      { label: "Out of Stock", value: report.outOfStockCount, format: "integer" },
      { label: "Low Stock", value: report.lowStockCount, format: "integer" },
      { label: "Healthy / Above Threshold", value: report.healthyCount, format: "integer" },
    ],
    tables: [
      {
        sheetName: "Low & Out of Stock",
        title: "Low & Out of Stock Items",
        columns: [
          { key: "itemName", header: "Item", format: "text" },
          { key: "locationName", header: "Location", format: "text" },
          { key: "balance", header: "Balance", format: "decimal" },
          { key: "baseUnitCode", header: "Unit", format: "text" },
          { key: "stockLevel", header: "Status", format: "text" },
        ],
        rows: report.rows.map((r) => ({
          itemName: r.itemName,
          locationName: r.locationName,
          balance: r.balance,
          baseUnitCode: r.baseUnitCode,
          stockLevel: r.stockLevel === "EMPTY" ? "Out of Stock" : "Low",
        })),
        isPrimaryDetail: true,
        pdf: { include: true, maxRows: 25 },
      },
    ],
  };
}

export interface OverviewExportInputs {
  purchaseValue: number | null;
  purchaseDocumentCount: number | null;
  receivingDocumentCount: number | null;
  readyToPostCount: number | null;
  partiallyPostedCount: number | null;
  lowStockCount: number | null;
  outOfStockCount: number | null;
  withdrawalMovementCount: number | null;
  wasteEventCount: number | null;
}

/** Overview has no breakdown tables of its own on screen (Section 17: "a
 * concise Overview export is acceptable") -- every number here is one of
 * the exact same metrics the Overview cards already show, composed from
 * the same five report actions, never a new computation. The one table
 * exists only so CSV (which can only represent one flat dataset) has
 * something to export; the Summary sheet -- present in every export --
 * already carries these same values as real numeric/currency cells. */
export function buildOverviewExportDocument(ctx: ExportBuilderContext, inputs: OverviewExportInputs): ReportExportDocument {
  const metricRows: { metric: string; value: string }[] = [];
  const summaryMetrics: ReportExportDocument["summaryMetrics"] = [];

  function addMetric(label: string, value: number | null, format: "currency" | "integer") {
    if (value === null) return;
    summaryMetrics.push({ label, value, format });
    metricRows.push({ metric: label, value: format === "currency" ? value.toLocaleString(undefined, { style: "currency", currency: "USD" }) : String(value) });
  }

  addMetric("Purchase Value", inputs.purchaseValue, "currency");
  addMetric("Purchasing Documents", inputs.purchaseDocumentCount, "integer");
  addMetric("Receiving Documents Processed", inputs.receivingDocumentCount, "integer");
  addMetric("Ready to Post", inputs.readyToPostCount, "integer");
  addMetric("Partially Posted", inputs.partiallyPostedCount, "integer");
  addMetric("Low Stock", inputs.lowStockCount, "integer");
  addMetric("Out of Stock", inputs.outOfStockCount, "integer");
  addMetric("Withdrawal Movements", inputs.withdrawalMovementCount, "integer");
  addMetric("Waste Events", inputs.wasteEventCount, "integer");

  return {
    reportType: "overview",
    reportTitle: "Reports Overview",
    organizationName: ctx.organizationName,
    timeZone: ctx.timeZone,
    generatedAt: ctx.generatedAt,
    dateRange: ctx.dateRange,
    filters: ctx.filters,
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
  };
}
