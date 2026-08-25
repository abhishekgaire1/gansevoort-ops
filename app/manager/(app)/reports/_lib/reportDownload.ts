import type { ReportExportFormat, ReportExportType } from "@/app/lib/reports/export/reportExportModel";

export function extractExportFilename(contentDisposition: string | null, fallback: string): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}

export type ReportDownloadResult = { ok: true; blob: Blob; filename: string } | { ok: false };

/** Pure fetch-and-shape step behind ReportDownloadMenu's UI, extracted so
 * the "a failed export never throws, it just reports failure" contract
 * (Section 15 -- the report page above it must stay untouched) is
 * directly unit-testable without rendering the component. */
export async function fetchReportExport(
  reportType: ReportExportType,
  format: ReportExportFormat,
  queryString: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReportDownloadResult> {
  try {
    const response = await fetchImpl(`/manager/reports/export?report=${reportType}&format=${format}&${queryString}`, { method: "GET" });
    if (!response.ok) return { ok: false };
    const blob = await response.blob();
    const filename = extractExportFilename(response.headers.get("Content-Disposition"), `${reportType}.${format}`);
    return { ok: true, blob, filename };
  } catch {
    return { ok: false };
  }
}
