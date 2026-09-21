"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  setDefaultLocationAction,
  setLocationStatusAction,
  setLocationStorageEligibleAction,
  updateLocationNameAction,
} from "@/app/actions/adminLocations";
import type { AdminLocationSummary } from "@/app/lib/admin/locations";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Storage Locations list. Triage-first scannable rows with
 * semantic badges (Default / Storage / Active), the dependency signals an
 * admin needs before deactivating a location, and inline actions. No Delete
 * anywhere -- locations are deactivated, never hard-deleted.
 */
export function AdminLocationsView({ initialLocations }: { initialLocations: AdminLocationSummary[] }) {
  const router = useRouter();
  const [locations] = useState<AdminLocationSummary[]>(initialLocations);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<AdminLocationSummary | null>(null);

  async function run(locationId: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setPendingId(locationId);
    setRowError((prev) => ({ ...prev, [locationId]: "" }));
    const result = await fn();
    setPendingId(null);
    if (!result.ok) {
      setRowError((prev) => ({ ...prev, [locationId]: result.message ?? "Unable to save." }));
      return;
    }
    router.refresh();
  }

  function dependencySummary(loc: AdminLocationSummary): string {
    const parts: string[] = [];
    if (loc.hasStock) parts.push("holds stock");
    if (loc.movementCount > 0) parts.push(`${loc.movementCount} movement${loc.movementCount === 1 ? "" : "s"}`);
    if (loc.stationCount > 0) parts.push(`${loc.stationCount} station${loc.stationCount === 1 ? "" : "s"}`);
    if (loc.receiptCount > 0) parts.push(`${loc.receiptCount} receiving doc${loc.receiptCount === 1 ? "" : "s"}`);
    return parts.length ? parts.join(" · ") : "No inventory history";
  }

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {locations.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">No storage locations configured.</p>
        ) : (
          locations.map((loc) => {
            const busy = pendingId === loc.locationId;
            return (
              <div key={loc.locationId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-zinc-100">{loc.name}</p>
                    {loc.isDefault ? <StatusBadge label="Default" tone="info" /> : null}
                    <StatusBadge label={loc.isStorageEligible ? "Storage" : "Not storage"} tone={loc.isStorageEligible ? "success" : "neutral"} />
                    <StatusBadge label={loc.isActive ? "Active" : "Inactive"} tone={loc.isActive ? "success" : "neutral"} />
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">{dependencySummary(loc)}</p>
                  {rowError[loc.locationId] ? <p className="mt-1 text-xs text-red-400">{rowError[loc.locationId]}</p> : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button type="button" disabled={busy} onClick={() => setRenaming(loc)} className={secondaryButtonClass}>
                    Rename
                  </button>
                  {!loc.isDefault && loc.isActive && loc.isStorageEligible ? (
                    <button type="button" disabled={busy} onClick={() => run(loc.locationId, () => setDefaultLocationAction(loc.locationId))} className={secondaryButtonClass}>
                      Set default
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(loc.locationId, () => setLocationStorageEligibleAction(loc.locationId, !loc.isStorageEligible))}
                    className={secondaryButtonClass}
                  >
                    {loc.isStorageEligible ? "Remove storage" : "Make storage"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(loc.locationId, () => setLocationStatusAction(loc.locationId, !loc.isActive))}
                    className={secondaryButtonClass}
                  >
                    {loc.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {renaming ? (
        <RenameModal
          location={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function RenameModal({ location, onClose, onSaved }: { location: AdminLocationSummary; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(location.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    const result = await updateLocationNameAction(location.locationId, name);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <div className="flex items-start justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Rename Location</h2>
          <button type="button" disabled={pending} onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40">
            ✕
          </button>
        </div>
        <label className="mt-4 flex flex-col gap-1 text-xs text-zinc-400">
          Location Name
          <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
        </label>
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-3">
          <button type="button" disabled={pending} onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="button" disabled={pending || !name.trim()} onClick={handleSubmit} className={primaryButtonClass}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
