import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listInventoryBalances } from "@/app/lib/inventory/listInventoryBalances";
import { computeStockGauge, STOCK_LEVEL_LABEL } from "@/app/lib/inventory/stockLevel";
import { getPurchasingReport } from "@/app/lib/reports/purchasingReport";
import { getReceivingReport } from "@/app/lib/reports/receivingReport";
import { getUsageReport } from "@/app/lib/reports/usageReport";
import { getWasteReport } from "@/app/lib/reports/wasteReport";
import { listCycleCountSummaries } from "@/app/lib/inventory/cycleCounts";
import { listHighWithdrawalAlertsAction } from "@/app/actions/inventoryAlerts";
import { resolveReportPeriod } from "@/app/manager/(app)/reports/_lib/reportPeriod";
import { makeEvidence } from "@/app/lib/ai/tasks/chat/evidence";
import { lookupItemPurchaseCost } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";
import { getReportDefinition } from "@/app/lib/reports/registry";
import { resolveDateRequest } from "@/app/lib/reports/registry/resolveDateRequest";
import { resolveColumns, unsupportedColumnKeys } from "@/app/lib/reports/registry/resolveColumns";
import { REPORT_IDS, DATE_REQUEST_KINDS, type ResolvedReportFilter, type ResolvedReportSpecification } from "@/app/lib/reports/registry/types";
import type { AskGansevoortResolvedPeriod, ChatDownload, ChatEvidence, ChatToolName } from "@/app/lib/ai/tasks/chat/contract";

/**
 * The explicit, read-only tool allowlist (Section 8/9). Every tool:
 *   - takes trusted organizationId/timeZone/now from the server-resolved
 *     ChatToolContext, never from the model or a client-supplied field
 *     (arg schemas below have no organizationId/id field at all -- see
 *     each z.strictObject());
 *   - reuses an existing authoritative report/data function, never
 *     recomputes a financial or quantity calculation itself;
 *   - enforces its own row cap and (where applicable) restricts the date
 *     period to TODAY/7D/30D -- well under Section 9's 90-day ceiling;
 *   - returns a plain-text `dataText` block (the ONLY thing the model's
 *     synthesis step reads back) plus server-built ChatEvidence objects
 *     the model never constructs itself.
 */

const MAX_ROWS = 50;
const PERIOD_KEY = z.enum(["TODAY", "7D", "30D"]);

export interface ChatToolContext {
  supabase: SupabaseClient;
  organizationId: string;
  currentActorAppUserId: string;
  timeZone: string;
  now: Date;
}

export type ToolExecutionResult =
  | { ok: true; dataText: string; evidence: ChatEvidence[]; period: AskGansevoortResolvedPeriod | null; insufficientData: boolean; downloads?: ChatDownload[] }
  | { ok: false; message: string };

interface ToolDefinition<TArgs> {
  name: ChatToolName;
  argsSchema: z.ZodType<TArgs>;
  execute: (ctx: ChatToolContext, args: TArgs) => Promise<ToolExecutionResult>;
}

function resolvedPeriod(ctx: ChatToolContext, periodKey: "TODAY" | "7D" | "30D" | undefined): AskGansevoortResolvedPeriod {
  const period = resolveReportPeriod(ctx.now, ctx.timeZone, periodKey ?? "7D", undefined, undefined);
  return { key: period.key === "CUSTOM" ? "7D" : period.key, startDate: period.startDate, endDate: period.endDate };
}

// ------------------------------------------------------------------
// A. get_inventory_status
// ------------------------------------------------------------------
const inventoryStatusArgs = z
  .object({
    itemNameContains: z.string().max(120).optional(),
    locationNameContains: z.string().max(120).optional(),
    onlyAttention: z.boolean().optional(),
  })
  .strict();

const getInventoryStatus: ToolDefinition<z.infer<typeof inventoryStatusArgs>> = {
  name: "get_inventory_status",
  argsSchema: inventoryStatusArgs,
  async execute(ctx, args) {
    const balances = await listInventoryBalances(ctx.supabase, ctx.organizationId);
    const nameFilter = args.itemNameContains?.trim().toLowerCase();
    const locationFilter = args.locationNameContains?.trim().toLowerCase();

    const rows = balances
      .filter((b) => !nameFilter || b.itemName.toLowerCase().includes(nameFilter))
      .filter((b) => !locationFilter || b.locationName.toLowerCase().includes(locationFilter))
      .map((b) => ({ ...b, gauge: computeStockGauge(b.balance, b.fullReferenceQuantity) }))
      .filter((b) => !args.onlyAttention || b.gauge.level === "LOW" || b.gauge.level === "EMPTY")
      .slice(0, MAX_ROWS);

    const asOf = ctx.now.toISOString();
    if (rows.length === 0) {
      return { ok: true, dataText: "No matching inventory balance rows were found.", evidence: [], period: null, insufficientData: true };
    }

    const lines = rows.map(
      (r) => `- ${r.itemName} @ ${r.locationName}: ${r.balance} ${r.baseUnitCode} (${r.gauge.level ? STOCK_LEVEL_LABEL[r.gauge.level] : "unknown"}) as of ${asOf}`
    );
    const evidence = [makeEvidence({ label: "Inventory Status", sourceType: "inventory_status", asOf })];
    return { ok: true, dataText: lines.join("\n"), evidence, period: null, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// B. get_purchasing_summary
// ------------------------------------------------------------------
const purchasingArgs = z.object({ period: PERIOD_KEY.optional() }).strict();

const getPurchasingSummary: ToolDefinition<z.infer<typeof purchasingArgs>> = {
  name: "get_purchasing_summary",
  argsSchema: purchasingArgs,
  async execute(ctx, args) {
    const period = resolvedPeriod(ctx, args.period);
    const report = await getPurchasingReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate);
    if (report.documentCount === 0) {
      return { ok: true, dataText: "No purchasing activity was recorded in this period.", evidence: [], period, insufficientData: true };
    }
    const byVendor = report.byVendor.slice(0, 10).map((v) => `  - ${v.name}: $${v.totalValue.toFixed(2)}`);
    const byCategory = report.byCategory.slice(0, 10).map((c) => `  - ${c.name}: $${c.totalValue.toFixed(2)}`);
    const dataText = [
      `Purchasing summary ${period.startDate} to ${period.endDate}:`,
      `Total purchase value: $${report.totalPurchaseValue.toFixed(2)} across ${report.documentCount} document(s), ${report.vendorCount} vendor(s), ${report.itemCount} item(s).`,
      "By vendor:",
      ...byVendor,
      "By category:",
      ...byCategory,
    ].join("\n");
    const evidence = [makeEvidence({ label: "Purchasing Report", sourceType: "purchasing_report", period })];
    return { ok: true, dataText, evidence, period, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// C. get_receiving_summary
// ------------------------------------------------------------------
const receivingArgs = z.object({ period: PERIOD_KEY.optional() }).strict();

const getReceivingSummary: ToolDefinition<z.infer<typeof receivingArgs>> = {
  name: "get_receiving_summary",
  argsSchema: receivingArgs,
  async execute(ctx, args) {
    const period = resolvedPeriod(ctx, args.period);
    const report = await getReceivingReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate);
    if (report.documentCount === 0) {
      return { ok: true, dataText: "No receiving activity was recorded in this period.", evidence: [], period, insufficientData: true };
    }
    const byStatus = report.byStatus.slice(0, 10).map((s) => `  - ${s.status}: ${s.count}`);
    const byVendor = report.byVendor.slice(0, 10).map((v) => `  - ${v.vendorName}: ${v.count}`);
    const dataText = [
      `Receiving summary ${period.startDate} to ${period.endDate}:`,
      `${report.documentCount} document(s). Ready to post: ${report.readyToPostCount}. Partially posted: ${report.partiallyPostedCount}. Posted: ${report.postedCount}. Credit lines: ${report.creditLineCount}.`,
      "By status:",
      ...byStatus,
      "By vendor:",
      ...byVendor,
    ].join("\n");
    const evidence = [makeEvidence({ label: "Receiving Report", sourceType: "receiving_report", period })];
    return { ok: true, dataText, evidence, period, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// D. get_usage_summary
// ------------------------------------------------------------------
const usageArgs = z.object({ period: PERIOD_KEY.optional() }).strict();

const getUsageSummary: ToolDefinition<z.infer<typeof usageArgs>> = {
  name: "get_usage_summary",
  argsSchema: usageArgs,
  async execute(ctx, args) {
    const period = resolvedPeriod(ctx, args.period);
    const report = await getUsageReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate);
    if (report.movementCount === 0) {
      return { ok: true, dataText: "No withdrawal activity was recorded in this period.", evidence: [], period, insufficientData: true };
    }
    const byItem = report.byItem.slice(0, 10).map((i) => `  - ${i.itemName}: ${i.quantity} ${i.baseUnitCode}`);
    const byStation = report.byStation.slice(0, 10).map((s) => `  - ${s.stationName}: ${s.movementCount} withdrawal(s)`);
    const dataText = [
      `Usage (station withdrawal) summary ${period.startDate} to ${period.endDate}:`,
      `${report.movementCount} withdrawal movement(s).`,
      "By item:",
      ...byItem,
      "By station:",
      ...byStation,
    ].join("\n");
    const evidence = [makeEvidence({ label: "Usage Report", sourceType: "usage_report", period })];
    return { ok: true, dataText, evidence, period, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// E. get_waste_summary
// ------------------------------------------------------------------
const wasteArgs = z.object({ period: PERIOD_KEY.optional() }).strict();

const getWasteSummary: ToolDefinition<z.infer<typeof wasteArgs>> = {
  name: "get_waste_summary",
  argsSchema: wasteArgs,
  async execute(ctx, args) {
    const period = resolvedPeriod(ctx, args.period);
    const report = await getWasteReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate);
    if (report.eventCount === 0) {
      return { ok: true, dataText: "No storage waste was recorded in this period.", evidence: [], period, insufficientData: true };
    }
    const byItem = report.byItem.slice(0, 10).map((i) => `  - ${i.itemName}: ${i.quantity} ${i.unitCode}`);
    const byReason = report.byReason.slice(0, 10).map((r) => `  - ${r.reasonCode}: ${r.eventCount}`);
    const dataText = [
      `Storage waste summary ${period.startDate} to ${period.endDate} (storage waste only -- station waste is not yet tracked):`,
      `${report.eventCount} waste event(s).`,
      "By item:",
      ...byItem,
      "By reason:",
      ...byReason,
    ].join("\n");
    const evidence = [makeEvidence({ label: "Waste Report", sourceType: "waste_report", period })];
    return { ok: true, dataText, evidence, period, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// F. get_cycle_count_summary
// ------------------------------------------------------------------
const cycleCountArgs = z
  .object({
    locationNameContains: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const getCycleCountSummary: ToolDefinition<z.infer<typeof cycleCountArgs>> = {
  name: "get_cycle_count_summary",
  argsSchema: cycleCountArgs,
  async execute(ctx, args) {
    const summaries = await listCycleCountSummaries(ctx.supabase, {
      organizationId: ctx.organizationId,
      currentActorAppUserId: ctx.currentActorAppUserId,
      statuses: ["DRAFT", "COMPLETED", "CANCELLED"],
      limit: args.limit ?? 10,
    });
    const locationFilter = args.locationNameContains?.trim().toLowerCase();
    const rows = summaries.filter((s) => !locationFilter || s.locationName.toLowerCase().includes(locationFilter)).slice(0, MAX_ROWS);

    if (rows.length === 0) {
      return { ok: true, dataText: "No cycle counts were found.", evidence: [], period: null, insufficientData: true };
    }
    const lines = rows.map(
      (r) =>
        `- ${r.locationName}: ${r.status}, started ${r.startedAt} by ${r.startedByName}${r.completedAt ? `, completed ${r.completedAt}` : ""}${
          r.status === "COMPLETED" ? `, ${r.varianceItemCount} item(s) with a variance out of ${r.countedItemCount} counted` : ""
        }`
    );
    const evidence = rows.slice(0, 5).map((r) => makeEvidence({ label: `Cycle Count -- ${r.locationName}`, sourceType: "cycle_count", sourceId: r.cycleCountId }));
    return { ok: true, dataText: lines.join("\n"), evidence, period: null, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// G. get_inventory_alerts
// ------------------------------------------------------------------
const alertsArgs = z
  .object({
    todayOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const getInventoryAlerts: ToolDefinition<z.infer<typeof alertsArgs>> = {
  name: "get_inventory_alerts",
  argsSchema: alertsArgs,
  async execute(ctx, args) {
    const result = await listHighWithdrawalAlertsAction();
    if (!result.ok) {
      return { ok: false, message: "Could not load Inventory Alerts." };
    }
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ctx.now);
    const filtered = result.alerts
      .filter((a) => !args.todayOnly || new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(a.occurredAt)) === todayStr)
      .slice(0, args.limit ?? 10);

    if (filtered.length === 0) {
      return { ok: true, dataText: "No High-Withdrawal Inventory Alerts were found (informational only -- not an approval workflow).", evidence: [], period: null, insufficientData: true };
    }
    const lines = filtered.map(
      (a) => `- ${a.itemName} at ${a.stationName}: withdrew ${a.observedQuantity} ${a.unitCode} (threshold ${a.thresholdQuantity} ${a.unitCode}) on ${a.occurredAt}. This is informational; the withdrawal already completed.`
    );
    const evidence = filtered.slice(0, 5).map((a) => makeEvidence({ label: `Inventory Alert -- ${a.itemName}`, sourceType: "inventory_alert", sourceId: a.exceptionId, asOf: a.occurredAt }));
    return { ok: true, dataText: lines.join("\n"), evidence, period: null, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// H. get_reports_overview
// ------------------------------------------------------------------
const overviewArgs = z.object({ period: PERIOD_KEY.optional() }).strict();

const getReportsOverview: ToolDefinition<z.infer<typeof overviewArgs>> = {
  name: "get_reports_overview",
  argsSchema: overviewArgs,
  async execute(ctx, args) {
    const period = resolvedPeriod(ctx, args.period);
    const [purchasing, receiving, usage, waste, inventoryStatus] = await Promise.all([
      getPurchasingReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate),
      getReceivingReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate),
      getUsageReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate),
      getWasteReport(ctx.supabase, ctx.organizationId, period.startDate, period.endDate),
      // Inventory Status is deliberately not date-ranged -- current
      // balances are a point-in-time truth, same as the Overview page.
      listInventoryBalances(ctx.supabase, ctx.organizationId).then((balances) => {
        const gauges = balances.map((b) => computeStockGauge(b.balance, b.fullReferenceQuantity).level);
        return { lowStockCount: gauges.filter((l) => l === "LOW").length, outOfStockCount: gauges.filter((l) => l === "EMPTY").length };
      }),
    ]);

    const dataText = [
      `Operational overview ${period.startDate} to ${period.endDate}:`,
      `Purchasing: $${purchasing.totalPurchaseValue.toFixed(2)} across ${purchasing.documentCount} document(s).`,
      `Receiving: ${receiving.documentCount} document(s), ${receiving.readyToPostCount} ready to post, ${receiving.partiallyPostedCount} partially posted.`,
      `Inventory (current, not period-bound): ${inventoryStatus.lowStockCount} low stock, ${inventoryStatus.outOfStockCount} out of stock.`,
      `Usage: ${usage.movementCount} withdrawal movement(s).`,
      `Waste: ${waste.eventCount} storage waste event(s).`,
    ].join("\n");
    const evidence = [makeEvidence({ label: "Reports Overview", sourceType: "reports_overview", period })];
    return { ok: true, dataText, evidence, period, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// I. get_item_purchase_cost
// ------------------------------------------------------------------
const itemPurchaseCostArgs = z
  .object({
    itemNameQuery: z.string().min(1).max(120),
    windowDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
  })
  .strict();

const getItemPurchaseCost: ToolDefinition<z.infer<typeof itemPurchaseCostArgs>> = {
  name: "get_item_purchase_cost",
  argsSchema: itemPurchaseCostArgs,
  async execute(ctx, args) {
    const result = await lookupItemPurchaseCost({ supabase: ctx.supabase, organizationId: ctx.organizationId, now: ctx.now }, args.itemNameQuery, args.windowDays ?? 30);

    if (result.status === "not_found") {
      return { ok: true, dataText: `No inventory item matching "${args.itemNameQuery}" was found in this organization.`, evidence: [], period: null, insufficientData: true };
    }

    if (result.status === "ambiguous") {
      return {
        ok: true,
        // insufficientData: false -- this is a real, useful finding (a
        // clarifying question the model should ask), not "no data at
        // all"; it must reach the synthesis step, never the generic
        // canned insufficient-data shortcut.
        dataText: `Multiple inventory items match "${args.itemNameQuery}": ${result.candidateNames.join(", ")}. Ask the manager which specific item they mean before giving any cost figure -- do not guess.`,
        evidence: [],
        period: null,
        insufficientData: false,
      };
    }

    if (result.status === "no_verified_cost") {
      const evidence = [makeEvidence({ label: `${result.item.name} -- Item Detail`, sourceType: "item_detail", sourceId: result.item.id })];
      return {
        ok: true,
        dataText: `${result.item.name} exists in inventory (base unit ${result.item.baseUnitCode}), but no verified/posted purchase cost record was found for it. State this plainly -- do not guess or substitute an unrelated total.`,
        evidence,
        period: null,
        insufficientData: false,
      };
    }

    if (result.status === "incomplete") {
      // Neither a latest price nor a weighted average can be safely
      // presented -- no numeric figure is ever included in this dataText,
      // so the synthesis model has nothing to restate even if instructed
      // otherwise (defense in depth beyond the prompt-level rule).
      const evidence = [makeEvidence({ label: `${result.item.name} -- Item Detail`, sourceType: "item_detail", sourceId: result.item.id })];
      return {
        ok: true,
        dataText: `${result.item.name} exists in inventory (base unit ${result.item.baseUnitCode}). ${result.reason} Do not state a latest price or weighted average for this item.`,
        evidence,
        period: null,
        insufficientData: false,
      };
    }

    const { item, latest, weightedAverage, weightedAverageTruncated } = result;
    const lines = [
      `Latest verified purchase of ${item.name}:`,
      `  Vendor: ${latest.vendorName}`,
      `  Document date: ${latest.documentDate}${latest.documentNumber ? ` (document ${latest.documentNumber})` : ""}`,
      latest.packageQuantity !== null && latest.packageUnit && latest.unitCostPerPackage !== null
        ? `  Verified line amount: $${latest.lineTotal.toFixed(2)} for ${latest.packageQuantity} ${latest.packageUnit} ($${latest.unitCostPerPackage.toFixed(2)} per ${latest.packageUnit})`
        : `  Verified line amount: $${latest.lineTotal.toFixed(2)}`,
      `  Converted base-unit quantity: ${latest.baseQuantity} ${latest.baseUnitCode}`,
      `  Normalized cost per base unit: $${latest.unitCostPerBaseUnit.toFixed(2)} per ${latest.baseUnitCode}`,
    ];
    if (weightedAverage) {
      lines.push(
        `${weightedAverage.windowDays}-day weighted-average cost (${weightedAverage.startDate} to ${weightedAverage.endDate}, ${weightedAverage.recordCount} verified purchase(s), complete for this period): $${weightedAverage.weightedAverageBaseUnitCost.toFixed(2)} per ${item.baseUnitCode} (total $${weightedAverage.totalEligibleLineAmount.toFixed(2)} / ${weightedAverage.totalEligibleBaseQuantity} ${item.baseUnitCode})`
      );
    } else if (weightedAverageTruncated) {
      lines.push(
        `A ${args.windowDays ?? 30}-day weighted average could NOT be calculated completely from available data, so none is reported -- do not estimate one.`
      );
    } else {
      lines.push(`No other verified purchase fell within the requested ${args.windowDays ?? 30}-day window, so no weighted average is available.`);
    }
    lines.push("Limitations: " + result.limitations.join(" "));

    const evidence = [
      // The purchase document itself is the one route that visibly shows
      // the vendor, date, line items and price backing this claim -- the
      // strongest truthful evidence, listed first.
      makeEvidence({ label: `Purchase Document -- ${latest.documentNumber ?? latest.documentDate}`, sourceType: "purchase_document", sourceId: latest.documentId }),
      makeEvidence({ label: `Purchasing Report -- ${latest.vendorName}`, sourceType: "purchasing_report", sourceId: latest.vendorId }),
      makeEvidence({ label: `${item.name} -- Item Detail`, sourceType: "item_detail", sourceId: item.id }),
    ];

    return { ok: true, dataText: lines.join("\n"), evidence, period: null, insufficientData: false };
  },
};

// ------------------------------------------------------------------
// J. prepare_report_export -- the general report-builder tool
// ------------------------------------------------------------------
// ONE tool for every registered report (Section 9: "Do not add one tool
// per report type"). The model only ever supplies a report id, a typed
// date request, allowlisted filter/grouping/column names, and an
// includePricing flag -- every actual date boundary, filter id, column
// set, and workbook byte is resolved/generated server-side, reusing the
// SAME registry the download route independently re-validates against.

const MAX_FILTERS = 6;
const MAX_COLUMNS = 20;

const dateRequestArgsSchema = z
  .object({
    kind: z.enum(DATE_REQUEST_KINDS),
    days: z.number().int().min(1).max(365).optional(),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(2000).max(2100).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

const reportFilterArgsSchema = z.object({ key: z.string().min(1).max(40), rawValue: z.string().min(1).max(120) }).strict();

const prepareReportExportArgs = z
  .object({
    reportId: z.enum(REPORT_IDS),
    dateRequest: dateRequestArgsSchema,
    filters: z.array(reportFilterArgsSchema).max(MAX_FILTERS).optional(),
    grouping: z.string().max(40).optional(),
    columns: z.array(z.string().max(60)).max(MAX_COLUMNS).optional(),
    includePricing: z.boolean().optional(),
    format: z.literal("xlsx").optional(),
  })
  .strict();

function formatMetricValue(metric: { value: number | string; format?: string }): string {
  if (typeof metric.value === "string") return metric.value;
  if (metric.format === "currency") return `$${metric.value.toFixed(2)}`;
  if (metric.format === "percent") return `${metric.value}%`;
  return String(metric.value);
}

const prepareReportExport: ToolDefinition<z.infer<typeof prepareReportExportArgs>> = {
  name: "prepare_report_export",
  argsSchema: prepareReportExportArgs,
  async execute(ctx, args) {
    const def = getReportDefinition(args.reportId);
    if (!def) {
      return { ok: true, dataText: `"${args.reportId}" is not a supported report.`, evidence: [], period: null, insufficientData: true };
    }

    const dateResult = resolveDateRequest(args.dateRequest, ctx.now, ctx.timeZone, {
      isPointInTime: def.isPointInTime,
      maxRangeDays: def.maxRangeDays,
      supportedDateKinds: def.supportedDateKinds,
    });
    if (!dateResult.ok) {
      return { ok: true, dataText: dateResult.message, evidence: [], period: null, insufficientData: true };
    }

    const unsupportedFilterKeys: string[] = [];
    const resolvedFilters: ResolvedReportFilter[] = [];
    for (const requested of args.filters ?? []) {
      const filterDef = def.filters.find((f) => f.key === requested.key);
      if (!filterDef) {
        unsupportedFilterKeys.push(requested.key);
        continue;
      }
      if (filterDef.kind === "enum") {
        const normalized = requested.rawValue.trim().toUpperCase();
        if (!filterDef.allowedValues.includes(normalized)) {
          return {
            ok: true,
            dataText: `"${requested.rawValue}" is not a supported value for ${filterDef.label}. Supported values: ${filterDef.allowedValues.join(", ")}.`,
            evidence: [],
            period: null,
            insufficientData: true,
          };
        }
        resolvedFilters.push({ key: filterDef.key, label: filterDef.label, id: normalized, name: normalized });
        continue;
      }
      const outcome = await filterDef.resolve(ctx, requested.rawValue);
      if (outcome.status === "not_found") {
        return { ok: true, dataText: `No ${filterDef.label.toLowerCase()} matching "${requested.rawValue}" was found.`, evidence: [], period: null, insufficientData: true };
      }
      if (outcome.status === "ambiguous") {
        return {
          ok: true,
          dataText: `Multiple ${filterDef.label.toLowerCase()} match "${requested.rawValue}": ${outcome.candidates.map((c) => c.name).join(", ")}. Ask the manager which one they mean before proceeding -- do not guess.`,
          evidence: [],
          period: null,
          insufficientData: false,
        };
      }
      resolvedFilters.push({ key: filterDef.key, label: filterDef.label, id: outcome.id, name: outcome.name });
    }

    const missingRequired = def.requiredFilterKeys.filter((key) => !resolvedFilters.some((f) => f.key === key));
    if (missingRequired.length > 0) {
      const labels = missingRequired.map((key) => def.filters.find((f) => f.key === key)?.label ?? key);
      return { ok: true, dataText: `${def.name} requires: ${labels.join(", ")}. Ask the manager which one they mean.`, evidence: [], period: null, insufficientData: true };
    }

    const unsupportedGrouping = Boolean(args.grouping) && !def.groupings.some((g) => g.key === args.grouping);
    const grouping = args.grouping && !unsupportedGrouping ? args.grouping : null;
    const unsupportedColumns = unsupportedColumnKeys(def.columns, args.columns);
    const includePricing = def.pricingMode === "not_supported" ? false : (args.includePricing ?? false);

    const spec: ResolvedReportSpecification = {
      reportId: def.id,
      dateRange: dateResult.range,
      filters: resolvedFilters,
      grouping,
      columns: resolveColumns(def.columns, args.columns, def.defaultColumnKeys, def.requiredColumnKeys, def.maxColumns).map((c) => c.key),
      includePricing,
      format: "xlsx",
    };

    const loadResult = await def.loadReport(ctx, spec);
    if (loadResult.tables.length === 0 && loadResult.summaryMetrics.length === 0) {
      // No registered loader ever returns both empty on a genuine
      // (even zero-row) success -- this signals a hard failure path
      // (e.g. an unresolvable item, an unprovable-complete vendor pool,
      // a row-count overflow) whose explanation is in `limitations`.
      return { ok: true, dataText: loadResult.limitations.join(" ") || "This report could not be prepared.", evidence: [], period: null, insufficientData: true };
    }

    const download: ChatDownload = { label: `Download ${def.name}`, format: "xlsx", reportSpecification: spec };
    const period: AskGansevoortResolvedPeriod | null = spec.dateRange.isPointInTime ? null : { key: "N/A", startDate: spec.dateRange.startDate, endDate: spec.dateRange.endDate };

    const lines: string[] = [
      spec.dateRange.isPointInTime ? `${def.name} prepared (current, point-in-time).` : `${def.name} prepared for ${spec.dateRange.startDate} to ${spec.dateRange.endDate} (${ctx.timeZone}).`,
      loadResult.isEmpty ? "No records were found for this request. A valid, empty workbook is still available for download." : `${loadResult.recordCount} record(s) found.`,
    ];
    if (loadResult.summaryMetrics.length > 0) {
      lines.push("Summary: " + loadResult.summaryMetrics.map((m) => `${m.label}: ${formatMetricValue(m)}`).join("; ") + ".");
    }
    if (unsupportedFilterKeys.length > 0) lines.push(`These filters are not supported for ${def.name} and were ignored: ${unsupportedFilterKeys.join(", ")}.`);
    if (unsupportedGrouping) lines.push(`"${args.grouping}" is not a supported grouping for ${def.name} -- the default grouping was used instead.`);
    if (unsupportedColumns.length > 0) lines.push(`These columns are not supported for ${def.name} and were ignored: ${unsupportedColumns.join(", ")}.`);
    if (args.includePricing && def.pricingMode === "not_supported") lines.push(`Pricing is not available for ${def.name} -- the report was prepared without it.`);
    lines.push(...loadResult.limitations);
    lines.push(
      "A download link for the full Excel workbook has already been prepared server-side. Tell the manager it is ready and restate only the figures above -- never invent a figure this data doesn't contain."
    );

    return { ok: true, dataText: lines.join("\n"), evidence: [], period, insufficientData: false, downloads: [download] };
  },
};

export const CHAT_TOOL_REGISTRY: Record<ChatToolName, ToolDefinition<unknown>> = {
  get_inventory_status: getInventoryStatus as ToolDefinition<unknown>,
  get_purchasing_summary: getPurchasingSummary as ToolDefinition<unknown>,
  get_receiving_summary: getReceivingSummary as ToolDefinition<unknown>,
  get_usage_summary: getUsageSummary as ToolDefinition<unknown>,
  get_waste_summary: getWasteSummary as ToolDefinition<unknown>,
  get_cycle_count_summary: getCycleCountSummary as ToolDefinition<unknown>,
  get_inventory_alerts: getInventoryAlerts as ToolDefinition<unknown>,
  get_reports_overview: getReportsOverview as ToolDefinition<unknown>,
  get_item_purchase_cost: getItemPurchaseCost as ToolDefinition<unknown>,
  prepare_report_export: prepareReportExport as ToolDefinition<unknown>,
};

/** Schema-validates raw (model-supplied) args before a tool ever runs --
 * an invalid/excess/unknown field is rejected here, never silently
 * coerced (Section 9's "tool arguments are schema-validated"). */
export function validateToolArgs(toolName: ChatToolName, rawArgs: unknown): { ok: true; args: unknown } | { ok: false; message: string } {
  const tool = CHAT_TOOL_REGISTRY[toolName];
  const parsed = tool.argsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, message: `Invalid arguments for ${toolName}: ${parsed.error.message}` };
  }
  return { ok: true, args: parsed.data };
}

export async function executeTool(toolName: ChatToolName, ctx: ChatToolContext, args: unknown): Promise<ToolExecutionResult> {
  const tool = CHAT_TOOL_REGISTRY[toolName];
  return tool.execute(ctx, args);
}
