"use client";

import { useState, type ReactNode } from "react";
import { approveNewItemClassification } from "@/app/actions/itemClassification";
import type { InventoryItemSummary, CategorySummary } from "@/app/actions/itemMaster";
import type { UnitSummary } from "@/app/actions/itemMaster";
import { computeNewItemVerificationStatus } from "@/app/lib/itemMaster/newItemVerification";
import { flattenSpendCategoryPaths, type SpendCategoryPath } from "@/app/lib/itemMaster/spendCategoryPaths";
import {
  categoriesMatch,
  derivePurchaseSummary,
  isReceivingBehaviorInferred,
  shouldShowDispositionControl,
  shouldAutoExpandAdvancedSettings,
} from "@/app/lib/itemMaster/simplifiedVerificationView";

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

/** Optional vendor-specific purchase package a manager registers for THIS
 * vendor/SKU while confirming an already-existing item (approved-plan
 * §8) -- passed straight through to approveExistingItemClassification's
 * own trailing params. Null means "don't touch this vendor/SKU's package
 * configuration," never "clear an existing one." */
export interface ExistingItemVendorPackageInput {
  purchaseUnitCode: string;
  receivingBehavior: "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";
  fixedConversionFactor: number | null;
}

export function ExistingItemOverrideForm({
  items,
  units,
  onCancel,
  onConfirm,
}: {
  items: InventoryItemSummary[];
  units: UnitSummary[];
  onCancel: () => void;
  onConfirm: (itemId: string, vendorPackage: ExistingItemVendorPackageInput | null) => void;
}) {
  const [selected, setSelected] = useState("");
  const [registeringPackage, setRegisteringPackage] = useState(false);
  const [purchaseUnitCode, setPurchaseUnitCode] = useState("");
  const [receivingBehavior, setReceivingBehavior] = useState<"FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY">("FIXED_CONVERSION");
  const [fixedConversionFactor, setFixedConversionFactor] = useState("");

  const selectedItem = items.find((i) => i.id === selected) ?? null;
  const baseUnitCode = selectedItem?.baseUnitCode ?? null;
  const usesDistinctPurchaseUnit = purchaseUnitCode !== "" && purchaseUnitCode !== baseUnitCode;
  const needsConversionFactor = usesDistinctPurchaseUnit && receivingBehavior === "FIXED_CONVERSION";
  const packageValid = !registeringPackage || !usesDistinctPurchaseUnit || !needsConversionFactor || (fixedConversionFactor.trim() !== "" && Number(fixedConversionFactor) > 0);

  function handleConfirm() {
    if (!selected || !packageValid) return;
    const vendorPackage: ExistingItemVendorPackageInput | null =
      registeringPackage && usesDistinctPurchaseUnit
        ? { purchaseUnitCode, receivingBehavior, fixedConversionFactor: needsConversionFactor ? Number(fixedConversionFactor) : null }
        : null;
    onConfirm(selected, vendorPackage);
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex flex-wrap items-center gap-2">
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
          disabled={!selected || !packageValid}
          onClick={handleConfirm}
          className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-40"
        >
          Confirm
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>

      {selectedItem?.disposition === "INVENTORY" ? (
        registeringPackage ? (
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">This vendor&apos;s purchase package</p>
            <div className="flex flex-wrap items-start gap-3">
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Vendor purchase unit
                <select value={purchaseUnitCode} onChange={(e) => setPurchaseUnitCode(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100">
                  <option value="">{baseUnitCode ? "Same as base unit" : "Needs selection"}</option>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.name} ({u.code})
                    </option>
                  ))}
                </select>
              </label>
              {usesDistinctPurchaseUnit ? (
                <>
                  <label className="flex flex-col gap-1 text-xs text-zinc-400">
                    Receiving behavior
                    <select
                      value={receivingBehavior}
                      onChange={(e) => setReceivingBehavior(e.target.value as typeof receivingBehavior)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="FIXED_CONVERSION">Fixed conversion (e.g. 1 case = 24)</option>
                      <option value="MEASURE_EACH_DELIVERY">Measure each delivery (weight/volume varies)</option>
                      <option value="COUNT_EACH_DELIVERY">Count each delivery (count varies)</option>
                    </select>
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
            {needsConversionFactor ? <EquationLine contextLabel="Vendor" factor={fixedConversionFactor} fromUnit={purchaseUnitCode} toUnit={baseUnitCode ?? ""} /> : null}
            <button type="button" onClick={() => setRegisteringPackage(false)} className="self-start text-[11px] text-zinc-500 hover:text-zinc-300">
              Cancel package registration
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setRegisteringPackage(true)} className="self-start text-[11px] font-medium text-amber-300 hover:text-amber-200">
            + Register this vendor&apos;s purchase package
          </button>
        )
      ) : null}
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

/** Section heading used throughout the New Item Review form's 5-part
 * layout (approved-plan §7: Inventory identity / How this item will be
 * used / How this vendor sells it / Correlation review / Verification). */
function ReviewSectionHeading({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{children}</p>;
}

/** Small "Edit" affordance shown next to a simplified summary row --
 * opens Advanced Settings (the single place raw/technical controls
 * render) rather than a second, separately-bound copy of the same
 * inputs. */
function EditLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-[11px] font-medium text-zinc-500 hover:text-zinc-300">
      Edit
    </button>
  );
}

/** A human-readable, always-derived (never separately stored) correlation
 * line -- "1 CASE = 24 EACH" -- used both inline next to the field that
 * produced it and again in the Correlation Review section so the manager
 * sees the SAME derived relationship twice, never two different
 * computations of it. */
function EquationLine({ contextLabel, factor, fromUnit, toUnit }: { contextLabel: string; factor: string; fromUnit: string; toUnit: string }) {
  if (!fromUnit || !toUnit || !factor.trim() || Number(factor) <= 0) return null;
  return (
    <p className="text-[11px] text-zinc-500">
      {contextLabel}: 1 {fromUnit} = {factor} {toUnit}
    </p>
  );
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
  // Secondary kiosk usage unit -- NEVER AI-proposed (approved-plan §6),
  // so there is deliberately no `defaults` field for it and no AiBadge/
  // ChangedNote treatment anywhere below; it always starts empty (a
  // one-unit item is the default, fully valid state).
  const [secondaryUsageUnitCode, setSecondaryUsageUnitCode] = useState("");
  const [secondaryConversionFactor, setSecondaryConversionFactor] = useState("");
  // Weigh-at-kiosk restoration (20260811100126): the secondary usage
  // unit's mode. Defaults to "fixed" -- the manager must explicitly pick
  // "Measure at withdrawal," it is never auto-selected.
  const [secondaryMode, setSecondaryMode] = useState<"fixed" | "measured">("fixed");
  // "+ Add another withdrawal option" -- the secondary-unit composer is
  // hidden by default (a one-unit item is the common case) and revealed
  // either by this explicit action or by opening Advanced Settings below;
  // it is never re-hidden automatically once a secondary unit is chosen.
  const [secondaryComposerOpen, setSecondaryComposerOpen] = useState(false);
  // Advanced Settings: closed by default; `null` means "the manager
  // hasn't explicitly toggled it yet," in which case it reactively
  // auto-expands for the cases below. Once the manager clicks the
  // toggle, their explicit choice wins from then on.
  const [advancedManuallyOpen, setAdvancedManuallyOpen] = useState<boolean | null>(null);
  const [categoryDiscrepancyAcknowledged, setCategoryDiscrepancyAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const secondaryRequiresMeasurement = secondaryMode === "measured";

  const { missing, canVerify, usesDistinctPurchaseUnit, needsConversionFactor, hasSecondaryUsageUnit, sameCodeDifferentFactorWarning } = computeNewItemVerificationStatus({
    name,
    disposition,
    categoryId,
    spendCategoryId,
    baseUnitCode,
    purchaseUnitCode,
    receivingBehavior,
    fixedConversionFactor,
    secondaryUsageUnitCode,
    secondaryConversionFactor,
    secondaryRequiresMeasurement,
  });

  const categoryName = categories.find((c) => c.id === categoryId)?.name ?? null;
  const spendPath = spendPaths.find((s) => s.id === spendCategoryId)?.path ?? null;
  const categoriesDoMatch = disposition === "INVENTORY" && categoriesMatch(categoryName, spendPath);
  const categoryConfirmationNeeded = disposition === "INVENTORY" && categoryId !== "" && spendCategoryId !== "" && !categoriesDoMatch;

  const baseUnitName = units.find((u) => u.code === baseUnitCode)?.name ?? null;
  const purchaseUnitName = units.find((u) => u.code === purchaseUnitCode)?.name ?? null;
  const receivingBehaviorInferred = isReceivingBehaviorInferred({
    baseUnitCode: baseUnitCode || null,
    purchaseUnitCode: purchaseUnitCode || null,
    receivingBehavior,
    fixedConversionFactor: fixedConversionFactor.trim() !== "" ? Number(fixedConversionFactor) : null,
  });
  const purchaseSummary = derivePurchaseSummary({
    baseUnitCode: baseUnitCode || null,
    baseUnitName,
    purchaseUnitCode: purchaseUnitCode || null,
    purchaseUnitName,
    receivingBehavior: receivingBehavior as "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY",
    fixedConversionFactor: fixedConversionFactor.trim() !== "" ? Number(fixedConversionFactor) : null,
  });

  const showDispositionControl = shouldShowDispositionControl(confidence, disposition);
  const autoExpandAdvanced = shouldAutoExpandAdvancedSettings({
    confidence,
    categoriesMatch: disposition === "INVENTORY" ? categoriesDoMatch : true,
    hasSecondaryUsageUnit,
    receivingBehaviorInferred,
    disposition,
  });
  const advancedOpen = advancedManuallyOpen ?? autoExpandAdvanced;
  const showSecondaryControls = secondaryComposerOpen || advancedOpen;
  const showCategoryRawControls = categoryConfirmationNeeded || advancedOpen;
  const showPurchaseRawControls = purchaseSummary === null || !receivingBehaviorInferred || advancedOpen;

  function openAdvanced() {
    setAdvancedManuallyOpen(true);
  }

  const canVerifyOverall = canVerify && (!categoryConfirmationNeeded || categoryDiscrepancyAcknowledged);

  async function handleVerify() {
    if (!canVerifyOverall) return;
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
      secondaryUsageUnitCode: hasSecondaryUsageUnit ? secondaryUsageUnitCode : null,
      secondaryConversionFactor: hasSecondaryUsageUnit && !secondaryRequiresMeasurement ? Number(secondaryConversionFactor) : null,
      secondaryRequiresMeasurement: hasSecondaryUsageUnit ? secondaryRequiresMeasurement : false,
    });
    if (!result.ok) {
      setPending(false);
      setError(result.message);
      return;
    }
    onVerified();
  }

  const dispositionStatus = fieldStatus(true, disposition !== defaults.disposition);
  const categoryStatus = fieldStatus(defaults.categoryId !== null, categoryId !== (defaults.categoryId ?? ""));
  const spendCategoryStatus = fieldStatus(defaults.spendCategoryId !== null, spendCategoryId !== (defaults.spendCategoryId ?? ""));
  const baseUnitStatus = fieldStatus(defaults.baseUnitCode !== null, baseUnitCode !== (defaults.baseUnitCode ?? ""));
  const purchaseUnitStatus = fieldStatus(defaults.purchaseUnitCode !== null, purchaseUnitCode !== (defaults.purchaseUnitCode ?? ""));
  const receivingBehaviorStatus = fieldStatus(defaults.receivingBehavior !== null, receivingBehavior !== (defaults.receivingBehavior ?? "SAME_UNIT"));

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-amber-800 bg-amber-950/10 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">AI Recommends</p>
        {confidence !== null ? <p className="text-[10px] text-zinc-600">Confidence: {Math.round(confidence * 100)}%</p> : null}
      </div>

      {/* ---- 1. Item identity ---------------------------------------- */}
      <div className="flex flex-col gap-3">
        <ReviewSectionHeading>Item identity</ReviewSectionHeading>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Item name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`rounded-lg border bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 ${!name.trim() ? "border-red-700" : "border-zinc-700"}`}
          />
        </label>

        {/* Disposition: a simple label for the common (confident,
            inventory) case; the raw dropdown only when the AI is
            uncertain, the item is already non-inventory, or Advanced
            Settings is open. */}
        {showDispositionControl || advancedOpen ? (
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
          </label>
        ) : (
          <p className="text-xs text-zinc-400">
            <span className="text-zinc-500">Disposition: </span>Inventory item
          </p>
        )}

        {/* Category: one merged summary when the inventory category and
            spend category resolve to the same plain-language name;
            otherwise both, distinctly labeled, with an explicit
            confirmation required before verifying. */}
        {disposition === "INVENTORY" && categoriesDoMatch && !showCategoryRawControls ? (
          <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
            <span>
              <span className="text-zinc-500">Category: </span>
              {categoryName}
            </span>
            <EditLink onClick={openAdvanced} />
          </div>
        ) : disposition === "INVENTORY" ? (
          <div className="flex flex-col gap-2">
            {categoryConfirmationNeeded ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-amber-800 bg-amber-950/20 px-3 py-2">
                <p className="text-[11px] text-amber-300">
                  Inventory category (&ldquo;{categoryName}&rdquo;) and spend category (&ldquo;{spendPath}&rdquo;) are different -- confirm this is intentional.
                </p>
                <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                  <input type="checkbox" checked={categoryDiscrepancyAcknowledged} onChange={(e) => setCategoryDiscrepancyAcknowledged(e.target.checked)} />
                  These are intentionally different categories
                </label>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3">
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
          </div>
        ) : (
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
            <CategoryNotListedHint onRefresh={onSpendCategoryCreated} />
          </label>
        )}
      </div>

      {disposition === "INVENTORY" ? (
        <>
          {/* ---- 2. How employees use it ----------------------------- */}
          <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <ReviewSectionHeading>Employees withdraw this item as</ReviewSectionHeading>
            <div className="flex flex-wrap items-start gap-3">
              {advancedOpen ? (
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  <span className="flex items-center gap-2">
                    Employees withdraw this item as
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
                  <p className="text-[11px] text-zinc-500">This is also the item&apos;s base inventory unit -- always required.</p>
                </label>
              ) : (
                <p className="text-xs text-zinc-400">{baseUnitName ?? "Not selected"}</p>
              )}
            </div>

            {!showSecondaryControls ? (
              <button type="button" onClick={() => setSecondaryComposerOpen(true)} className="self-start text-[11px] font-medium text-amber-300 hover:text-amber-200">
                + Add another withdrawal option
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
                <div className="flex flex-wrap items-start gap-3">
                  <label className="flex flex-col gap-1 text-xs text-zinc-400">
                    Secondary withdrawal unit
                    <select
                      value={secondaryUsageUnitCode}
                      onChange={(e) => setSecondaryUsageUnitCode(e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="">None -- one usage unit only</option>
                      {units
                        .filter((u) => u.code !== baseUnitCode)
                        .map((u) => (
                          <option key={u.code} value={u.code}>
                            {u.name} ({u.code})
                          </option>
                        ))}
                    </select>
                  </label>
                  {hasSecondaryUsageUnit ? (
                    <div className="flex flex-col gap-1 text-xs text-zinc-400">
                      <span>Mode</span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => setSecondaryMode("fixed")}
                          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                            secondaryMode === "fixed" ? "bg-amber-400 text-zinc-950" : "border border-zinc-700 text-zinc-400"
                          }`}
                        >
                          Fixed conversion
                        </button>
                        <button
                          type="button"
                          onClick={() => setSecondaryMode("measured")}
                          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                            secondaryMode === "measured" ? "bg-sky-400 text-zinc-950" : "border border-zinc-700 text-zinc-400"
                          }`}
                        >
                          Measure at withdrawal
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {hasSecondaryUsageUnit && !secondaryRequiresMeasurement ? (
                    <label className="flex flex-col gap-1 text-xs text-zinc-400">
                      Conversion factor
                      <input
                        type="number"
                        value={secondaryConversionFactor}
                        onChange={(e) => setSecondaryConversionFactor(e.target.value)}
                        className={`w-24 rounded-lg border bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 ${
                          !secondaryConversionFactor.trim() || Number(secondaryConversionFactor) <= 0 ? "border-red-700" : "border-zinc-700"
                        }`}
                      />
                    </label>
                  ) : null}
                </div>
                {hasSecondaryUsageUnit && secondaryRequiresMeasurement ? (
                  <p className="text-[11px] text-sky-300">Employees must enter the actual measured {baseUnitName ?? "base unit"} quantity every time -- no conversion factor is used.</p>
                ) : null}
                {hasSecondaryUsageUnit && !secondaryRequiresMeasurement ? (
                  <EquationLine contextLabel="Kiosk" factor={secondaryConversionFactor} fromUnit={secondaryUsageUnitCode} toUnit={baseUnitCode} />
                ) : null}
                {sameCodeDifferentFactorWarning ? (
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-800 bg-amber-950/30 px-3 py-2">
                    <p className="text-[11px] text-amber-300">
                      {purchaseUnitCode} means different quantities here: the vendor&apos;s {purchaseUnitCode} converts at {fixedConversionFactor}, but the kiosk&apos;s {purchaseUnitCode} converts
                      at {secondaryConversionFactor}. This is allowed (a vendor case and a kiosk case aren&apos;t required to match) -- confirm this is intentional, or make them the same value
                      below.
                    </p>
                    <button
                      type="button"
                      onClick={() => setSecondaryConversionFactor(fixedConversionFactor)}
                      className="shrink-0 whitespace-nowrap rounded-full border border-amber-700 px-2.5 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-900/30"
                    >
                      Use vendor&apos;s value ({fixedConversionFactor})
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* ---- 3. How it is purchased ------------------------------ */}
          <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <ReviewSectionHeading>How it is purchased</ReviewSectionHeading>
            {!showPurchaseRawControls && purchaseSummary ? (
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-zinc-400">
                  <p>{purchaseSummary.headline}</p>
                  {purchaseSummary.detail ? <p className="text-[11px] text-zinc-500">{purchaseSummary.detail}</p> : null}
                </div>
                <EditLink onClick={openAdvanced} />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start gap-3">
                  <label className="flex flex-col gap-1 text-xs text-zinc-400">
                    <span className="flex items-center gap-2">
                      Vendor purchase unit
                      {purchaseUnitStatus === "ai" ? <AiBadge /> : null}
                    </span>
                    <select
                      value={purchaseUnitCode}
                      onChange={(e) => setPurchaseUnitCode(e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
                    >
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
                {needsConversionFactor ? <EquationLine contextLabel="Vendor" factor={fixedConversionFactor} fromUnit={purchaseUnitCode} toUnit={baseUnitCode} /> : null}
              </div>
            )}
          </div>

          {/* ---- Advanced settings ----------------------------------- */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setAdvancedManuallyOpen(!advancedOpen)}
              className="self-start text-[11px] font-medium text-zinc-500 hover:text-zinc-300"
            >
              {advancedOpen ? "▾" : "▸"} Advanced settings
            </button>
          </div>
        </>
      ) : null}

      {/* ---- Verification ------------------------------------------ */}
      <div className="flex flex-col gap-2">
        {missing.length > 0 ? (
          <p className="text-xs text-amber-400">
            {missing.length} field{missing.length === 1 ? "" : "s"} need{missing.length === 1 ? "s" : ""} your input before this item can be verified: {missing.join(", ")}.
          </p>
        ) : null}
        {categoryConfirmationNeeded && !categoryDiscrepancyAcknowledged ? <p className="text-xs text-amber-400">Confirm the category difference above before verifying.</p> : null}
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <div>
          <button
            type="button"
            onClick={handleVerify}
            disabled={!canVerifyOverall || pending}
            className="rounded-full bg-emerald-500 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
          >
            {pending ? "Verifying item…" : "VERIFY ITEM"}
          </button>
        </div>
      </div>
    </div>
  );
}
