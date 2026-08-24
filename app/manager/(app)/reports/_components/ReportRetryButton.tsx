"use client";

import { useRouter } from "next/navigation";

/**
 * Reports reliability/UX pass -- recovery action for an ORDINARY report
 * data failure (the action returned `ok: false`, no exception was
 * thrown, so error.tsx never engages). router.refresh() is the correct
 * App Router primitive here: it re-runs the current route's Server
 * Components with the CURRENT URL/search params untouched (Section 7 --
 * date/vendor/category/location filters stay exactly as selected),
 * without a full page reload.
 */
export function ReportRetryButton() {
  const router = useRouter();
  return (
    <button type="button" onClick={() => router.refresh()} className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">
      Try Again
    </button>
  );
}
