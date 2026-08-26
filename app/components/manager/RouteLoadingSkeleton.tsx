/**
 * Shared, restrained loading skeleton for manager route groups that don't
 * have a more specific one of their own (e.g. Reports' own
 * ReportLoadingSkeleton). Generic list/detail shape -- a title bar plus a
 * few pulsing rows -- so a slow data fetch shows immediate, calm feedback
 * instead of a blank page, without pretending to match every page's exact
 * layout.
 */
export function RouteLoadingSkeleton() {
  return (
    <div className="mx-auto max-w-6xl animate-pulse" aria-busy="true" aria-live="polite">
      <div className="h-6 w-48 rounded bg-zinc-800" />
      <div className="mt-2 h-4 w-72 rounded bg-zinc-900" />
      <div className="mt-6 flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-2xl border border-zinc-800 bg-zinc-900" />
        ))}
      </div>
    </div>
  );
}
