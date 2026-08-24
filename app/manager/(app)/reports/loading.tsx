import { ReportLoadingSkeleton } from "./_components/ReportLoadingSkeleton";

/**
 * Shared loading boundary for the entire Reports route group (Reports
 * reliability/UX pass, Section 3/4). Next's loading.js nests inside the
 * enclosing (app) layout and wraps this segment PLUS every nested route
 * beneath it -- Overview, Purchasing, Usage, Inventory Status, Waste,
 * Receiving all stream through this one file, so the Manager shell
 * (sidebar/header, rendered by the layout above this segment) is never
 * affected and stays interactive while a report loads.
 */
export default function ReportsLoading() {
  return <ReportLoadingSkeleton />;
}
