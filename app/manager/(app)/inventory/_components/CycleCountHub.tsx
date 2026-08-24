"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listCycleCountSummariesAction, listStorageEligibleLocationsForOrganization } from "@/app/actions/cycleCounts";
import type { CycleCountSummary, StorageEligibleLocation } from "@/app/lib/inventory/cycleCounts";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { EmptyState } from "@/app/components/manager/EmptyState";
import { primaryButtonClass } from "@/app/components/manager/buttonStyles";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

const STATUS_FILTERS = ["ALL", "COMPLETED", "CANCELLED"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * The Cycle Count hub (Part "CYCLE COUNT LANDING PAGE") -- prioritizes, in
 * order: counts currently in progress, starting a new one, then recent
 * history (Part "VISUAL PRIORITY"). Both sections share ONE efficient
 * summary query (list_cycle_count_summaries, 20260811100083) via
 * listCycleCountSummariesAction, filtered by status -- never one query per
 * row (Part "HISTORY PERFORMANCE").
 */
export function CycleCountHub() {
  const [inProgress, setInProgress] = useState<CycleCountSummary[] | null>(null);
  const [history, setHistory] = useState<CycleCountSummary[] | null>(null);
  const [locations, setLocations] = useState<StorageEligibleLocation[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [locationFilter, setLocationFilter] = useState<string>("ALL");

  useEffect(() => {
    listCycleCountSummariesAction({ statuses: ["DRAFT"] }).then((result) => {
      if (result.ok) setInProgress(result.summaries);
    });
    listStorageEligibleLocationsForOrganization().then((result) => {
      if (result.ok) setLocations(result.locations);
    });
  }, []);

  const loadHistory = useCallback(async () => {
    const result = await listCycleCountSummariesAction({
      statuses: statusFilter === "ALL" ? ["COMPLETED", "CANCELLED"] : [statusFilter],
      locationId: locationFilter === "ALL" ? null : locationFilter,
      limit: 50,
    });
    if (result.ok) setHistory(result.summaries);
  }, [statusFilter, locationFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, [loadHistory]);

  return (
    <div className="mt-4 flex flex-col gap-6">
      <PageHeader
        title="Cycle Count"
        description="Reconcile physical inventory with system inventory."
        action={
          <Link href="/manager/inventory/cycle-count/new" className={primaryButtonClass}>
            + New Cycle Count
          </Link>
        }
      />

      {inProgress !== null && inProgress.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">In Progress</p>
          {inProgress.map((summary) => (
            <InProgressCard key={summary.cycleCountId} summary={summary} />
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Cycle Count History</p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              {STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    statusFilter === status ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            {locations && locations.length > 0 ? (
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-1 text-xs text-zinc-300"
              >
                <option value="ALL">All locations</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        {history === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : history.length === 0 ? (
          <EmptyState message="No completed cycle counts yet. Completed and cancelled counts will appear here." />
        ) : (
          <div className="flex flex-col gap-2">
            {history.map((summary) => (
              <HistoryCard key={summary.cycleCountId} summary={summary} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InProgressCard({ summary }: { summary: CycleCountSummary }) {
  return (
    <div className="rounded-2xl border border-amber-800/40 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-zinc-100">{summary.locationName}</p>
          <div className="mt-1">
            <StatusBadge label="In Progress" tone="warning" />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Started by {summary.isOwnedByCurrentManager ? "you" : summary.startedByName} · {formatDateTime(summary.startedAt)}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {summary.countedItemCount} {summary.countedItemCount === 1 ? "item" : "items"} counted
          </p>
        </div>
        {summary.isOwnedByCurrentManager ? (
          <Link href={`/manager/inventory/cycle-count/${summary.cycleCountId}`} className={`shrink-0 ${primaryButtonClass}`}>
            Resume →
          </Link>
        ) : (
          <div className="shrink-0 text-right">
            <StatusBadge label="In Progress" tone="warning" />
            <p className="mt-1 max-w-[12rem] text-[11px] text-zinc-600">Only {summary.startedByName} can resume this count.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryCard({ summary }: { summary: CycleCountSummary }) {
  const isCancelled = summary.status === "CANCELLED";
  const note = isCancelled ? summary.cancellationReason : summary.completionNote;
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-wide text-zinc-100">{summary.locationName}</p>
          <p className="text-xs text-zinc-500">
            {formatDateTime((isCancelled ? summary.cancelledAt : summary.completedAt) ?? summary.startedAt)} ·{" "}
            {(isCancelled ? summary.cancelledByName : summary.completedByName) || summary.startedByName}
          </p>
        </div>
        <StatusBadge label={isCancelled ? "Cancelled" : "Completed"} tone={isCancelled ? "neutral" : "success"} />
      </div>

      {!isCancelled ? (
        <p className="mt-2 text-sm text-zinc-300">
          {summary.countedItemCount} {summary.countedItemCount === 1 ? "item" : "items"} counted ·{" "}
          {summary.varianceItemCount === 0
            ? "No variances"
            : `${summary.varianceItemCount} ${summary.varianceItemCount === 1 ? "variance" : "variances"}`}
        </p>
      ) : null}

      {note ? (
        <p className="mt-2 truncate text-sm italic text-zinc-400">&ldquo;{note}&rdquo;</p>
      ) : !isCancelled ? (
        <p className="mt-2 text-sm text-zinc-600">No completion note — completed before notes were required.</p>
      ) : null}

      <div className="mt-3 text-right">
        <Link href={`/manager/inventory/cycle-count/${summary.cycleCountId}`} className="text-sm font-medium text-amber-400 hover:underline">
          View Details →
        </Link>
      </div>
    </div>
  );
}
