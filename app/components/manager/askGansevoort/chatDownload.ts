import { extractExportFilename } from "@/app/manager/(app)/reports/_lib/reportDownload";
import type { ResolvedReportSpecification } from "@/app/lib/reports/registry/types";

/**
 * Ask Gansevoort download button -- pure fetch-and-shape step, mirroring
 * app/manager/(app)/reports/_lib/reportDownload.ts's fetchReportExport
 * exactly (same blob -> temporary-link -> revoke pattern), but POSTing
 * the EXACT trusted `reportSpecification` the server already built
 * (Section 7/8/10) rather than a GET query string -- the model never
 * supplies this specification; it only ever comes from the chat
 * response's server-built `downloads` array, and the download route
 * independently re-validates every field before generating anything.
 */
export type ChatDownloadResult = { ok: true; blob: Blob; filename: string } | { ok: false };

export async function fetchChatDownload(reportSpecification: ResolvedReportSpecification, fallbackFilename: string, fetchImpl: typeof fetch = fetch): Promise<ChatDownloadResult> {
  try {
    const response = await fetchImpl("/manager/reports/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reportSpecification),
    });
    if (!response.ok) return { ok: false };
    const blob = await response.blob();
    const filename = extractExportFilename(response.headers.get("Content-Disposition"), fallbackFilename);
    return { ok: true, blob, filename };
  } catch {
    return { ok: false };
  }
}
