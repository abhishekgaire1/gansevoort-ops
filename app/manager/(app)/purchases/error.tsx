"use client";

import { RouteErrorBoundary } from "@/app/components/manager/RouteErrorBoundary";

export default function PurchasesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary sectionLabel="Purchase Document" error={error} reset={reset} />;
}
