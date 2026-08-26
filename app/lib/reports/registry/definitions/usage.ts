import "server-only";
import { getUsageReport } from "@/app/lib/reports/usageReport";
import { resolveInventoryItemByName, resolveStationByName, resolveLocationByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveHistoricalUnitCostsForItem } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";
import type { ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- Usage (station withdrawal) report
 * definition. get_inventory_usage_report exposes By Item/By Station
 * aggregate totals over the requested period only -- there is no bulk,
 * date-ranged per-withdrawal-event listing available (the one per-item
 * activity feed, list_inventory_item_activity, is scoped to a single
 * item+location for its own detail-page use, not safe for a bulk,
 * org-wide report). Estimated pricing here therefore prices the PERIOD
 * TOTAL for each item using the latest eligible verified price as of the
 * period's end date -- a single as-of point for the whole aggregate, NOT
 * a per-withdrawal-event historical price (which the data cannot
 * support) -- and this distinction is always stated plainly rather than
 * implied to be more precise than it is.
 */

const ITEM_COLUMNS: ReportColumnDefinition[] = [
  { key: "itemName", header: "Item", format: "text" },
  { key: "quantity", header: "Quantity", format: "decimal" },
  { key: "baseUnitCode", header: "Unit", format: "text" },
  { key: "unitPrice", header: "Verified Unit Purchase Price (as of period end)", format: "currency" },
  { key: "estimatedCost", header: "Estimated Usage Cost", format: "currency" },
  { key: "pricingStatus", header: "Pricing Status", format: "text" },
];
const DEFAULT_ITEM_COLUMN_KEYS = ["itemName", "quantity", "baseUnitCode"];
const REQUIRED_ITEM_COLUMN_KEYS = ["itemName", "quantity", "baseUnitCode"];
const PRICING_COLUMN_KEYS = ["unitPrice", "estimatedCost", "pricingStatus"];

const STATION_COLUMNS: ReportColumnDefinition[] = [
  { key: "stationName", header: "Station", format: "text" },
  { key: "movementCount", header: "Withdrawals", format: "integer" },
];

export const usageReportDefinition: ReportDefinition = {
  id: "usage",
  name: "Inventory Usage Report",
  datasetDescription: "Station withdrawals (inventory sent from storage to a station) -- never sales/consumption, which this system does not track.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [
    { key: "item", label: "Item", kind: "lookup", description: "An inventory item name.", resolve: (ctx, raw) => resolveInventoryItemByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "station", label: "Station", kind: "lookup", description: "A station name.", resolve: (ctx, raw) => resolveStationByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "location", label: "Source Location", kind: "lookup", description: "A source storage location name.", resolve: (ctx, raw) => resolveLocationByName(ctx.supabase, ctx.organizationId, raw) },
  ],
  requiredFilterKeys: [],
  groupings: [
    { key: "by_item", label: "By Item" },
    { key: "by_station", label: "By Station" },
  ],
  defaultGrouping: null,
  columns: ITEM_COLUMNS,
  defaultColumnKeys: DEFAULT_ITEM_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_ITEM_COLUMN_KEYS,
  maxColumns: 6,
  pricingMode: "estimated",
  datasetLimitations: [
    "Provides item and station aggregate totals only -- per-withdrawal-event transaction detail is not currently exposed as a bulk, date-ranged dataset.",
    "Estimated usage cost prices each item's PERIOD TOTAL quantity using the latest eligible verified purchase price as of the period's end date -- not a per-withdrawal-event historical price.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const itemFilter = spec.filters.find((f) => f.key === "item");
    const stationFilter = spec.filters.find((f) => f.key === "station");
    const locationFilter = spec.filters.find((f) => f.key === "location");

    const report = await getUsageReport(ctx.supabase, ctx.organizationId, spec.dateRange.startDate, spec.dateRange.endDate, {
      inventoryItemId: itemFilter?.id ?? null,
      stationId: stationFilter?.id ?? null,
      locationId: locationFilter?.id ?? null,
    });

    let itemColumns = resolveColumns(ITEM_COLUMNS, spec.columns, DEFAULT_ITEM_COLUMN_KEYS, REQUIRED_ITEM_COLUMN_KEYS, 6);
    if (!spec.includePricing) itemColumns = itemColumns.filter((c) => !PRICING_COLUMN_KEYS.includes(c.key));

    let pricedCount: number | null = null;
    let unpricedCount: number | null = null;
    const priceByItemId = new Map<string, { unitPrice: number; estimatedCost: number } | null>();
    if (spec.includePricing && report.byItem.length > 0) {
      pricedCount = 0;
      unpricedCount = 0;
      for (const item of report.byItem) {
        const priceByAsOf = await resolveHistoricalUnitCostsForItem({ supabase: ctx.supabase, organizationId: ctx.organizationId }, item.itemId, item.baseUnitCode, [spec.dateRange.endDate]);
        const outcome = priceByAsOf.get(spec.dateRange.endDate);
        if (outcome && outcome.status === "resolved") {
          priceByItemId.set(item.itemId, { unitPrice: outcome.price.unitCostPerBaseUnit, estimatedCost: item.quantity * outcome.price.unitCostPerBaseUnit });
          pricedCount += 1;
        } else {
          priceByItemId.set(item.itemId, null);
          unpricedCount += 1;
        }
      }
    }

    const tables: ReportExportTable[] = [];
    const includeAll = !spec.grouping;
    if (includeAll || spec.grouping === "by_item") {
      tables.push({
        sheetName: "By Item",
        title: "By Item",
        columns: itemColumns,
        rows: report.byItem.map((r) => {
          const priced = priceByItemId.get(r.itemId);
          return projectRow(
            {
              itemName: r.itemName,
              quantity: r.quantity,
              baseUnitCode: r.baseUnitCode,
              unitPrice: priced?.unitPrice ?? null,
              estimatedCost: priced?.estimatedCost ?? null,
              pricingStatus: !spec.includePricing ? "Not requested" : priced ? "Priced" : "Price unavailable",
            },
            itemColumns
          );
        }),
        isPrimaryDetail: true,
        pdf: { include: true, maxRows: 25 },
      });
    }
    if (includeAll || spec.grouping === "by_station") {
      tables.push({
        sheetName: "By Station",
        title: "By Station",
        columns: STATION_COLUMNS,
        rows: report.byStation.map((r) => ({ stationName: r.stationName, movementCount: r.movementCount })),
        isPrimaryDetail: tables.length === 0,
        pdf: { include: true, maxRows: 25 },
      });
    }

    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [{ label: "Withdrawal Movements", value: report.movementCount, format: "integer" }];
    if (spec.includePricing) {
      const totalEstimatedCost = Array.from(priceByItemId.values()).reduce((sum, p) => sum + (p?.estimatedCost ?? 0), 0);
      summaryMetrics.push(
        { label: "Priced Items", value: pricedCount ?? 0, format: "integer" },
        { label: "Unpriced Items", value: unpricedCount ?? 0, format: "integer" },
        { label: "Total Estimated Usage Cost", value: totalEstimatedCost, format: "currency" }
      );
    }

    const limitations = [...usageReportDefinition.datasetLimitations];
    if (report.movementCount === 0) limitations.push("No withdrawal activity was recorded during this period.");
    if (spec.includePricing) {
      limitations.push(
        "Estimated costs use eligible verified purchase prices and are operational estimates, not accounting inventory valuation, landed cost or COGS."
      );
    }

    return {
      summaryMetrics,
      tables,
      isEmpty: report.movementCount === 0,
      recordCount: report.movementCount,
      pricedCount,
      unpricedCount,
      limitations,
    };
  },
};
