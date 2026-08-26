"use client";

import { useState } from "react";
import Link from "next/link";
import {
  listUnresolvedClassificationsForReview,
  approveExistingItemClassification,
  markLineNonInventory,
} from "@/app/actions/itemClassification";
import type { UnresolvedClassificationRow } from "@/app/lib/itemMaster/listUnresolvedClassifications";
import { listInventoryCategories, listSpendCategories } from "@/app/actions/itemMaster";
import type { InventoryItemSummary, CategorySummary, SpendCategorySummary, UnitSummary } from "@/app/actions/itemMaster";
import {
  CLASSIFICATION_STATUS_LABEL,
  CLASSIFICATION_STATUS_COLOR,
  ExistingItemOverrideForm,
  type ExistingItemVendorPackageInput,
} from "@/app/manager/(app)/_components/ItemClassificationForms";
import { NewItemReviewModal, type NewItemReviewCandidate } from "@/app/manager/(app)/_components/NewItemReviewModal";

function lineToCandidate(line: UnresolvedClassificationRow): NewItemReviewCandidate | null {
  if (!line.aiSuggestedIsNewProposal || !line.aiSuggestedInventoryItemId || !line.aiNewItemProposal) return null;
  return {
    key: `${line.purchaseDocumentId}:${line.lineKey}`,
    purchaseDocumentId: line.purchaseDocumentId,
    lineKey: line.lineKey,
    pendingItemId: line.aiSuggestedInventoryItemId,
    vendorName: line.vendorName,
    documentNumber: line.documentNumber,
    vendorSku: line.vendorSku,
    description: line.description,
    confidence: line.aiConfidence,
    defaults: {
      name: line.aiSuggestedInventoryItemName ?? line.description ?? "",
      disposition: line.aiNewItemProposal.disposition,
      categoryId: line.aiNewItemProposal.categoryId,
      spendCategoryId: line.aiNewItemProposal.spendCategoryId,
      baseUnitCode: line.aiNewItemProposal.baseUnitCode,
      purchaseUnitCode: line.aiProposedPurchaseUnit?.vendorPurchaseUnitCode ?? null,
      receivingBehavior: line.aiProposedPurchaseUnit?.receivingBehavior ?? null,
      fixedConversionFactor: line.aiProposedPurchaseUnit?.fixedConversionFactor ?? null,
    },
  };
}

export function ReviewQueueManager({
  initialLines,
  items,
  categories: initialCategories,
  spendCategories: initialSpendCategories,
  units,
}: {
  initialLines: UnresolvedClassificationRow[];
  items: InventoryItemSummary[];
  categories: CategorySummary[];
  spendCategories: SpendCategorySummary[];
  units: UnitSummary[];
}) {
  const [lines, setLines] = useState(initialLines);
  const [categories, setCategories] = useState(initialCategories);
  const [spendCategories, setSpendCategories] = useState(initialSpendCategories);
  const [error, setError] = useState<string | null>(null);
  const [overrideFormKey, setOverrideFormKey] = useState<string | null>(null);
  const [showNewItemModal, setShowNewItemModal] = useState(false);

  const newItemCandidates = lines.map(lineToCandidate).filter((c): c is NewItemReviewCandidate => c !== null);

  async function refresh() {
    const result = await listUnresolvedClassificationsForReview();
    if (result.ok) setLines(result.lines);
  }

  async function refetchCategories() {
    const [categoriesResult, spendResult] = await Promise.all([listInventoryCategories(), listSpendCategories()]);
    if (categoriesResult.ok) setCategories(categoriesResult.categories);
    if (spendResult.ok) setSpendCategories(spendResult.categories);
  }

  function rowKey(line: UnresolvedClassificationRow) {
    return `${line.purchaseDocumentId}:${line.lineKey}`;
  }

  async function handleApproveExisting(line: UnresolvedClassificationRow, inventoryItemId: string, vendorPackage?: ExistingItemVendorPackageInput | null) {
    const result = await approveExistingItemClassification({
      purchaseDocumentId: line.purchaseDocumentId,
      lineKey: line.lineKey,
      inventoryItemId,
      purchaseUnitCode: vendorPackage?.purchaseUnitCode ?? null,
      receivingBehavior: vendorPackage?.receivingBehavior ?? null,
      fixedConversionFactor: vendorPackage?.fixedConversionFactor ?? null,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOverrideFormKey(null);
    await refresh();
  }

  async function handleMarkNonInventory(line: UnresolvedClassificationRow) {
    const name = line.aiSuggestedInventoryItemName ?? line.description ?? "Non-inventory line";
    const result = await markLineNonInventory(
      line.purchaseDocumentId,
      line.lineKey,
      name,
      line.aiSuggestedIsNewProposal ? line.aiSuggestedInventoryItemId : null
    );
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh();
  }

  if (lines.length === 0) {
    return <p className="mt-6 text-sm text-zinc-500">Nothing needs review right now.</p>;
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {newItemCandidates.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowNewItemModal(true)}
          className="self-start rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-zinc-950"
        >
          Review New Items ({newItemCandidates.length})
        </button>
      ) : null}

      <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {lines.map((line) => {
          const key = rowKey(line);
          return (
            <div key={key} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/manager/purchases/${line.purchaseDocumentId}`} className="text-xs text-zinc-500 hover:text-zinc-300">
                    {line.vendorName ?? "Unknown vendor"}
                    {line.documentNumber ? ` · #${line.documentNumber}` : ""}
                  </Link>
                  <p className="truncate text-sm text-zinc-100">{line.description ?? line.vendorSku ?? "—"}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {line.vendorSku ? `SKU ${line.vendorSku}` : null}
                    {line.aiSuggestedInventoryItemName
                      ? ` · AI suggests ${line.aiSuggestedIsNewProposal ? "new item" : "existing item"} "${line.aiSuggestedInventoryItemName}"${
                          line.aiConfidence !== null ? ` (${Math.round(line.aiConfidence * 100)}%)` : ""
                        }`
                      : ""}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${CLASSIFICATION_STATUS_COLOR[line.status]}`}>
                  {CLASSIFICATION_STATUS_LABEL[line.status]}
                </span>
              </div>

              {!line.aiSuggestedIsNewProposal ? (
                <div className="flex flex-wrap items-center gap-2">
                  {line.aiSuggestedInventoryItemId ? (
                    <button
                      type="button"
                      onClick={() => handleApproveExisting(line, line.aiSuggestedInventoryItemId!)}
                      className="rounded-full border border-emerald-700 px-3 py-1 text-xs text-emerald-300"
                    >
                      Approve “{line.aiSuggestedInventoryItemName}”
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOverrideFormKey(overrideFormKey === key ? null : key)}
                    className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                  >
                    Choose Different Item
                  </button>
                  <button type="button" onClick={() => handleMarkNonInventory(line)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                    Mark Non-Inventory
                  </button>
                </div>
              ) : null}

              {overrideFormKey === key ? (
                <ExistingItemOverrideForm
                  items={items}
                  units={units}
                  onCancel={() => setOverrideFormKey(null)}
                  onConfirm={(itemId, vendorPackage) => handleApproveExisting(line, itemId, vendorPackage)}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {showNewItemModal ? (
        <NewItemReviewModal
          candidates={newItemCandidates}
          categories={categories}
          spendCategories={spendCategories}
          units={units}
          onClose={() => setShowNewItemModal(false)}
          onResolved={() => refresh()}
          onCategoriesRefetch={refetchCategories}
        />
      ) : null}
    </div>
  );
}
