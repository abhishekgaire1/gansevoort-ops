"use client";

import { RouteErrorBoundary } from "@/app/components/manager/RouteErrorBoundary";

/**
 * Covers Current Inventory, Item Detail, Activity, Cycle Count, and
 * Inventory Waste -- everything under this segment except
 * inventory/alerts, which keeps its own more specific boundary (Next
 * uses the nearest ancestor error.tsx, so alerts' own file still wins
 * there).
 */
export default function InventoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary sectionLabel="Inventory" error={error} reset={reset} />;
}
