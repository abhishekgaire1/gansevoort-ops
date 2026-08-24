/**
 * Reports reliability/UX pass -- pure pathname->report-name mapping used
 * by the shared Reports error.tsx boundary, pulled out so it's directly
 * unit-testable without needing React render infrastructure (error.tsx
 * itself must be a Client Component using usePathname(), which this file
 * deliberately does not import).
 */
const REPORT_LABEL: Record<string, string> = {
  "/manager/reports": "Reports Overview",
  "/manager/reports/purchasing": "Purchasing Report",
  "/manager/reports/usage": "Inventory Usage Report",
  "/manager/reports/inventory-status": "Inventory Status Report",
  "/manager/reports/waste": "Waste Report",
  "/manager/reports/receiving": "Receiving Report",
};

/** Falls back to the generic "Report" for any path not in the known set
 * (e.g. a future report route added without updating this map, or a
 * pathname with an unexpected trailing segment) -- never throws, never
 * shows a blank/undefined label. */
export function reportLabelForPathname(pathname: string | null): string {
  if (!pathname) return "Report";
  return REPORT_LABEL[pathname] ?? "Report";
}
