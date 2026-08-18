"use client";

import { useState } from "react";
import type { CategorySummary, SpendCategorySummary, UnitSummary } from "@/app/actions/itemMaster";
import { flattenSpendCategoryPaths, NewItemApprovalForm, type NewItemApprovalDefaults } from "./ItemClassificationForms";

export interface NewItemReviewCandidate {
  key: string;
  purchaseDocumentId: string;
  lineKey: string;
  pendingItemId: string;
  vendorName: string | null;
  documentNumber: string | null;
  vendorSku: string | null;
  description: string | null;
  confidence: number | null;
  defaults: NewItemApprovalDefaults;
}

/**
 * The blocking, one-at-a-time "NEW ITEMS FOUND" review flow. The modal
 * itself is always the editable confirmation form -- every AI-proposed
 * value is pre-filled and directly changeable in place, with no separate
 * "AI recommendation summary -> EDIT -> form" split. One button, VERIFY
 * ITEM, is the only authoritative action.
 *
 * One modal for ALL new items on this screen, not one popup per item --
 * "index of total" navigation, closable at any point (a manager may always
 * save/leave and come back later; only Send for Final Review is actually
 * gated, elsewhere).
 */
export function NewItemReviewModal({
  candidates,
  categories,
  spendCategories,
  units,
  onClose,
  onResolved,
  onCategoriesRefetch,
}: {
  candidates: NewItemReviewCandidate[];
  categories: CategorySummary[];
  spendCategories: SpendCategorySummary[];
  units: UnitSummary[];
  onClose: () => void;
  onResolved: (key: string) => void;
  onCategoriesRefetch: () => Promise<void>;
}) {
  const [index, setIndex] = useState(0);
  const spendPaths = flattenSpendCategoryPaths(spendCategories);

  if (candidates.length === 0) return null;
  const current = candidates[Math.min(index, candidates.length - 1)];

  function advance(key: string) {
    onResolved(key);
    if (candidates.length <= 1) {
      onClose();
      return;
    }
    setIndex((i) => Math.min(i, candidates.length - 2));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-100">
            New Items Found <span className="text-sm font-normal text-zinc-500">{index + 1} of {candidates.length}</span>
          </h2>
          <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-300">
            Close (review later)
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Vendor</p>
          <p className="text-sm text-zinc-200">
            {current.vendorName ?? "—"}
            {current.documentNumber ? ` · #${current.documentNumber}` : ""}
          </p>
          <p className="mt-3 text-xs uppercase tracking-wide text-zinc-500">Vendor description</p>
          <p className="text-sm text-zinc-200">{current.description ?? "—"}</p>
          {current.vendorSku ? (
            <>
              <p className="mt-3 text-xs uppercase tracking-wide text-zinc-500">SKU</p>
              <p className="text-sm text-zinc-200">{current.vendorSku}</p>
            </>
          ) : null}
        </div>

        <div className="mt-4">
          <NewItemApprovalForm
            key={current.key}
            purchaseDocumentId={current.purchaseDocumentId}
            lineKey={current.lineKey}
            pendingItemId={current.pendingItemId}
            defaults={current.defaults}
            confidence={current.confidence}
            categories={categories}
            spendPaths={spendPaths}
            units={units}
            onVerified={() => advance(current.key)}
            onCategoryCreated={onCategoriesRefetch}
            onSpendCategoryCreated={onCategoriesRefetch}
          />
        </div>
      </div>
    </div>
  );
}
