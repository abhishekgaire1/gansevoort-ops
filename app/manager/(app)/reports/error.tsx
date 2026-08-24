"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { reportLabelForPathname } from "./_lib/reportErrorLabel";

/**
 * Reports reliability/UX pass -- the route-level error boundary for the
 * whole Reports group (Next requires error.js to be a Client Component;
 * it nests the same way loading.js does, so this one file covers every
 * report route and NEVER unmounts the Manager shell above it -- only the
 * content slot is replaced).
 *
 * This is the backstop for a genuine RENDER exception (a thrown error
 * during Server Component rendering) -- distinct from a normal REPORT
 * DATA failure, which each report page already catches inline and shows
 * as its own recoverable EmptyState without ever throwing (Section 8).
 * The exact bug this closes: every report page previously did
 * `if (!auth.ok) return null` on its own independent auth check (the
 * (app) layout's OWN auth check is separate and already redirects on a
 * real failure) -- under the already-diagnosed auth-resolution race, a
 * transient failure of that one page-level check rendered nothing at
 * all, with the shell still visible. That branch now throws instead of
 * silently returning null, so it lands here as a real, recoverable error
 * rather than a permanent blank screen.
 *
 * Never exposes SQLSTATE/stack/Supabase/JWT detail to the Manager --
 * `error.message` is deliberately never rendered; the full error is
 * already logged server-side (either by this effect, or by the report
 * action's own loadFailure() for an ordinary data failure).
 */
export default function ReportsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const pathname = usePathname();
  const label = reportLabelForPathname(pathname);

  useEffect(() => {
    console.error("[reports] route-level render error", { pathname, message: error.message, digest: error.digest });
  }, [error, pathname]);

  return (
    <div className="mt-6 rounded-2xl border border-amber-900/60 bg-amber-950/10 p-6 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">{label} Unavailable</p>
      <p className="mt-2 text-sm text-zinc-300">We couldn&apos;t load this report.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950">
        Try Again
      </button>
    </div>
  );
}
