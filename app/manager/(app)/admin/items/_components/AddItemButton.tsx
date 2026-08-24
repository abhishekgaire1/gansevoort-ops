"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createAdminItemAction, findSimilarItemsAction } from "@/app/actions/adminItems";
import type { SimilarItemCandidate } from "@/app/lib/admin/items";
import type { CategorySummary } from "@/app/actions/itemMaster";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Item Master "+ Add Item" (Part 14/15) -- manual canonical
 * item creation. Duplicate protection is two-tier: an EXACT match is
 * hard-BLOCKED server-side (create_admin_item, GA016) no matter what;
 * a POSSIBLE match (fuzzy similarity, pg_trgm) only WARNS and requires
 * the Admin to deliberately click "Create Anyway" -- never auto-
 * dismissed, never silently created.
 */
export function AddItemButton({ categories, units }: { categories: CategorySummary[]; units: { id: string; code: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [baseUnitId, setBaseUnitId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SimilarItemCandidate[] | null>(null);
  const submittingRef = useRef(false);

  function reset() {
    setName("");
    setCategoryId("");
    setBaseUnitId("");
    setError(null);
    setCandidates(null);
  }

  async function doCreate() {
    setPending(true);
    setError(null);
    const result = await createAdminItemAction(name, categoryId, baseUnitId);
    setPending(false);

    if (!result.ok) {
      if ("existingItemId" in result && result.existingItemId) {
        setCandidates([
          {
            itemId: result.existingItemId,
            itemNumber: "",
            name: result.existingItemName ?? "",
            categoryName: null,
            baseUnitCode: null,
            similarity: 1,
            isExact: true,
          },
        ]);
        return;
      }
      setError(result.message);
      return;
    }

    setOpen(false);
    reset();
    router.refresh();
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    if (!name.trim()) {
      setError("Canonical name is required.");
      return;
    }
    if (!categoryId || !baseUnitId) {
      setError("Category and Base Unit are required.");
      return;
    }

    submittingRef.current = true;
    try {
      if (candidates === null) {
        // First click: check for possible duplicates before creating.
        setPending(true);
        setError(null);
        const similar = await findSimilarItemsAction(name);
        setPending(false);
        if (similar.ok && similar.candidates.length > 0) {
          setCandidates(similar.candidates);
          return;
        }
        await doCreate();
        return;
      }
      // Candidates were already shown -- this click is the deliberate
      // "Create Anyway" confirmation.
      await doCreate();
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonClass}>
        + Add Item
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Add Item</h2>
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

            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Canonical Name
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setCandidates(null);
                  }}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Category
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50">
                  <option value="">Select a category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Base Unit
                <select value={baseUnitId} onChange={(e) => setBaseUnitId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50">
                  <option value="">Select a unit…</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code} — {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-zinc-600">Item Number is generated automatically.</p>
            </div>

            {candidates && candidates.length > 0 ? (
              <div className="mt-4 rounded-xl border border-amber-900/60 bg-amber-950/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">{candidates[0].isExact ? "Existing Item Found" : "Possible Existing Item"}</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {candidates.map((c) => (
                    <li key={c.itemId} className="flex items-center justify-between gap-2 text-sm text-zinc-300">
                      <span>
                        {c.itemNumber ? <span className="font-mono text-xs text-zinc-500">{c.itemNumber} · </span> : null}
                        {c.name}
                        {c.categoryName ? <span className="text-zinc-500"> — {c.categoryName}</span> : null}
                      </span>
                      <a href={`/manager/admin/items/${c.itemId}`} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-amber-400 hover:underline">
                        Use Existing →
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-zinc-500">
                  {candidates[0].isExact
                    ? "An active item with this exact name already exists -- creating a duplicate is not allowed."
                    : "This looks similar to an existing item. Review before creating a new one."}
                </p>
              </div>
            ) : null}

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
              {candidates && candidates.length > 0 && candidates[0].isExact ? null : (
                <button type="button" disabled={pending} onClick={handleSubmit} className={primaryButtonClass}>
                  {pending ? "Checking…" : candidates && candidates.length > 0 ? "Create Anyway" : "Add Item"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
