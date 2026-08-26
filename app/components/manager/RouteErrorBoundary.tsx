"use client";

import { useEffect } from "react";

/**
 * Shared content for a manager route group's error.tsx boundary. Every
 * route group under app/manager/(app)/ that doesn't need Reports' own
 * per-pathname label mapping (see reports/error.tsx/reportErrorLabel.ts)
 * renders this with a single fixed section label -- one real render
 * exception during Server Component rendering lands here instead of
 * Next's generic crash screen, without unmounting the ManagerShell above
 * it (error.js nests the same way loading.js does).
 *
 * Only the opaque `digest` is ever logged to the browser console -- never
 * `error.message`/`error.stack`. The underlying action/RPC that actually
 * threw already logs full detail server-side; this boundary's job is
 * only to give the manager a calm, recoverable screen.
 */
export function RouteErrorBoundary({ sectionLabel, error, reset }: { sectionLabel: string; error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(`[${sectionLabel.toLowerCase().replace(/\s+/g, "-")}] route-level render error`, { digest: error.digest });
  }, [sectionLabel, error]);

  return (
    <div className="mt-6 rounded-2xl border border-amber-900/60 bg-amber-950/10 p-6 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">{sectionLabel} Unavailable</p>
      <p className="mt-2 text-sm text-zinc-300">We couldn&apos;t load this page.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950">
        Try Again
      </button>
    </div>
  );
}
