"use client";

import { RouteErrorBoundary } from "@/app/components/manager/RouteErrorBoundary";

export default function ItemsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary sectionLabel="Items" error={error} reset={reset} />;
}
