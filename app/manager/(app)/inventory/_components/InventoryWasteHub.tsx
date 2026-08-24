"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listInventoryWasteEventsAction, listWasteStorageLocationsForOrganization } from "@/app/actions/inventoryWaste";
import { WASTE_REASON_CODES, WASTE_REASON_LABELS } from "@/app/lib/inventory/wasteReasons";
import type { InventoryWasteEventSummary } from "@/app/lib/inventory/waste";
import type { StorageEligibleLocation } from "@/app/lib/inventory/cycleCounts";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { EmptyState } from "@/app/components/manager/EmptyState";
import { primaryButtonClass } from "@/app/components/manager/buttonStyles";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatQuantity(value: string): string {
  const num = Number(value);
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
}

type ReasonFilter = "ALL" | (typeof WASTE_REASON_CODES)[number];

/**
 * The Inventory Waste hub/history landing page (Part 4/18) -- a small
 * "+ Record Waste" entry point plus recent history, not a dashboard.
 * Keeps filtering simple (Part 20): location, reason, newest first.
 */
export function InventoryWasteHub() {
  const [events, setEvents] = useState<InventoryWasteEventSummary[] | null>(null);
  const [locations, setLocations] = useState<StorageEligibleLocation[] | null>(null);
  const [locationFilter, setLocationFilter] = useState<string>("ALL");
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>("ALL");

  useEffect(() => {
    listWasteStorageLocationsForOrganization().then((result) => {
      if (result.ok) setLocations(result.locations);
    });
  }, []);

  const load = useCallback(async () => {
    const result = await listInventoryWasteEventsAction({
      locationId: locationFilter === "ALL" ? null : locationFilter,
      reasonCode: reasonFilter === "ALL" ? null : reasonFilter,
      limit: 50,
    });
    if (result.ok) setEvents(result.events);
  }, [locationFilter, reasonFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className="mt-4 flex flex-col gap-6">
      <PageHeader
        title="Inventory Waste"
        description="Record known inventory loss from physical storage."
        action={
          <Link href="/manager/inventory/waste/new" className={primaryButtonClass}>
            + Record Waste
          </Link>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Waste</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={reasonFilter}
              onChange={(e) => setReasonFilter(e.target.value as ReasonFilter)}
              className="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-1 text-xs text-zinc-300"
            >
              <option value="ALL">All reasons</option>
              {WASTE_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {WASTE_REASON_LABELS[code]}
                </option>
              ))}
            </select>
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

        {events === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : events.length === 0 ? (
          <EmptyState
            message="No inventory waste recorded yet."
            action={
              <Link href="/manager/inventory/waste/new" className={primaryButtonClass}>
                + Record Waste
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {events.map((event) => (
              <WasteCard key={event.wasteEventId} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WasteCard({ event }: { event: InventoryWasteEventSummary }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-100">{event.itemName}</p>
          <p className="text-xs text-zinc-500">{event.locationName}</p>
          <p className="mt-2 text-sm text-zinc-300">
            {formatQuantity(event.quantity)} {event.unitCode} · {WASTE_REASON_LABELS[event.reasonCode]}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {formatDateTime(event.recordedAt)} · {event.recordedByName}
          </p>
          {event.note ? <p className="mt-2 truncate text-sm italic text-zinc-400">&ldquo;{event.note}&rdquo;</p> : null}
        </div>
      </div>
      <div className="mt-3 text-right">
        <Link href={`/manager/inventory/waste/${event.wasteEventId}`} className="text-sm font-medium text-amber-400 hover:underline">
          View Details →
        </Link>
      </div>
    </div>
  );
}
