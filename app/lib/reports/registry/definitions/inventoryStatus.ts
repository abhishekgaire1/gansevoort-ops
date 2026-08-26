import "server-only";
import { getInventoryStatusReport } from "@/app/lib/reports/inventoryStatusReport";
import { resolveInventoryCategoryByName, resolveLocationByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveHistoricalUnitCostsForItem } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";
import type { ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- Inventory Status report definition. Current
 * balances only (list_inventory_balances) -- this codebase has no
 * historical balance snapshot table, so this report is ALWAYS
 * point-in-time; it never pretends to reconstruct a past balance.
 * Estimated value uses the latest eligible verified purchase price AS OF
 * report-generation time (Section 13), one resolution per distinct item.
 */

const COLUMNS: ReportColumnDefinition[] = [
  { key: "itemName", header: "Item", format: "text" },
  { key: "locationName", header: "Location", format: "text" },
  { key: "balance", header: "Balance", format: "decimal" },
  { key: "baseUnitCode", header: "Unit", format: "text" },
  { key: "stockLevel", header: "Status", format: "text" },
  { key: "unitPrice", header: "Verified Unit Purchase Price (current)", format: "currency" },
  { key: "estimatedValue", header: "Estimated Value", format: "currency" },
  { key: "pricingStatus", header: "Pricing Status", format: "text" },
];
const DEFAULT_COLUMN_KEYS = ["itemName", "locationName", "balance", "baseUnitCode", "stockLevel"];
const REQUIRED_COLUMN_KEYS = ["itemName", "locationName", "balance", "baseUnitCode"];
const PRICING_COLUMN_KEYS = ["unitPrice", "estimatedValue", "pricingStatus"];

export const inventoryStatusReportDefinition: ReportDefinition = {
  id: "inventory_status",
  name: "Inventory Status Report",
  datasetDescription: "Current low-stock and out-of-stock inventory balances, by item and location -- a point-in-time snapshot, not a historical trend.",
  supportedDateKinds: ["point_in_time"],
  isPointInTime: true,
  maxRangeDays: null,
  filters: [
    { key: "category", label: "Category", kind: "lookup", description: "An inventory category name.", resolve: (ctx, raw) => resolveInventoryCategoryByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "location", label: "Location", kind: "lookup", description: "A storage location name.", resolve: (ctx, raw) => resolveLocationByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "stockLevel", label: "Stock Level", kind: "enum", description: "LOW or EMPTY (out of stock).", allowedValues: ["LOW", "EMPTY"] },
  ],
  requiredFilterKeys: [],
  groupings: [],
  defaultGrouping: null,
  columns: COLUMNS,
  defaultColumnKeys: DEFAULT_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_COLUMN_KEYS,
  maxColumns: 8,
  pricingMode: "estimated",
  datasetLimitations: [
    "This system has no historical balance snapshot table -- Inventory Status is always a CURRENT, point-in-time report, never a past-date reconstruction.",
    "Only reports items currently Low or Out of Stock -- matches the on-screen Inventory Status report's own convention, never a full item listing.",
    "Estimated value uses the latest eligible verified purchase price as of report generation time -- an operational estimate, not an accounting inventory valuation.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const categoryFilter = spec.filters.find((f) => f.key === "category");
    const locationFilter = spec.filters.find((f) => f.key === "location");
    const stockLevelFilter = spec.filters.find((f) => f.key === "stockLevel");

    const report = await getInventoryStatusReport(ctx.supabase, ctx.organizationId, { locationId: locationFilter?.id ?? null, categoryId: categoryFilter?.id ?? null });
    const rows = stockLevelFilter ? report.rows.filter((r) => r.stockLevel === stockLevelFilter.id) : report.rows;

    let columns = resolveColumns(COLUMNS, spec.columns, DEFAULT_COLUMN_KEYS, REQUIRED_COLUMN_KEYS, 8);
    if (!spec.includePricing) columns = columns.filter((c) => !PRICING_COLUMN_KEYS.includes(c.key));

    let pricedCount: number | null = null;
    let unpricedCount: number | null = null;
    const priceByItemId = new Map<string, number | null>();
    if (spec.includePricing && rows.length > 0) {
      pricedCount = 0;
      unpricedCount = 0;
      const asOf = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ctx.now);
      const distinctItemIds = Array.from(new Set(rows.map((r) => r.inventoryItemId)));
      for (const itemId of distinctItemIds) {
        const row = rows.find((r) => r.inventoryItemId === itemId)!;
        const priceByAsOf = await resolveHistoricalUnitCostsForItem({ supabase: ctx.supabase, organizationId: ctx.organizationId }, itemId, row.baseUnitCode, [asOf]);
        const outcome = priceByAsOf.get(asOf);
        if (outcome && outcome.status === "resolved") {
          priceByItemId.set(itemId, outcome.price.unitCostPerBaseUnit);
          pricedCount += 1;
        } else {
          priceByItemId.set(itemId, null);
          unpricedCount += 1;
        }
      }
    }

    const totalTable: ReportExportTable = {
      sheetName: "Low & Out of Stock",
      title: "Low & Out of Stock Items",
      columns,
      rows: rows.map((r) => {
        const unitPrice = priceByItemId.get(r.inventoryItemId) ?? null;
        return projectRow(
          {
            itemName: r.itemName,
            locationName: r.locationName,
            balance: r.balance,
            baseUnitCode: r.baseUnitCode,
            stockLevel: r.stockLevel === "EMPTY" ? "Out of Stock" : "Low",
            unitPrice,
            estimatedValue: unitPrice !== null ? unitPrice * r.balance : null,
            pricingStatus: !spec.includePricing ? "Not requested" : unitPrice !== null ? "Priced" : "Price unavailable",
          },
          columns
        );
      }),
      isPrimaryDetail: true,
      pdf: { include: true, maxRows: 25 },
    };

    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [
      { label: "Out of Stock", value: report.outOfStockCount, format: "integer" },
      { label: "Low Stock", value: report.lowStockCount, format: "integer" },
    ];
    if (spec.includePricing) {
      const totalEstimatedValue = Array.from(priceByItemId.entries()).reduce((sum, [itemId, price]) => {
        if (price === null) return sum;
        const itemRows = rows.filter((r) => r.inventoryItemId === itemId);
        return sum + itemRows.reduce((s, r) => s + price * r.balance, 0);
      }, 0);
      summaryMetrics.push(
        { label: "Priced Items", value: pricedCount ?? 0, format: "integer" },
        { label: "Unpriced Items", value: unpricedCount ?? 0, format: "integer" },
        { label: "Total Estimated Value", value: totalEstimatedValue, format: "currency" }
      );
    }

    const limitations = [...inventoryStatusReportDefinition.datasetLimitations];
    if (rows.length === 0) limitations.push("No low or out-of-stock items were found.");
    if (spec.includePricing) {
      limitations.push("Estimated value uses the latest eligible verified purchase price -- an operational estimate, not an accounting inventory valuation, landed cost or COGS.");
    }

    return {
      summaryMetrics,
      tables: [totalTable],
      isEmpty: rows.length === 0,
      recordCount: rows.length,
      pricedCount,
      unpricedCount,
      limitations,
    };
  },
};
