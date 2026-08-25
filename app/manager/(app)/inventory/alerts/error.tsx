"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary for /manager/inventory/alerts and its
 * detail route -- mirrors app/manager/(app)/reports/error.tsx's overall
 * structure (a genuine render exception, distinct from an ordinary
 * data-load failure, which the pages already catch inline via their own
 * `!result.ok` EmptyState), but does NOT repeat that file's own known
 * raw-message-to-browser-console pattern: only a fixed label and the
 * Next.js-generated `digest` (an opaque id, safe to log) are logged
 * here -- never `error.message` or `error.stack`, and never rendered in
 * the UI either.
 */
export default function InventoryAlertsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[inventory-alerts] route-level render error", { digest: error.digest });
  }, [error]);

  return (
    <div className="mt-6 rounded-2xl border border-amber-900/60 bg-amber-950/10 p-6 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Inventory Alerts Unavailable</p>
      <p className="mt-2 text-sm text-zinc-300">We couldn&apos;t load this page.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950">
        Try Again
      </button>
    </div>
  );
}
