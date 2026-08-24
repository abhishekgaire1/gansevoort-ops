"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listAdminStationsAction } from "@/app/actions/adminStations";
import type { AdminStationSummary } from "@/app/lib/admin/stations";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Admin -> Stations list (Admin Foundation milestone, Part 20/42) --
 * compact scannable rows, no oversized dashboard cards, no Delete button
 * anywhere (Part 24/49 -- deactivate/reactivate only).
 */
export function AdminStationsView({ initialStations }: { initialStations: AdminStationSummary[] }) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "inactive" | "ALL">("ALL");
  const [stations, setStations] = useState<AdminStationSummary[]>(initialStations);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAdminStationsAction(search.trim() || null, status === "ALL" ? null : status).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError("Unable to load stations.");
        return;
      }
      setStations(result.stations);
    });
    return () => {
      cancelled = true;
    };
  }, [search, status]);

  const hasActiveFilters = search.trim() !== "" || status !== "ALL";

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setStatus("ALL");
  }

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <label className="flex flex-1 min-w-[180px] flex-col gap-1 text-xs text-zinc-400">
          Search
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search stations…"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as "active" | "inactive" | "ALL")} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">
            <option value="ALL">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      ) : stations.length === 0 && !loading ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-500">{hasActiveFilters ? "No stations match these filters." : "No stations have been configured."}</p>
          {hasActiveFilters ? (
            <button type="button" onClick={clearFilters} className={`mt-3 ${secondaryButtonClass}`}>
              Clear Filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
          {stations.map((station) => (
            <Link
              key={station.stationId}
              href={`/manager/admin/stations/${station.stationId}`}
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-800/50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100">{station.name}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {station.isActive
                    ? `Default for ${station.defaultEmployeeCount} employee${station.defaultEmployeeCount === 1 ? "" : "s"}`
                    : "Not available for new withdrawals"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <StatusBadge label={station.isActive ? "Active" : "Inactive"} tone={station.isActive ? "success" : "neutral"} />
                <span className="text-xs font-medium text-amber-400">View / Edit →</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
