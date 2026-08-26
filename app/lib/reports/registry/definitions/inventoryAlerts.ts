import "server-only";
import { listHighWithdrawalAlertsAction } from "@/app/actions/inventoryAlerts";
import { resolveInventoryItemByName, resolveStationByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveHistoricalUnitCostsForItem } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";
import type { ReportExportTable } from "@/app/lib/reports/export/reportExportModel";

/**
 * General Report Builder -- Inventory Alerts report definition.
 * High-Withdrawal Alerts are informational records only (never an
 * approval/pending-review workflow -- see listHighWithdrawalAlertsAction's
 * own doc comment). This system currently tracks exactly ONE alert type
 * with no severity classification, so "alert type"/"severity" filters
 * are not registered -- there is nothing to filter by yet.
 *
 * listHighWithdrawalAlertsAction() re-authenticates internally (it is a
 * Server Action, not a plain data function) -- this mirrors the EXACT
 * same pattern the existing get_inventory_alerts chat tool already uses,
 * not a new inconsistency introduced here.
 */

const MAX_EXPORT_ALERT_ROWS = 5000;

const COLUMNS: ReportColumnDefinition[] = [
  { key: "occurredAt", header: "Occurred", format: "text" },
  { key: "itemName", header: "Item", format: "text" },
  { key: "stationName", header: "Station", format: "text" },
  { key: "employeeName", header: "Employee", format: "text" },
  { key: "sourceLocationName", header: "Source Location", format: "text" },
  { key: "observedQuantity", header: "Observed Quantity", format: "decimal" },
  { key: "thresholdQuantity", header: "Threshold Quantity", format: "decimal" },
  { key: "unitCode", header: "Unit", format: "text" },
  { key: "unitPrice", header: "Verified Unit Purchase Price", format: "currency" },
  { key: "estimatedValue", header: "Estimated Withdrawal Value", format: "currency" },
  { key: "pricingStatus", header: "Pricing Status", format: "text" },
  { key: "status", header: "Status", format: "text" },
];
const DEFAULT_COLUMN_KEYS = ["occurredAt", "itemName", "stationName", "employeeName", "observedQuantity", "thresholdQuantity", "unitCode", "status"];
const REQUIRED_COLUMN_KEYS = ["occurredAt", "itemName", "stationName", "observedQuantity"];
const PRICING_COLUMN_KEYS = ["unitPrice", "estimatedValue", "pricingStatus"];

export const inventoryAlertsReportDefinition: ReportDefinition = {
  id: "inventory_alerts",
  name: "Inventory Alerts Report",
  datasetDescription: "High-Withdrawal Inventory Alerts -- informational records only, never an approval or pending-review workflow.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [
    { key: "item", label: "Item", kind: "lookup", description: "An inventory item name.", resolve: (ctx, raw) => resolveInventoryItemByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "station", label: "Station", kind: "lookup", description: "A station name.", resolve: (ctx, raw) => resolveStationByName(ctx.supabase, ctx.organizationId, raw) },
  ],
  requiredFilterKeys: [],
  groupings: [
    { key: "by_item", label: "By Item" },
    { key: "by_station", label: "By Station" },
  ],
  defaultGrouping: null,
  columns: COLUMNS,
  defaultColumnKeys: DEFAULT_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_COLUMN_KEYS,
  maxColumns: 12,
  pricingMode: "estimated",
  datasetLimitations: [
    "This system currently tracks only one alert type (High-Withdrawal) with no severity classification -- alert-type and severity filters do not apply.",
    "These are informational records only -- never an approval, acknowledgement, or pending-review workflow.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const result = await listHighWithdrawalAlertsAction();
    if (!result.ok) {
      return { summaryMetrics: [], tables: [], isEmpty: true, recordCount: 0, pricedCount: null, unpricedCount: null, limitations: ["Could not load Inventory Alerts."] };
    }
    if (result.alerts.length > MAX_EXPORT_ALERT_ROWS) {
      return {
        summaryMetrics: [],
        tables: [],
        isEmpty: true,
        recordCount: 0,
        pricedCount: null,
        unpricedCount: null,
        limitations: [`This organization has more than ${MAX_EXPORT_ALERT_ROWS} alerts -- narrow the date range and try again.`],
      };
    }

    const itemFilter = spec.filters.find((f) => f.key === "item");
    const stationFilter = spec.filters.find((f) => f.key === "station");
    const alerts = result.alerts
      .filter((a) => {
        const occurredDate = a.occurredAt.slice(0, 10);
        return occurredDate >= spec.dateRange.startDate && occurredDate <= spec.dateRange.endDate;
      })
      .filter((a) => !itemFilter || a.itemId === itemFilter.id)
      .filter((a) => !stationFilter || a.stationId === stationFilter.id);

    let columns = resolveColumns(COLUMNS, spec.columns, DEFAULT_COLUMN_KEYS, REQUIRED_COLUMN_KEYS, 12);
    if (!spec.includePricing) columns = columns.filter((c) => !PRICING_COLUMN_KEYS.includes(c.key));

    let pricedCount: number | null = null;
    let unpricedCount: number | null = null;
    const priceByAlertId = new Map<string, number | null>();
    if (spec.includePricing && alerts.length > 0) {
      pricedCount = 0;
      unpricedCount = 0;
      const alertsByItemId = new Map<string, typeof alerts>();
      for (const alert of alerts) {
        if (!alertsByItemId.has(alert.itemId)) alertsByItemId.set(alert.itemId, []);
        alertsByItemId.get(alert.itemId)!.push(alert);
      }
      for (const [itemId, itemAlerts] of alertsByItemId) {
        const asOfDates = itemAlerts.map((a) => a.occurredAt.slice(0, 10));
        const priceByAsOf = await resolveHistoricalUnitCostsForItem({ supabase: ctx.supabase, organizationId: ctx.organizationId }, itemId, itemAlerts[0].unitCode, asOfDates);
        itemAlerts.forEach((alert, index) => {
          const outcome = priceByAsOf.get(asOfDates[index]);
          if (outcome && outcome.status === "resolved") {
            priceByAlertId.set(alert.exceptionId, outcome.price.unitCostPerBaseUnit);
            pricedCount! += 1;
          } else {
            priceByAlertId.set(alert.exceptionId, null);
            unpricedCount! += 1;
          }
        });
      }
    }

    const detailTable: ReportExportTable = {
      sheetName: "Alerts",
      title: "High-Withdrawal Alerts",
      columns,
      rows: alerts.map((a) => {
        const unitPrice = priceByAlertId.get(a.exceptionId) ?? null;
        return projectRow(
          {
            occurredAt: a.occurredAt,
            itemName: a.itemName,
            stationName: a.stationName,
            employeeName: a.employeeName,
            sourceLocationName: a.sourceLocationName,
            observedQuantity: a.observedQuantity,
            thresholdQuantity: a.thresholdQuantity,
            unitCode: a.unitCode,
            unitPrice,
            estimatedValue: unitPrice !== null ? unitPrice * a.observedQuantity : null,
            pricingStatus: !spec.includePricing ? "Not requested" : unitPrice !== null ? "Priced" : "Price unavailable",
            status: a.status,
          },
          columns
        );
      }),
      isPrimaryDetail: true,
      pdf: { include: true, maxRows: 25 },
    };

    const tables: ReportExportTable[] = [detailTable];
    if (spec.grouping === "by_item" || spec.grouping === "by_station") {
      const keyOf = spec.grouping === "by_item" ? (a: (typeof alerts)[number]) => a.itemName : (a: (typeof alerts)[number]) => a.stationName;
      const map = new Map<string, number>();
      for (const a of alerts) map.set(keyOf(a), (map.get(keyOf(a)) ?? 0) + 1);
      tables.push({
        sheetName: spec.grouping === "by_item" ? "By Item" : "By Station",
        title: spec.grouping === "by_item" ? "By Item" : "By Station",
        columns: [
          { key: "name", header: spec.grouping === "by_item" ? "Item" : "Station", format: "text" },
          { key: "alertCount", header: "Alerts", format: "integer" },
        ],
        rows: Array.from(map.entries()).map(([name, alertCount]) => ({ name, alertCount })),
        pdf: { include: true, maxRows: 25 },
      });
    }

    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [{ label: "Alerts", value: alerts.length, format: "integer" }];
    if (spec.includePricing) {
      const totalEstimatedValue = alerts.reduce((sum, a) => {
        const price = priceByAlertId.get(a.exceptionId);
        return price !== null && price !== undefined ? sum + price * a.observedQuantity : sum;
      }, 0);
      summaryMetrics.push(
        { label: "Priced Alerts", value: pricedCount ?? 0, format: "integer" },
        { label: "Unpriced Alerts", value: unpricedCount ?? 0, format: "integer" },
        { label: "Total Estimated Withdrawal Value", value: totalEstimatedValue, format: "currency" }
      );
    }

    const limitations = [...inventoryAlertsReportDefinition.datasetLimitations];
    if (alerts.length === 0) limitations.push("No alerts matched this request.");
    if (spec.includePricing) {
      limitations.push("Estimated values use eligible verified purchase prices and are operational estimates, not accounting inventory valuation, landed cost or COGS.");
    }

    return {
      summaryMetrics,
      tables,
      isEmpty: alerts.length === 0,
      recordCount: alerts.length,
      pricedCount,
      unpricedCount,
      limitations,
    };
  },
};
