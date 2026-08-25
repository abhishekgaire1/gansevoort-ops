import type { ResolvedReportPeriod } from "./reportPeriod";

/** Builds the exact query string the shared export Route Handler expects,
 * from the SAME resolved period + filter values the page itself is
 * currently rendering with -- this is what guarantees a download always
 * matches what's on screen (Section 2). */
export function buildExportQueryString(period: ResolvedReportPeriod, extra: Record<string, string | null | undefined> = {}): string {
  const params = new URLSearchParams();
  params.set("period", period.key);
  if (period.key === "CUSTOM") {
    params.set("from", period.startDate);
    params.set("to", period.endDate);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}
