"use client";

import { useState } from "react";
import { approveNewItemClassification } from "@/app/actions/itemClassification";
import type { InventoryItemSummary, CategorySummary } from "@/app/actions/itemMaster";
import type { UnitSummary } from "@/app/actions/itemMaster";
import { computeNewItemVerificationStatus } from "@/app/lib/itemMaster/newItemVerification";
import { flattenSpendCategoryPaths, type SpendCategoryPath } from "@/app/lib/itemMaster/spendCategoryPaths";

export type { SpendCategoryPath };
export { flattenSpendCategoryPaths };

/**
 * Shared between ItemMappingPanel (per-document review) and the
 * /manager/items/review recovery queue (cross-document review) -- both
 * surfaces approve a line's classification through the exact same
 * authoritative RPCs (approveLineClassificationExistingItemRpc /
 * approveLineClassificationNewItemRpc), never a separate code path.
 */

export const CLASSIFICATION_STATUS_LABEL: Record<string, string> = {
  UNCLASSIFIED: "Not classified",
  PENDING_REVIEW: "Needs review",
  STALE: "Needs re-check",
  CONFIRMED: "Confirmed",
};

export const CLASSIFICATION_STATUS_COLOR: Record<string, string> = {
  UNCLASSIFIED: "bg-zinc-700/40 text-zinc-300",
  PENDING_REVIEW: "bg-amber-400/20 text-amber-300",
  STALE: "bg-orange-400/20 text-orange-300",
  CONFIRMED: "bg-emerald-400/20 text-emerald-300",
};

export function ExistingItemOverrideForm({
  items,
  onCancel,
  onConfirm,
}: {
  items: InventoryItemSummary[];
  onCancel: () => void;
  onConfirm: (itemId: string) => void;
}) {
  const [selected, setSelected] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <select value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100">
        <option value="">Select an item…</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!selected}
        onClick={() => selected && onConfirm(selected)}
        className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-40"
      >
        Confirm
      </button>
      <button type="button" onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300">
        Cancel
      </button>
    </div>
  );
}

export interface NewItemApprovalDefaults {
  name: string;
  disposition: "INVENTORY" | "NON_INVENTORY";
  categoryId: string | null;
  spendCategoryId: string | null;
  baseUnitCode: string | null;
  purchaseUnitCode: string | null;
  receivingBehavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor: number | null;
}

/** Admin Master Data milestone (Part 23): category creation is Admin-only
 * -- there is deliberately no "+ Create Category" here anymore. If the
 * right category doesn't exist yet, the manager leaves this item's
 * category unresolved (VERIFY ITEM stays disabled, same as any other
 * missing required field) and asks an Admin to add it from Admin >
 * Categories; "Refresh" re-fetches the list without closing this review,
 * so the new category is selectable the moment it exists. */
function CategoryNotListedHint({ onRefresh }: { onRefresh: () => void }) {
  return (
    <p className="mt-1 text-[11px] text-zinc-500">
      Not listed? Ask an Admin to add it in Admin &gt; Categories, then{" "}
      <button type="button" onClick={onRefresh} className="text-amber-300 hover:text-amber-200">
        Refresh
      </button>
      .
    </p>
  );
}

/** Small amber "AI" pill shown next to a field's label while its current
 * value still matches what the AI originally proposed. */
function AiBadge() {
  return <span className="rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">AI</span>;
}

/** Subtle secondary text shown under a field once the manager has changed
 * it away from the AI's original proposal for that field. */
function ChangedNote() {
  return <p className="text-[11px] text-zinc-500">Changed from AI suggestion</p>;
}

function fieldStatus(hadAiValue: boolean, changed: boolean): "ai" | "changed" | null {
  if (!hadAiValue) return null;
  return changed ? "changed" : "ai";
}

/**
 * The New Item Review form: always fully editable, every AI-proposed value
 * pre-filled and directly changeable in place -- there is no separate
 * "AI recommendation" summary and no EDIT mode. One button, "VERIFY ITEM",
 * enabled the instant every required field is satisfied (immediately, if
 * the AI already resolved everything) and disabled with the specific
 * missing fields called out otherwise.
 */
export function NewItemApprovalForm({
  purchaseDocumentId,
  lineKey,
  pendingItemId,
  defaults,
  confidence,
  categories,
  spendPaths,
  units,
  onVerified,
  onCategoryCreated,
  onSpendCategoryCreated,
}: {
  purchaseDocumentId: string;
  lineKey: string;
  pendingItemId: string | null;
  defaults: NewItemApprovalDefaults;
  confidence: number | null;
  categories: CategorySummary[];
  spendPaths: SpendCategoryPath[];
  units: UnitSummary[];
  onVerified: () => void;
  /** Called after a brand-new category/spend-category is created inline,
   * so the parent can refetch its lists -- future items must see it too,
   * not just this form's own selection. */
  onCategoryCreated: () => void;
  onSpendCategoryCreated: () => void;
}) {
  const [name, setName] = useState(defaults.name);
  const [disposition, setDisposition] = useState(defaults.disposition);
  const [categoryId, setCategoryId] = useState(defaults.categoryId ?? "");
  const [spendCategoryId, setSpendCategoryId] = useState(defaults.spendCategoryId ?? "");
  const [baseUnitCode, setBaseUnitCode] = useState(defaults.baseUnitCode ?? "");
  const [purchaseUnitCode, setPurchaseUnitCode] = useState(defaults.purchaseUnitCode ?? "");
  const [receivingBehavior, setReceivingBehavior] = useState(defaults.receivingBehavior ?? "SAME_UNIT");
  const [fixedConversionFactor, setFixedConversionFactor] = useState(defaults.fixedConversionFactor !== null ? String(defaults.fixedConversionFactor) : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { missing, canVerify, usesDistinctPurchaseUnit, needsConversionFactor } = computeNewItemVerificationStatus({
    name,
    disposition,
    categoryId,
    spendCategoryId,
    baseUnitCode,
    purchaseUnitCode,
    receivingBehavior,
    fixedConversionFactor,
  });

  async function handleVerify() {
    if (!canVerify) return;
    setPending(true);
    setError(null);
    const result = await approveNewItemClassification({
      purchaseDocumentId,
      lineKey,
      finalName: name.trim(),
      disposition,
      categoryId: disposition === "INVENTORY" ? categoryId || null : null,
      spendCategoryId: spendCategoryId || null,
      baseUnitCode: disposition === "INVENTORY" ? baseUnitCode : null,
      pendingItemId,
      purchaseUnitCode: usesDistinctPurchaseUnit ? purchaseUnitCode : null,
      receivingBehavior: usesDistinctPurchaseUnit ? receivingBehavior : null,
      fixedConversionFactor: needsConversionFactor ? Number(fixedConversionFactor) : null,
    });
    if (!result.ok) {
      setPending(false);
      setError(result.message);
      return;
    }
    onVerified();
  }

  const nameStatus = fieldStatus(true, name !== defaults.name);
  const dispositionStatus = fieldStatus(true, disposition !== defaults.disposition);
  const categoryStatus = fieldStatus(defaults.categoryId !== null, categoryId !== (defaults.categoryId ?? ""));
  const spendCategoryStatus = fieldStatus(defaults.spendCategoryId !== null, spendCategoryId !== (defaults.spendCategoryId ?? ""));
  const baseUnitStatus = fieldStatus(defaults.baseUnitCode !== null, baseUnitCode !== (defaults.baseUnitCode ?? ""));
  const purchaseUnitStatus = fieldStatus(defaults.purchaseUnitCode !== null, purchaseUnitCode !== (defaults.purchaseUnitCode ?? ""));
  const receivingBehaviorStatus = fieldStatus(defaults.receivingBehavior !== null, receivingBehavior !== (defaults.receivingBehavior ?? "SAME_UNIT"));

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-800 bg-amber-950/10 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">AI Recommends</p>
        {confidence !== null ? <p className="text-xs text-zinc-500">Confidence: {Math.round(confidence * 100)}%</p> : null}
      </div>

      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        <span className="flex items-center gap-2">
          Item name
          {nameStatus === "ai" ? <AiBadge /> : null}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`rounded-lg border bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 ${!name.trim() ? "border-red-700" : "border-zinc-700"}`}
        />
        {nameStatus === "changed" ? <ChangedNote /> : null}
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          <span className="flex items-center gap-2">
            Disposition
            {dispositionStatus === "ai" ? <AiBadge /> : null}
          </span>
          <select
            value={disposition}
            onChange={(e) => setDisposition(e.target.value as "INVENTORY" | "NON_INVENTORY")}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
          >
            <option value="INVENTORY">Inventory</option>
            <option value="NON_INVENTORY">Non-inventory</option>
          </select>
          {dispositionStatus === "changed" ? <ChangedNote /> : null}
        </label>
        {disposition === "INVENTORY" ? (
          <>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              <span className="flex items-center gap-2">
                Inventory category
                {categoryStatus === "ai" ? <AiBadge /> : null}
              </span>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className={`rounded-lg border bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 ${!categoryId ? "border-red-700" : "border-zinc-700"}`}
              >
                <option value="">Select category…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {categoryStatus === "changed" ? <ChangedNote /> : null}
              <CategoryNotListedHint onRefresh={onCategoryCreated} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              <span className="flex items-center gap-2">
                Base inventory unit
                {baseUnitStatus === "ai" ? <AiBadge /> : null}
              </span>
              <select
                value={baseUnitCode}
                onChange={(e) => setBaseUnitCode(e.target.value)}
                className={`rounded-lg border bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 ${!baseUnitCode ? "border-red-700" : "border-zinc-700"}`}
              >
                <option value="">Select unit…</option>
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.name} ({u.code})
                  </option>
                ))}
              </select>
              {baseUnitStatus === "changed" ? <ChangedNote /> : null}
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          <span className="flex items-center gap-2">
            Spend category
            {spendCategoryStatus === "ai" ? <AiBadge /> : null}
          </span>
          <select
            value={spendCategoryId}
            onChange={(e) => setSpendCategoryId(e.target.value)}
            className={`rounded-lg border bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 ${!spendCategoryId ? "border-red-700" : "border-zinc-700"}`}
          >
            <option value="">Select category…</option>
            {spendPaths.map((s) => (
              <option key={s.id} value={s.id}>
                {s.path}
              </option>
            ))}
          </select>
          {spendCategoryStatus === "changed" ? <ChangedNote /> : null}
          <CategoryNotListedHint onRefresh={onSpendCategoryCreated} />
        </label>
      </div>

      {disposition === "INVENTORY" ? (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            <span className="flex items-center gap-2">
              Vendor purchase unit
              {purchaseUnitStatus === "ai" ? <AiBadge /> : null}
            </span>
            <select value={purchaseUnitCode} onChange={(e) => setPurchaseUnitCode(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100">
              {/* An empty selection only genuinely means "same as base unit" once a
                  base unit is actually resolved -- otherwise there is nothing yet
                  to be the same as, so this must never silently read as a valid
                  resolved SAME_UNIT proposal. */}
              <option value="">{baseUnitCode ? "Same as base unit" : "Needs selection"}</option>
              {units.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.name} ({u.code})
                </option>
              ))}
            </select>
            {purchaseUnitStatus === "changed" ? <ChangedNote /> : null}
          </label>
          {usesDistinctPurchaseUnit ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                <span className="flex items-center gap-2">
                  Receiving behavior
                  {receivingBehaviorStatus === "ai" ? <AiBadge /> : null}
                </span>
                <select
                  value={receivingBehavior}
                  onChange={(e) => setReceivingBehavior(e.target.value as NewItemApprovalDefaults["receivingBehavior"] & string)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
                >
                  <option value="FIXED_CONVERSION">Fixed conversion (e.g. 1 case = 24)</option>
                  <option value="MEASURE_EACH_DELIVERY">Measure each delivery (weight/volume varies)</option>
                  <option value="COUNT_EACH_DELIVERY">Count each delivery (count varies)</option>
                </select>
                {receivingBehaviorStatus === "changed" ? <ChangedNote /> : null}
              </label>
              {receivingBehavior === "FIXED_CONVERSION" ? (
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Fixed conversion factor
                  <input
                    type="number"
                    value={fixedConversionFactor}
                    onChange={(e) => setFixedConversionFactor(e.target.value)}
                    className={`w-24 rounded-lg border bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 ${
                      !fixedConversionFactor.trim() || Number(fixedConversionFactor) <= 0 ? "border-red-700" : "border-zinc-700"
                    }`}
                  />
                </label>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {missing.length > 0 ? (
        <p className="text-xs text-amber-400">
          {missing.length} field{missing.length === 1 ? "" : "s"} need{missing.length === 1 ? "s" : ""} your input before this item can be verified: {missing.join(", ")}.
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div>
        <button
          type="button"
          onClick={handleVerify}
          disabled={!canVerify || pending}
          className="rounded-full bg-emerald-500 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
        >
          {pending ? "Verifying item…" : "VERIFY ITEM"}
        </button>
      </div>
    </div>
  );
}
