import "server-only";
import { listVerifiedPurchaseHistoryForItem } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";
import { resolveInventoryItemByName, resolveVendorByName } from "@/app/lib/reports/registry/filterResolvers";
import { resolveColumns, projectRow } from "@/app/lib/reports/registry/resolveColumns";
import type { ReportColumnDefinition, ReportDefinition, ReportLoadResult } from "@/app/lib/reports/registry/types";

/**
 * General Report Builder -- Item Cost History report definition. A
 * resolved item is REQUIRED (Section 12) -- this report has no
 * meaningful organization-wide form. Reuses listVerifiedPurchaseHistoryForItem
 * (itemPurchaseCost.ts), the SAME hardened discovery/completeness/
 * revision-safety pipeline as get_item_purchase_cost -- never a separate,
 * looser calculation for this report.
 */

const COLUMNS: ReportColumnDefinition[] = [
  { key: "documentDate", header: "Purchase Date", format: "date" },
  { key: "vendorName", header: "Vendor", format: "text" },
  { key: "documentNumber", header: "Document Number", format: "text" },
  { key: "packageQuantity", header: "Package Quantity", format: "decimal" },
  { key: "packageUnit", header: "Package Unit", format: "text" },
  { key: "lineTotal", header: "Verified Line Amount", format: "currency" },
  { key: "baseQuantity", header: "Base Quantity", format: "decimal" },
  { key: "baseUnitCode", header: "Base Unit", format: "text" },
  { key: "unitCostPerBaseUnit", header: "Normalized Unit Cost", format: "currency" },
  { key: "currency", header: "Currency", format: "text" },
];
const DEFAULT_COLUMN_KEYS = COLUMNS.map((c) => c.key);
const REQUIRED_COLUMN_KEYS = ["documentDate", "vendorName", "lineTotal", "baseUnitCode", "unitCostPerBaseUnit"];

export const itemCostHistoryReportDefinition: ReportDefinition = {
  id: "item_cost_history",
  name: "Item Cost History Report",
  datasetDescription: "Every verified, fully-posted purchase line for ONE named item, newest first, normalized to a per-base-unit cost.",
  supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"],
  isPointInTime: false,
  maxRangeDays: 90,
  filters: [
    { key: "item", label: "Item", kind: "lookup", description: "An inventory item name (required).", resolve: (ctx, raw) => resolveInventoryItemByName(ctx.supabase, ctx.organizationId, raw) },
    { key: "vendor", label: "Vendor", kind: "lookup", description: "A vendor name.", resolve: (ctx, raw) => resolveVendorByName(ctx.supabase, ctx.organizationId, raw) },
  ],
  requiredFilterKeys: ["item"],
  groupings: [],
  defaultGrouping: null,
  columns: COLUMNS,
  defaultColumnKeys: DEFAULT_COLUMN_KEYS,
  requiredColumnKeys: REQUIRED_COLUMN_KEYS,
  maxColumns: 10,
  pricingMode: "actual",
  datasetLimitations: [
    "Requires a single resolved item -- this report has no organization-wide form.",
    "Reflects the verified purchase line amount only -- excludes unallocated document-level tax, freight, or other charges.",
    "Only purchases that were verified, fully posted, and belong to the current document revision are included.",
  ],
  async loadReport(ctx, spec): Promise<ReportLoadResult> {
    const itemFilter = spec.filters.find((f) => f.key === "item");
    const vendorFilter = spec.filters.find((f) => f.key === "vendor");
    if (!itemFilter) {
      return { summaryMetrics: [], tables: [], isEmpty: true, recordCount: 0, pricedCount: null, unpricedCount: null, limitations: ["An item is required for this report."] };
    }

    const { data: itemRow } = await ctx.supabase.from("inventory_items").select("id, base_unit_id").eq("id", itemFilter.id).eq("organization_id", ctx.organizationId).maybeSingle();
    if (!itemRow) {
      return { summaryMetrics: [], tables: [], isEmpty: true, recordCount: 0, pricedCount: null, unpricedCount: null, limitations: ["The requested item could not be found."] };
    }
    const { data: unitRow } = await ctx.supabase.from("units").select("code").eq("id", itemRow.base_unit_id as string).maybeSingle();
    const baseUnitCode = (unitRow?.code as string | undefined) ?? "unit";

    const result = await listVerifiedPurchaseHistoryForItem(
      { supabase: ctx.supabase, organizationId: ctx.organizationId },
      itemFilter.id,
      baseUnitCode,
      { vendorId: vendorFilter?.id ?? null, startDate: spec.dateRange.startDate, endDate: spec.dateRange.endDate }
    );

    if (result.status === "incomplete") {
      return { summaryMetrics: [], tables: [], isEmpty: true, recordCount: 0, pricedCount: null, unpricedCount: null, limitations: [result.reason] };
    }

    const columns = resolveColumns(COLUMNS, spec.columns, DEFAULT_COLUMN_KEYS, REQUIRED_COLUMN_KEYS, 10);
    const rows = result.rows.map((r) =>
      projectRow(
        {
          documentDate: r.documentDate,
          vendorName: r.vendorName,
          documentNumber: r.documentNumber,
          packageQuantity: r.packageQuantity,
          packageUnit: r.packageUnit,
          lineTotal: r.lineTotal,
          baseQuantity: r.baseQuantity,
          baseUnitCode: r.baseUnitCode,
          unitCostPerBaseUnit: r.unitCostPerBaseUnit,
          currency: r.currency,
        },
        columns
      )
    );

    const currencies = new Set(result.rows.map((r) => r.currency));
    const summaryMetrics: ReportLoadResult["summaryMetrics"] = [
      { label: "Item", value: itemFilter.name, format: "text" },
      { label: "Verified Purchase Lines", value: result.rows.length, format: "integer" },
    ];
    if (result.rows.length > 0) {
      summaryMetrics.push(
        { label: "Latest Purchase Date", value: result.rows[0].documentDate, format: "date" },
        { label: "Latest Normalized Unit Cost", value: result.rows[0].unitCostPerBaseUnit, format: "currency" }
      );
    }

    const limitations = [...itemCostHistoryReportDefinition.datasetLimitations];
    if (result.rows.length === 0) limitations.push("No verified purchase history was found for this item in the requested range.");
    if (currencies.size > 1) limitations.push("This item has verified purchases in more than one currency -- amounts are shown per line in their own currency, never combined into one total.");

    return {
      summaryMetrics,
      tables: [{ sheetName: "Purchase History", title: "Purchase History", columns, rows, isPrimaryDetail: true, pdf: { include: true, maxRows: 25 } }],
      isEmpty: result.rows.length === 0,
      recordCount: result.rows.length,
      pricedCount: null,
      unpricedCount: null,
      limitations,
    };
  },
};
