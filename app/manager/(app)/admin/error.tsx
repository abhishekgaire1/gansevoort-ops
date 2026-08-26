"use client";

import { RouteErrorBoundary } from "@/app/components/manager/RouteErrorBoundary";

/** Covers every Admin route -- Users, Stations, Item Master, Vendors,
 * Categories, AI Configuration -- since none of them have their own
 * error.tsx of their own. */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary sectionLabel="Admin" error={error} reset={reset} />;
}
