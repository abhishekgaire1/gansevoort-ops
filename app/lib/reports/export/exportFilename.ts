import type { ReportExportDateRange, ReportExportFormat, ReportExportType } from "./reportExportModel";

/** Human-facing filename slug per report -- deliberately distinct from
 * the internal reportType id for "usage" (its route is /manager/reports/
 * usage, but the exported filename reads "inventory-usage" for clarity
 * standalone in a Downloads folder). */
const FILENAME_SLUG: Record<ReportExportType, string> = {
  overview: "overview",
  purchasing: "purchasing",
  usage: "inventory-usage",
  "inventory-status": "inventory-status",
  waste: "waste",
  receiving: "receiving",
};

/** purchasing_2026-08-01_to_2026-08-24.xlsx / waste_2026-08-24.pdf (single
 * day when the range collapses to one day, or no range at all -- Inventory
 * Status is point-in-time) / inventory-status_2026-08-24.csv. Never
 * includes filter values -- filter text (vendor/item names) isn't
 * guaranteed filesystem/URL-safe and isn't needed to identify the file. */
export function buildExportFilename(reportType: ReportExportType, format: ReportExportFormat, dateRange: ReportExportDateRange | null, generatedOnDate: string): string {
  const slug = FILENAME_SLUG[reportType];
  const datePart = !dateRange ? generatedOnDate : dateRange.startDate === dateRange.endDate ? dateRange.startDate : `${dateRange.startDate}_to_${dateRange.endDate}`;
  return `${slug}_${datePart}.${format}`;
}
