"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { listInventoryItemActivityAction } from "@/app/actions/inventoryItemActivity";
import type { InventoryItemActivityPage, InventoryActivityEntry } from "@/app/lib/inventory/itemActivity";
import { ACTIVITY_TYPE_FILTERS, type ActivityTypeFilter } from "@/app/lib/inventory/activityTypeFilters";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import {
  formatActivityTimestamp,
  formatQuantityMagnitude,
  formatSignedQuantity,
  groupActivityByDate,
  movementDisplayLabel,
  movementGlyph,
  actorLabelVerb,
  wasteReasonLabel,
  withdrawalSourceLabel,
} from "../../../_lib/activityPresentation";

/**
 * Item Detail's Activity tab (Inventory Item Detail Overview + Usage
 * milestone, Part 12) -- unchanged behavior from the original
 * Inventory Item Detail + Activity History milestone, only extracted out
 * of the (now tabbed) ItemDetailView shell. Read-only, newest-first,
 * paginated. Never combines Usage aggregation into this timeline (Part
 * 12's own explicit instruction).
 */

const FILTER_LABEL: Record<ActivityTypeFilter, string> = {
  ALL: "All Activity",
  RECEIVED: "Received",
  WITHDRAWALS: "Withdrawals",
  WASTE: "Waste",
  CYCLE_COUNTS: "Cycle Counts",
};

export function ActivityTab({
  itemId,
  locationId,
  locationName,
  initialActivity,
}: {
  itemId: string;
  locationId: string;
  locationName: string;
  initialActivity: InventoryItemActivityPage;
}) {
  const [filter, setFilter] = useState<ActivityTypeFilter>("ALL");
  const [entries, setEntries] = useState<InventoryActivityEntry[]>(initialActivity.entries);
  const [cursor, setCursor] = useState<{ occurredAt: string; id: string } | null>(initialActivity.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useMemo(() => new Date(), []);
  const groups = useMemo(() => groupActivityByDate(entries, now), [entries, now]);

  async function handleFilterChange(next: ActivityTypeFilter) {
    setFilter(next);
    setLoading(true);
    setError(null);
    const result = await listInventoryItemActivityAction(itemId, locationId, next, null);
    setLoading(false);
    if (!result.ok) {
      setError("Unable to load inventory activity.");
      return;
    }
    setEntries(result.page.entries);
    setCursor(result.page.nextCursor);
  }

  async function handleLoadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    const result = await listInventoryItemActivityAction(itemId, locationId, filter, cursor);
    setLoading(false);
    if (!result.ok) {
      setError("Unable to load inventory activity.");
      return;
    }
    setEntries((prev) => [...prev, ...result.page.entries]);
    setCursor(result.page.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Activity</h2>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <select
            value={filter}
            onChange={(e) => handleFilterChange(e.target.value as ActivityTypeFilter)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
          >
            {ACTIVITY_TYPE_FILTERS.map((option) => (
              <option key={option} value={option}>
                {FILTER_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
          <button type="button" onClick={() => (cursor ? handleLoadMore() : handleFilterChange(filter))} className={`mt-2 ${secondaryButtonClass}`}>
            Try Again
          </button>
        </div>
      ) : null}

      {entries.length === 0 && !loading ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-500">
            {filter === "ALL" ? "No inventory activity recorded yet." : "No activity of this type found."}
          </p>
          {filter === "ALL" ? <p className="mt-1 text-xs text-zinc-600">Historical stock may predate detailed movement tracking.</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{group.label}</p>
              <div className="flex flex-col gap-2">
                {group.entries.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} now={now} locationName={locationName} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && entries.length === 0 ? <p className="text-sm text-zinc-500">Loading…</p> : null}

      {cursor ? (
        <button type="button" onClick={handleLoadMore} disabled={loading} className={`self-start ${secondaryButtonClass}`}>
          {loading ? "Loading…" : "Load More"}
        </button>
      ) : null}
    </div>
  );
}

function ActivityRow({ entry, now, locationName }: { entry: InventoryActivityEntry; now: Date; locationName: string }) {
  const actorVerb = actorLabelVerb(entry.movementType);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <span className="text-zinc-500">{movementGlyph(entry.movementType)}</span>
          {movementDisplayLabel(entry.movementType).toUpperCase()}
        </p>
        <span className={`text-sm font-semibold ${entry.direction === "IN" ? "text-emerald-400" : "text-red-400"}`}>
          {formatSignedQuantity(entry.direction, entry.quantity, entry.baseUnitCode)}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-1 text-sm text-zinc-400">
        <ActivityContext entry={entry} locationName={locationName} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
        {actorVerb && entry.actor?.name ? <span>{actorVerb} {entry.actor.name}</span> : null}
        <span className="text-zinc-600">{formatActivityTimestamp(entry.occurredAt, now)}</span>
      </div>
    </div>
  );
}

function ActivityContext({ entry, locationName }: { entry: InventoryActivityEntry; locationName: string }) {
  switch (entry.movementType) {
    case "ISSUE_TO_STATION": {
      if (!entry.station) return null;
      return <p>{withdrawalSourceLabel(entry.locationAttribution, locationName)}{entry.station.name}</p>;
    }
    case "PURCHASE_RECEIPT": {
      return (
        <>
          {entry.vendor ? <p>{entry.vendor.name}</p> : null}
          {entry.purchaseDocument ? (
            <Link href={`/manager/purchases/${entry.purchaseDocument.id}`} className="font-medium text-amber-400 hover:underline">
              {entry.purchaseDocument.documentNumber ? `Invoice #${entry.purchaseDocument.documentNumber} →` : "View Document →"}
            </Link>
          ) : null}
        </>
      );
    }
    case "WASTE": {
      if (!entry.waste) return null;
      return (
        <>
          <p>{wasteReasonLabel(entry.waste.reasonCode)}</p>
          <Link href={`/manager/inventory/waste/${entry.waste.id}`} className="font-medium text-amber-400 hover:underline">
            View Waste Details →
          </Link>
        </>
      );
    }
    case "COUNT_ADJUSTMENT_IN":
    case "COUNT_ADJUSTMENT_OUT": {
      if (!entry.cycleCount) return null;
      return (
        <>
          <p>
            Expected: {formatQuantityMagnitude(entry.cycleCount.expectedQuantity)} {entry.baseUnitCode}
          </p>
          <p>
            Counted: {formatQuantityMagnitude(entry.cycleCount.countedQuantity)} {entry.baseUnitCode}
          </p>
          <Link href={`/manager/inventory/cycle-count/${entry.cycleCount.id}`} className="font-medium text-amber-400 hover:underline">
            Cycle Count →
          </Link>
        </>
      );
    }
    default:
      return null;
  }
}
