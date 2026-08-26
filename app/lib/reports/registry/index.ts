import "server-only";
import { purchasingReportDefinition } from "@/app/lib/reports/registry/definitions/purchasing";
import { receivingReportDefinition } from "@/app/lib/reports/registry/definitions/receiving";
import { inventoryStatusReportDefinition } from "@/app/lib/reports/registry/definitions/inventoryStatus";
import { usageReportDefinition } from "@/app/lib/reports/registry/definitions/usage";
import { wasteReportDefinition } from "@/app/lib/reports/registry/definitions/waste";
import { cycleCountsReportDefinition } from "@/app/lib/reports/registry/definitions/cycleCounts";
import { inventoryAlertsReportDefinition } from "@/app/lib/reports/registry/definitions/inventoryAlerts";
import { reportsOverviewDefinition } from "@/app/lib/reports/registry/definitions/reportsOverview";
import { itemCostHistoryReportDefinition } from "@/app/lib/reports/registry/definitions/itemCostHistory";
import type { ReportDefinition, ReportId } from "@/app/lib/reports/registry/types";
import { REPORT_IDS } from "@/app/lib/reports/registry/types";

/**
 * General Report Builder -- THE registry (Section 6). A future report is
 * added here, and ONLY here: register a new ReportDefinition object.
 * Nothing else (the chat tool, the download route, the Excel writer)
 * needs to change. Every id in REPORT_IDS must have exactly one entry --
 * a duplicate or missing id is a build-time/test-time error, never a
 * silent runtime gap.
 */
export const REPORT_REGISTRY: Record<ReportId, ReportDefinition> = {
  purchasing: purchasingReportDefinition,
  receiving: receivingReportDefinition,
  inventory_status: inventoryStatusReportDefinition,
  usage: usageReportDefinition,
  waste: wasteReportDefinition,
  cycle_counts: cycleCountsReportDefinition,
  inventory_alerts: inventoryAlertsReportDefinition,
  reports_overview: reportsOverviewDefinition,
  item_cost_history: itemCostHistoryReportDefinition,
};

export function getReportDefinition(reportId: string): ReportDefinition | null {
  if (!(REPORT_IDS as readonly string[]).includes(reportId)) return null;
  return REPORT_REGISTRY[reportId as ReportId] ?? null;
}
