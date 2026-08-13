"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createVendor, setVendorActive, type VendorSummary } from "@/app/actions/vendors";

export function VendorsManager({ initialVendors }: { initialVendors: VendorSummary[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    const result = await createVendor(name);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName("");
    router.refresh();
  }

  async function handleToggle(vendor: VendorSummary) {
    setTogglingId(vendor.id);
    await setVendorActive(vendor.id, !vendor.isActive);
    setTogglingId(null);
    router.refresh();
  }

  return (
    <div className="mt-6 flex flex-col gap-6">
      <form onSubmit={handleAdd} className="flex gap-3">
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Vendor name"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
        />
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
        >
          {pending ? "Adding…" : "Add Vendor"}
        </button>
      </form>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {initialVendors.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No vendors yet.</p>
        ) : (
          initialVendors.map((vendor) => (
            <div key={vendor.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className={`text-sm ${vendor.isActive ? "text-zinc-100" : "text-zinc-500 line-through"}`}>{vendor.name}</span>
              <button
                type="button"
                disabled={togglingId === vendor.id}
                onClick={() => handleToggle(vendor)}
                className="shrink-0 rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40"
              >
                {togglingId === vendor.id ? "…" : vendor.isActive ? "Deactivate" : "Activate"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
