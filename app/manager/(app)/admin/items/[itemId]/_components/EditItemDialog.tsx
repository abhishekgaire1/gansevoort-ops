"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateAdminItemDetailsAction } from "@/app/actions/adminItems";
import type { AdminItemDetail } from "@/app/lib/admin/items";
import type { CategorySummary } from "@/app/actions/itemMaster";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { inputClass, selectClass, labelClass, inlineSuccessClass } from "@/app/components/manager/surfaces";

/**
 * Edit Item (spec sections 5/6) -- a structured form followed by a
 * mandatory "Review changes" step before anything saves. This pass's
 * editable field set (name, category) is metadata-only, so the impact
 * classification is always "No inventory impact" -- deliberately not a
 * generic diff-scanner over fields that aren't editable here yet (vendor
 * packages/usage units/adjustments each have their own dedicated,
 * impact-appropriate flow elsewhere in the workspace, not folded into
 * this dialog).
 */
export function EditItemDialog({ item, categories, onClose }: { item: AdminItemDetail; categories: CategorySummary[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(item.name);
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const [step, setStep] = useState<"form" | "review">("form");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<{ existingItemId: string; existingItemName: string } | null>(null);

  const currentCategoryName = categories.find((c) => c.id === item.categoryId)?.name ?? "—";
  const newCategoryName = categories.find((c) => c.id === categoryId)?.name ?? "—";
  const nameChanged = name !== item.name;
  const categoryChanged = categoryId !== (item.categoryId ?? "");
  const dirty = nameChanged || categoryChanged;

  async function handleConfirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    setDuplicateOf(null);
    const result = await updateAdminItemDetailsAction(item.itemId, name, categoryId);
    setPending(false);
    if (!result.ok) {
      if ("existingItemId" in result && result.existingItemId && result.existingItemName) {
        setDuplicateOf({ existingItemId: result.existingItemId, existingItemName: result.existingItemName });
        return;
      }
      setError("message" in result ? result.message : "Unable to save item.");
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold text-zinc-100">Edit Item</h2>

        {step === "form" ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">General information</p>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Canonical name
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </label>
            <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Categories and disposition</p>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Category
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectClass}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={onClose} className={secondaryButtonClass}>
                Cancel
              </button>
              <button type="button" disabled={!dirty} onClick={() => setStep("review")} className={primaryButtonClass}>
                Review changes
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <div className={inlineSuccessClass}>
              <p className="font-semibold">No inventory impact</p>
              <p className="mt-1">This change will not alter current quantities, valuation, receipts, or withdrawals.</p>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              {nameChanged ? (
                <DiffRow label="Name" before={item.name} after={name} />
              ) : null}
              {categoryChanged ? (
                <DiffRow label="Category" before={currentCategoryName} after={newCategoryName} />
              ) : null}
              {!nameChanged && !categoryChanged ? <p className="text-zinc-500">No changes.</p> : null}
            </div>
            {duplicateOf ? (
              <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-3">
                <p className="text-sm text-amber-300">
                  An active item named &ldquo;{duplicateOf.existingItemName}&rdquo; already exists.{" "}
                  <a href={`/manager/admin/items/${duplicateOf.existingItemId}`} className="underline">
                    View it
                  </a>
                  .
                </p>
              </div>
            ) : null}
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={() => setStep("form")} className={secondaryButtonClass}>
                Back
              </button>
              <button type="button" disabled={pending} onClick={handleConfirm} className={primaryButtonClass}>
                {pending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DiffRow({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <span className="text-zinc-400">{label}</span>
      <span className="tabular-nums text-zinc-200">
        {before} → <span className="font-medium text-amber-300">{after}</span>
      </span>
    </div>
  );
}
