"use client";

import { RouteErrorBoundary } from "@/app/components/manager/RouteErrorBoundary";

export default function CategoriesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary sectionLabel="Categories" error={error} reset={reset} />;
}
