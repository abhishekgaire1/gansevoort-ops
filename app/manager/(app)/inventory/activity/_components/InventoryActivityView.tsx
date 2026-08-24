"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { listInventoryActivityAction, type InventoryActivityFilters } from "@/app/actions/inventoryActivity";
import type { InventoryActivityPage, GlobalInventoryActivityEntry } from "@/app/lib/inventory/globalActivity";
import type { StorageEligibleLocation } from "@/app/lib/inventory/cycleCounts";
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
} from "../../_lib/activityPresentation";

/**
 * Global Inventory Activity feed -- filters + a chronological, newest-
 * first, cursor-paginated timeline over EVERY item/location. Shares row-
 * presentation helpers with the item-scoped Activity timeline
 * (ItemDetailView.tsx) via activityPresentation.ts -- never a second
 * timeline implementation (Part 5).
 */

const FILTER_LABEL: Record<ActivityTypeFilter, string> = {
  ALL: "All Activity",
  RECEIVED: "Received",
  WITHDRAWALS: "Withdrawals",
  WASTE: "Waste",
  CYCLE_COUNTS: "Cycle Counts",
};

const SEARCH_DEBOUNCE_MS = 300;

export function InventoryActivityView({ initialPage, locations }: { initialPage: InventoryActivityPage; locations: StorageEligibleLocation[] }) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ActivityTypeFilter>("ALL");
  const [locationId, setLocationId] = useState("ALL");
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [entries, setEntries] = useState<GlobalInventoryActivityEntry[]>(initialPage.entries);
  const [cursor, setCursor] = useState<{ occurredAt: string; id: string } | null>(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useMemo(() => new Date(), []);
  const groups = useMemo(() => groupActivityByDate(entries, now), [entries, now]);
  const isFirstRender = useRef(true);

  // Debounce the search box only -- every other filter applies immediately.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filters: InventoryActivityFilters = useMemo(
    () => ({
      search: search.trim() || null,
      filter,
      locationId: locationId === "ALL" ? null : locationId,
      fromDate: fromDate ? new Date(fromDate).toISOString() : null,
      toDate: toDate ? new Date(toDate + "T23:59:59").toISOString() : null,
    }),
    [search, filter, locationId, fromDate, toDate]
  );

  useEffect(() => {
    // The very first render already has the server-fetched, default-filter
    // page as props -- skip refetching identical data on mount (Part 29 /
    // the same anti-flash convention ItemDetailView.tsx uses).
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listInventoryActivityAction(filters, null).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError("Unable to load inventory activity.");
        return;
      }
      setEntries(result.page.entries);
      setCursor(result.page.nextCursor);
    });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  async function handleLoadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    const result = await listInventoryActivityAction(filters, cursor);
    setLoading(false);
    if (!result.ok) {
      setError("Unable to load inventory activity.");
      return;
    }
    setEntries((prev) => [...prev, ...result.page.entries]);
    setCursor(result.page.nextCursor);
  }

  async function retry() {
    setLoading(true);
    setError(null);
    const result = await listInventoryActivityAction(filters, null);
    setLoading(false);
    if (!result.ok) {
      setError("Unable to load inventory activity.");
      return;
    }
    setEntries(result.page.entries);
    setCursor(result.page.nextCursor);
  }

  const hasActiveFilters = search.trim() !== "" || filter !== "ALL" || locationId !== "ALL" || fromDate !== "" || toDate !== "";

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setFilter("ALL");
    setLocationId("ALL");
    setFromDate("");
    setToDate("");
  }

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-1 min-w-[180px] flex-col gap-1 text-xs text-zinc-400">
            Search
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search item…"
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Activity Type
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as ActivityTypeFilter)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            >
              {ACTIVITY_TYPE_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {FILTER_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Location
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="ALL">All</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setMoreFiltersOpen((v) => !v)} className={secondaryButtonClass}>
            More Filters {moreFiltersOpen ? "▴" : "▾"}
          </button>
        </div>

        {moreFiltersOpen ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Date From
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Date To
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
              />
            </label>
          </div>
        ) : null}

        {hasActiveFilters ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
            {search.trim() ? <FilterChip label={`Search: ${search.trim()}`} onRemove={() => { setSearchInput(""); setSearch(""); }} /> : null}
            {filter !== "ALL" ? <FilterChip label={FILTER_LABEL[filter]} onRemove={() => setFilter("ALL")} /> : null}
            {locationId !== "ALL" ? (
              <FilterChip label={locations.find((l) => l.id === locationId)?.name ?? "Location"} onRemove={() => setLocationId("ALL")} />
            ) : null}
            {fromDate ? <FilterChip label={`From ${fromDate}`} onRemove={() => setFromDate("")} /> : null}
            {toDate ? <FilterChip label={`To ${toDate}`} onRemove={() => setToDate("")} /> : null}
            <button type="button" onClick={clearFilters} className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
              Clear Filters
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
          <button type="button" onClick={retry} className={`mt-2 ${secondaryButtonClass}`}>
            Try Again
          </button>
        </div>
      ) : null}

      {!error && entries.length === 0 && !loading ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-500">
            {hasActiveFilters ? "No inventory activity matches these filters." : "No inventory activity recorded yet."}
          </p>
          {hasActiveFilters ? (
            <button type="button" onClick={clearFilters} className={`mt-3 ${secondaryButtonClass}`}>
              Clear Filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{group.label}</p>
              <div className="flex flex-col gap-2">
                {group.entries.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry as GlobalInventoryActivityEntry} now={now} />
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

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-950 px-3 py-1 text-xs text-zinc-300">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter: ${label}`} className="text-zinc-500 hover:text-zinc-200">
        ✕
      </button>
    </span>
  );
}

function ActivityRow({ entry, now }: { entry: GlobalInventoryActivityEntry; now: Date }) {
  const actorVerb = actorLabelVerb(entry.movementType);
  const itemHref = `/manager/inventory/items/${entry.inventoryItemId}?location=${entry.locationId}`;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            <span className="text-zinc-500">{movementGlyph(entry.movementType)}</span>
            {movementDisplayLabel(entry.movementType)}
          </p>
          <Link href={itemHref} className="text-sm font-medium text-zinc-100 hover:text-amber-300 hover:underline">
            {entry.itemName}
          </Link>
        </div>
        <span className={`shrink-0 text-sm font-semibold ${entry.direction === "IN" ? "text-emerald-400" : "text-red-400"}`}>
          {formatSignedQuantity(entry.direction, entry.quantity, entry.baseUnitCode)}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-1 text-sm text-zinc-400">
        <GlobalActivityContext entry={entry} />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
          {actorVerb && entry.actor?.name ? <span>{actorVerb} {entry.actor.name}</span> : null}
          <span className="text-zinc-600">{formatActivityTimestamp(entry.occurredAt, now)}</span>
        </div>
        <Link href={`/manager/inventory/activity/${entry.id}`} className="text-xs font-medium text-amber-400 hover:underline">
          View →
        </Link>
      </div>
    </div>
  );
}

function GlobalActivityContext({ entry }: { entry: GlobalInventoryActivityEntry }) {
  switch (entry.movementType) {
    case "ISSUE_TO_STATION": {
      if (!entry.station) return <p>{entry.locationName}</p>;
      return <p>{withdrawalSourceLabel(entry.locationAttribution, entry.locationName)}{entry.station.name}</p>;
    }
    case "PURCHASE_RECEIPT": {
      return (
        <>
          <p>{entry.locationName}</p>
          {entry.vendor || entry.purchaseDocument ? (
            <p>
              {entry.vendor ? entry.vendor.name : null}
              {entry.vendor && entry.purchaseDocument ? " · " : null}
              {entry.purchaseDocument ? (
                <Link href={`/manager/purchases/${entry.purchaseDocument.id}`} className="font-medium text-amber-400 hover:underline">
                  {entry.purchaseDocument.documentNumber ? `Invoice #${entry.purchaseDocument.documentNumber} →` : "View Document →"}
                </Link>
              ) : null}
            </p>
          ) : null}
        </>
      );
    }
    case "WASTE": {
      return (
        <>
          <p>{entry.locationName}</p>
          {entry.waste ? <p>Reason: {wasteReasonLabel(entry.waste.reasonCode)}</p> : null}
          {entry.waste ? (
            <Link href={`/manager/inventory/waste/${entry.waste.id}`} className="font-medium text-amber-400 hover:underline">
              View Waste Details →
            </Link>
          ) : null}
        </>
      );
    }
    case "COUNT_ADJUSTMENT_IN":
    case "COUNT_ADJUSTMENT_OUT": {
      return (
        <>
          <p>{entry.locationName}</p>
          {entry.cycleCount ? (
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
          ) : null}
        </>
      );
    }
    default:
      return <p>{entry.locationName}</p>;
  }
}
