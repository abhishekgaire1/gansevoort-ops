/**
 * Reports reliability/UX pass -- ONE shared, restrained loading skeleton
 * for every Reports route (Overview/Purchasing/Usage/Inventory Status/
 * Waste/Receiving), used via the single app/manager/(app)/reports/
 * loading.tsx boundary (Next's loading.js nests below the enclosing
 * layout and wraps every child segment beneath it, so one file here
 * covers all six routes -- no per-report duplicate).
 *
 * Geometry deliberately echoes the real loaded shape (title, period
 * pills, filter row, metric cards, two content panels) so the page does
 * not jump wildly once real content streams in (Section 15) -- not
 * pixel-perfect CLS optimization, just a skeleton that roughly matches
 * what replaces it. `animate-pulse` is Tailwind's standard restrained
 * skeleton treatment, not a distracting custom animation.
 */
export function ReportLoadingSkeleton() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-live="polite">
      <div className="h-5 w-40 rounded bg-zinc-800" />
      <div className="mt-2 h-4 w-72 rounded bg-zinc-900" />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="h-8 w-16 rounded-full bg-zinc-800" />
        <div className="h-8 w-16 rounded-full bg-zinc-900" />
        <div className="h-8 w-16 rounded-full bg-zinc-900" />
        <div className="h-8 w-20 rounded-full bg-zinc-900" />
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="h-9 w-40 rounded-lg bg-zinc-900" />
        <div className="h-9 w-40 rounded-lg bg-zinc-900" />
        <div className="h-9 w-16 rounded-full bg-zinc-800" />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="h-3 w-16 rounded bg-zinc-800" />
            <div className="mt-2 h-6 w-12 rounded bg-zinc-800" />
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="h-48 rounded-2xl border border-zinc-800 bg-zinc-900" />
        <div className="h-48 rounded-2xl border border-zinc-800 bg-zinc-900" />
      </div>
    </div>
  );
}
