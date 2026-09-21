"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createLocationAction } from "@/app/actions/adminLocations";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Storage Locations "+ Add Location". A new location is created
 * active; storage-eligibility is chosen here (default on) so it can be used
 * for receiving immediately. It is never created as the org default -- that
 * is an explicit, separate action.
 */
export function AddLocationButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [storageEligible, setStorageEligible] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setStorageEligible(true);
    setError(null);
  }

  async function handleSubmit() {
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    const result = await createLocationAction(name, storageEligible);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonClass}>
        + Add Location
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Add Location</h2>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                aria-label="Close"
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                ✕
              </button>
            </div>

            <label className="mt-4 flex flex-col gap-1 text-xs text-zinc-400">
              Location Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Central Walk-In"
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
            </label>

            <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={storageEligible} onChange={(e) => setStorageEligible(e.target.checked)} className="h-4 w-4 rounded border-zinc-600 bg-zinc-950" />
              Storage-eligible (available as a receiving destination)
            </label>
            <p className="mt-2 text-xs text-zinc-500">Status: Active</p>

            {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
              <button type="button" disabled={pending || !name.trim()} onClick={handleSubmit} className={primaryButtonClass}>
                {pending ? "Adding…" : "Add Location"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
