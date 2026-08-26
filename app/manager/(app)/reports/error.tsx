"use client";

import { usePathname } from "next/navigation";
import { reportLabelForPathname } from "./_lib/reportErrorLabel";
import { RouteErrorBoundary } from "@/app/components/manager/RouteErrorBoundary";

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
 * RouteErrorBoundary only ever logs the opaque `digest` to the browser
 * console, never `error.message`/`error.stack`; the full error is already
 * logged server-side (by the report action's own loadFailure(), for an
 * ordinary data failure).
 */
export default function ReportsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const pathname = usePathname();
  const label = reportLabelForPathname(pathname);

  return <RouteErrorBoundary sectionLabel={label} error={error} reset={reset} />;
}
