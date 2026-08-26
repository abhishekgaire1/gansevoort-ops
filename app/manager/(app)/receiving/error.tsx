"use client";

import { RouteErrorBoundary } from "@/app/components/manager/RouteErrorBoundary";

export default function ReceivingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary sectionLabel="Receiving" error={error} reset={reset} />;
}
