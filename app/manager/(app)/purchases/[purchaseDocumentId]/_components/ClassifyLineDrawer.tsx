"use client";

import { useEffect, useMemo, useState } from "react";
import type { LineClassificationRow } from "@/app/actions/itemClassification";
import { setLineTreatment, getInventoryReturnPreview, type SetLineTreatmentActionInput } from "@/app/actions/lineTreatment";
import { listInventoryItems, type InventoryItemSummary, type SpendCategorySummary, type UnitSummary } from "@/app/actions/itemMaster";
import type { LocationSummary } from "@/app/actions/receiving";
import { flattenSpendCategoryPaths } from "@/app/lib/itemMaster/spendCategoryPaths";
import {
  CREDIT_SUBTYPE_CHOICES,
  LINE_TREATMENT_CHOICES,
  LINE_TREATMENT_LABEL,
  formatConfidence,
  type CreditSubtype,
  type DiscountScope,
  type LineTreatment,
} from "@/app/lib/purchaseDocuments/lineTreatment";
import { formatMoney } from "@/app/lib/formatMoney";
import { LineActionDrawer } from "./LineActionDrawer";
import { inlineErrorClass, inlineNeutralClass, inlineWarningClass, inputClass, labelClass, selectClass } from "@/app/components/manager/surfaces";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * "Classify invoice line" -- the ONE classification editor shared by Step 1
 * (Review Invoice: Change classification / Change treatment / Edit
 * expense category) and Step 2 (Items & Receiving: Resolve issue / Edit
 * classification / Change treatment). Right-side drawer on desktop, full-
 * screen sheet on narrow screens (LineActionDrawer owns the chrome: focus
 * trap, ESC, focus restore, unsaved-change guard).
 *
 * Shows the complete raw text, extracted amount and the AI's reason /
 * evidence first, then the six treatment choices as a keyboard-accessible
 * radio group; contextual fields appear ONLY after a treatment is chosen.
 * Changing the treatment removes fields that no longer apply, keeps values
 * that still do, and warns before discarding entered data. Saving persists
 * server-side (setLineTreatment -> set_purchase_document_line_treatment,
 * which re-validates everything) and re-runs readiness immediately via
 * onSaved.
 */
export function ClassifyLineDrawer({
  open,
  line,
  purchaseDocumentId,
  currency,
  spendCategories,
  items,
  units,
  locations,
  documentLines,
  onSaved,
  onRequestClose,
  onChangeItemMatch,
  onPrev,
  onNext,
  navLabel,
}: {
  open: boolean;
  line: LineClassificationRow | null;
  purchaseDocumentId: string;
  currency: string | null;
  spendCategories: SpendCategorySummary[];
  items: InventoryItemSummary[];
  units: UnitSummary[];
  locations: LocationSummary[];
  /** Every current line, for the discount "related line" picker. */
  documentLines: { lineKey: string; description: string | null }[];
  onSaved: (lineKey: string) => void | Promise<void>;
  onRequestClose: () => void;
  /** For an inventory purchase: opens the existing item-match editor (Step
   * 2) or navigates to it (Step 1). */
  onChangeItemMatch?: (lineKey: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  navLabel?: string;
}) {
  const [treatment, setTreatment] = useState<LineTreatment | null>(null);
  const [creditSubtype, setCreditSubtype] = useState<CreditSubtype | null>(null);
  const [spendCategoryId, setSpendCategoryId] = useState("");
  const [explanation, setExplanation] = useState("");
  const [discountScope, setDiscountScope] = useState<DiscountScope | null>(null);
  const [relatedLineKey, setRelatedLineKey] = useState("");
  const [returnItemId, setReturnItemId] = useState("");
  const [returnQuantity, setReturnQuantity] = useState("");
  const [returnUnitCode, setReturnUnitCode] = useState("");
  const [returnLocationId, setReturnLocationId] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [returnAcknowledged, setReturnAcknowledged] = useState(false);
  const [rememberRule, setRememberRule] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ onHand: number; baseUnitCode: string | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  const [searchedItems, setSearchedItems] = useState<InventoryItemSummary[]>([]);
  const [searchingItems, setSearchingItems] = useState(false);

  const storageLocations = locations;
  const spendPaths = useMemo(
    () => flattenSpendCategoryPaths(spendCategories.filter((c) => c.isActive !== false).map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, requiresExplanation: c.requiresExplanation }))),
    [spendCategories]
  );
  // The returned-item picker: the org's confirmed inventory items (the
  // page-level list is capped, so a name search widens it server-side), plus
  // the line's OWN item -- its confirmed match or the AI's suggested existing
  // item -- so the AI proposal is always selectable and preselected.
  const inventoryItems = useMemo(() => {
    const byId = new Map<string, InventoryItemSummary>();
    for (const i of [...items, ...searchedItems]) {
      if (i.disposition === "INVENTORY" && i.approvalStatus === "CONFIRMED") byId.set(i.id, i);
    }
    const own: { id: string | null; name: string | null }[] = line
      ? [
          { id: line.inventoryItemId, name: line.inventoryItemName },
          { id: line.aiSuggestedIsNewProposal ? null : line.aiSuggestedInventoryItemId, name: line.aiSuggestedInventoryItemName },
        ]
      : [];
    for (const o of own) {
      if (o.id && !byId.has(o.id)) {
        byId.set(o.id, { id: o.id, name: o.name ?? "Matched item", disposition: "INVENTORY", approvalStatus: "CONFIRMED", createdVia: "MANUAL", categoryName: null, baseUnitCode: null });
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, searchedItems, line]);

  // Server-side name search for the returned-item picker (debounced).
  useEffect(() => {
    const term = itemSearch.trim();
    if (!open || term.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchedItems([]);
      setSearchingItems(false);
      return;
    }
    let cancelled = false;
    setSearchingItems(true);
    const handle = setTimeout(() => {
      listInventoryItems({ search: term }).then((r) => {
        if (cancelled) return;
        setSearchedItems(r.ok ? r.items : []);
        setSearchingItems(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, itemSearch]);

  // Seed from the line whenever a (different) line opens. Preselects the
  // current treatment (the AI/rule proposal when the manager has not
  // changed it yet), so accepting/confirming is one click.
  useEffect(() => {
    if (!open || !line) return;
    // An UNRESOLVED line is never preselected -- the manager chooses (the
    // AI's low-confidence guess is shown as context above, not as a choice).
    // Deliberate reset-on-open: the drawer's local form is re-seeded from
    // the line each time a (different) line opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTreatment(line.lineTreatment !== "UNRESOLVED" ? line.lineTreatment : null);
    setCreditSubtype(line.creditSubtype ?? line.aiProposedCreditSubtype ?? null);
    setSpendCategoryId(line.spendCategoryId ?? line.aiProposedSpendCategoryId ?? "");
    setExplanation(line.explanation ?? "");
    setDiscountScope(line.discountScope ?? null);
    setRelatedLineKey(line.discountRelatedLineKey ?? "");
    // Preselect the returned item: the confirmed match, else the AI's
    // suggested EXISTING item (never a new-item proposal -- a return can
    // only decrease stock of an item the org already tracks).
    setReturnItemId(line.inventoryItemId ?? (!line.aiSuggestedIsNewProposal ? line.aiSuggestedInventoryItemId : null) ?? "");
    setItemSearch("");
    setSearchedItems([]);
    setReturnQuantity(line.returnQuantity !== null ? String(line.returnQuantity) : "");
    setReturnUnitCode(line.returnUnitCode ?? "");
    setReturnLocationId(line.returnLocationId ?? (storageLocations.length === 1 ? storageLocations[0].id : ""));
    setReturnReason(line.returnReason ?? "");
    setReturnAcknowledged(line.returnImpactAcknowledged);
    setRememberRule(false);
    setError(null);
    setPreview(null);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line?.lineKey]);

  // Live on-hand preview for an inventory return.
  useEffect(() => {
    if (!open || creditSubtype !== "INVENTORY_RETURN" || !returnItemId || !returnLocationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview(null);
      return;
    }
    let cancelled = false;
    getInventoryReturnPreview(returnItemId, returnLocationId).then((r) => {
      if (cancelled || !r.ok) return;
      setPreview({ onHand: r.onHandQuantity, baseUnitCode: r.baseUnitCode });
      if (!returnUnitCode && r.baseUnitCode) setReturnUnitCode(r.baseUnitCode);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, creditSubtype, returnItemId, returnLocationId]);

  if (!open || !line) return null;

  const selectedCategory = spendPaths.find((p) => p.id === spendCategoryId) ?? null;
  const explanationRequired = Boolean(selectedCategory?.requiresExplanation);
  const returnItem = inventoryItems.find((i) => i.id === returnItemId) ?? null;
  const returnUnitOptions = Array.from(new Set([returnItem?.baseUnitCode ?? null, preview?.baseUnitCode ?? null, ...units.map((u) => u.code)].filter((c): c is string => Boolean(c))));
  const returnQty = Number(returnQuantity);
  const baseUnitForReturn = returnItem?.baseUnitCode ?? preview?.baseUnitCode ?? null;
  const returnInBase: number | null = returnItem && returnUnitCode && baseUnitForReturn && returnUnitCode === baseUnitForReturn && Number.isFinite(returnQty) ? returnQty : null;
  const afterOnHand: number | null = preview && returnInBase !== null ? preview.onHand - returnInBase : null;
  const wouldGoNegative = afterOnHand !== null && afterOnHand < 0;

  const hasEnteredData = Boolean(spendCategoryId || explanation || creditSubtype || discountScope || returnItemId || returnQuantity || returnReason);

  function changeTreatment(next: LineTreatment) {
    if (next === treatment) return;
    if (treatment !== null && hasEnteredData && !window.confirm("Changing the treatment will clear the fields that no longer apply. Continue?")) return;
    setTreatment(next);
    setDirty(true);
    setError(null);
    // Remove irrelevant fields; keep still-relevant values.
    if (next !== "EXPENSE" && next !== "FREIGHT_FEE") {
      setSpendCategoryId("");
      setExplanation("");
    }
    if (next !== "CREDIT_RETURN") {
      setCreditSubtype(null);
      setReturnItemId("");
      setReturnQuantity("");
      setReturnUnitCode("");
      setReturnReason("");
      setReturnAcknowledged(false);
    }
    if (next !== "DISCOUNT") {
      setDiscountScope(null);
      setRelatedLineKey("");
    }
  }

  const validation = ((): string | null => {
    if (!treatment) return "Choose how this line should be treated.";
    if ((treatment === "EXPENSE" || treatment === "FREIGHT_FEE") && !spendCategoryId) return "Choose an expense category.";
    if ((treatment === "EXPENSE" || treatment === "FREIGHT_FEE") && explanationRequired && !explanation.trim()) return "This category requires a written explanation.";
    if (treatment === "DISCOUNT" && !discountScope) return "Choose the discount scope.";
    if (treatment === "CREDIT_RETURN" && !creditSubtype) return "Answer: did tracked inventory physically leave the store?";
    if (treatment === "CREDIT_RETURN" && creditSubtype === "INVENTORY_RETURN") {
      if (!returnItemId) return "Choose the item that was returned.";
      if (!(returnQty > 0)) return "Enter the returned quantity.";
      if (!returnUnitCode) return "Choose the returned unit.";
      if (!returnLocationId) return "Choose the source location.";
      if (!returnReason.trim()) return "Enter a reason for the return.";
      if (!returnAcknowledged) return "Acknowledge the inventory decrease.";
      if (wouldGoNegative) return "This return would take inventory below zero.";
    }
    return null;
  })();

  async function handleSave() {
    if (!treatment || pending || !line) return;
    if (validation) {
      setError(validation);
      return;
    }
    setPending(true);
    setError(null);
    const input: SetLineTreatmentActionInput = {
      purchaseDocumentId,
      lineKey: line.lineKey,
      lineTreatment: treatment,
      creditSubtype: treatment === "CREDIT_RETURN" ? creditSubtype : null,
      spendCategoryId: treatment === "EXPENSE" || treatment === "FREIGHT_FEE" ? spendCategoryId : null,
      explanation: treatment === "EXPENSE" || treatment === "FREIGHT_FEE" ? explanation.trim() || null : null,
      discountScope: treatment === "DISCOUNT" ? discountScope : null,
      discountRelatedLineKey: treatment === "DISCOUNT" && relatedLineKey ? relatedLineKey : null,
      returnInventoryItemId: creditSubtype === "INVENTORY_RETURN" ? returnItemId : null,
      returnQuantity: creditSubtype === "INVENTORY_RETURN" ? returnQty : null,
      returnUnitCode: creditSubtype === "INVENTORY_RETURN" ? returnUnitCode : null,
      returnLocationId: creditSubtype === "INVENTORY_RETURN" ? returnLocationId : null,
      returnReason: creditSubtype === "INVENTORY_RETURN" ? returnReason.trim() : null,
      returnImpactAcknowledged: creditSubtype === "INVENTORY_RETURN" ? returnAcknowledged : false,
      rememberVendorRule: rememberRule && treatment !== "INVENTORY_PURCHASE",
    };
    const result = await setLineTreatment(input);
    setPending(false);
    if (!result.ok) {
      const detail = "detail" in result && result.detail?.availableQuantity !== undefined ? ` On hand: ${result.detail.availableQuantity}.` : "";
      setError(`${result.message}${detail}`);
      return;
    }
    setDirty(false);
    await onSaved(line.lineKey);
  }

  const amountText = formatMoney(line.lineTotal, currency);
  const aiLabel = line.aiProposedTreatment ? LINE_TREATMENT_LABEL[line.aiProposedTreatment] : null;
  const quantityText = line.packageQuantity !== null ? `${line.packageQuantity} ${line.packageUnit ?? ""}`.trim() : line.measuredQuantity !== null ? `${line.measuredQuantity} ${line.measuredUnit ?? ""}`.trim() : "—";

  return (
    <LineActionDrawer
      open
      title="Classify invoice line"
      subtitle={line.vendorSku ? `Vendor SKU ${line.vendorSku}` : undefined}
      dirty={dirty}
      onRequestClose={onRequestClose}
      onPrev={onPrev}
      onNext={onNext}
      navLabel={navLabel}
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        {/* Raw evidence -- complete, never truncated */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <p className={labelClass}>Raw text (as extracted)</p>
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-zinc-100">{line.description ?? "—"}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-zinc-500">Quantity</dt>
              <dd className="text-zinc-200">{quantityText}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Unit price</dt>
              <dd className="text-zinc-200">{formatMoney(line.unitPrice, currency)}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Extracted amount</dt>
              <dd className="font-semibold text-zinc-100 tabular-nums">{amountText}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">AI confidence</dt>
              <dd className="text-zinc-200">{formatConfidence(line.aiConfidence)}</dd>
            </div>
          </dl>
          {aiLabel || line.aiReason ? (
            <div className={`mt-3 ${inlineNeutralClass}`}>
              <p className="font-semibold text-zinc-300">
                AI proposed: <span className="text-amber-200">{aiLabel ?? "no classification"}</span>
                {line.aiProposedCreditSubtype ? ` · ${CREDIT_SUBTYPE_CHOICES.find((c) => c.value === line.aiProposedCreditSubtype)?.label ?? line.aiProposedCreditSubtype}` : ""}
              </p>
              {line.aiReason ? <p className="mt-1 text-zinc-300">{line.aiReason}</p> : null}
              {line.aiEvidence.length > 0 ? <p className="mt-1 text-zinc-500">Evidence: {line.aiEvidence.join(" · ")}</p> : null}
              {line.aiReviewFields.length > 0 ? <p className="mt-1 text-amber-300">Please double-check: {line.aiReviewFields.join(", ")}</p> : null}
            </div>
          ) : null}
        </section>

        {/* Treatment choice -- radio group, keyboard accessible */}
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Select classification</legend>
          <div role="radiogroup" aria-label="Line treatment" className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {LINE_TREATMENT_CHOICES.map((choice) => {
              const selected = treatment === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => changeTreatment(choice.value)}
                  className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                    selected ? "border-amber-500 bg-amber-950/30 text-amber-100" : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500"
                  }`}
                >
                  <span className="block font-medium">{choice.label}</span>
                  <span className="mt-0.5 block text-[11px] text-zinc-400">{choice.hint}</span>
                </button>
              );
            })}
          </div>
          {treatment === null ? <p className="mt-2 text-xs text-zinc-500">Additional fields will appear after you select a classification.</p> : null}
        </fieldset>

        {/* Contextual fields -- only after a treatment is selected */}
        {treatment === "INVENTORY_PURCHASE" ? (
          <section className={inlineNeutralClass}>
            <p className="text-zinc-200">This line will be matched to a canonical inventory item and received into stock.</p>
            <p className="mt-1">Saving re-runs item matching. Confirm the item, purchase package and receiving details in Items &amp; Receiving.</p>
            {line.inventoryItemName ? <p className="mt-1 text-emerald-300">Current match: {line.inventoryItemName}</p> : null}
            {onChangeItemMatch ? (
              <button type="button" onClick={() => onChangeItemMatch(line.lineKey)} className="mt-2 text-xs text-amber-300 underline underline-offset-2">
                Change item match
              </button>
            ) : null}
          </section>
        ) : null}

        {treatment === "EXPENSE" || treatment === "FREIGHT_FEE" ? (
          <section className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>
                Expense category{" "}
                {line.aiProposedSpendCategoryId && line.aiProposedSpendCategoryId === spendCategoryId ? (
                  <span className="text-amber-300">· {line.aiConfidence !== null && line.aiConfidence >= 0.9 ? "AI assigned" : "AI suggested"}</span>
                ) : null}
              </span>
              <select value={spendCategoryId} onChange={(e) => { setSpendCategoryId(e.target.value); setDirty(true); }} className={selectClass} aria-invalid={!spendCategoryId} aria-describedby="classify-category-hint">
                <option value="">Select a category…</option>
                {spendPaths.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.path}
                  </option>
                ))}
              </select>
              <span id="classify-category-hint" className="text-[11px] text-zinc-500">
                {treatment === "FREIGHT_FEE" ? "Freight, delivery and fuel surcharges or vendor fees & service charges." : "You can change the category if needed."}
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>
                {explanationRequired ? "Explanation (required for this category)" : "Note (optional)"}
              </span>
              <textarea
                value={explanation}
                onChange={(e) => { setExplanation(e.target.value); setDirty(true); }}
                rows={2}
                aria-required={explanationRequired}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-50 focus:border-amber-500 focus:outline-none"
                placeholder={explanationRequired ? "Why no more specific category fits…" : "Add a note…"}
              />
            </label>
            <p className={inlineNeutralClass}>{treatment === "FREIGHT_FEE" ? "This charge will not add inventory." : "This line will not add inventory."}</p>
          </section>
        ) : null}

        {treatment === "TAX" ? (
          <section className={inlineNeutralClass}>
            <p className="text-zinc-200">Tax is not an item and does not require an expense category.</p>
            <p className="mt-1">Recorded as document-level tax and reconciled against the invoice total. Inventory effect: none.</p>
          </section>
        ) : null}

        {treatment === "DISCOUNT" ? (
          <section className="flex flex-col gap-3">
            <fieldset>
              <legend className={labelClass}>Discount scope</legend>
              <div role="radiogroup" className="mt-1 flex flex-wrap gap-2">
                {(["LINE", "DOCUMENT"] as DiscountScope[]).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    role="radio"
                    aria-checked={discountScope === scope}
                    onClick={() => { setDiscountScope(scope); setDirty(true); }}
                    className={`min-h-9 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${discountScope === scope ? "border-amber-500 bg-amber-950/30 text-amber-100" : "border-zinc-700 text-zinc-200"}`}
                  >
                    {scope === "LINE" ? "One line" : "Whole document"}
                  </button>
                ))}
              </div>
            </fieldset>
            {discountScope === "LINE" ? (
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Related line (optional)</span>
                <select value={relatedLineKey} onChange={(e) => { setRelatedLineKey(e.target.value); setDirty(true); }} className={selectClass}>
                  <option value="">Not specified</option>
                  {documentLines.filter((l) => l.lineKey !== line.lineKey).map((l) => (
                    <option key={l.lineKey} value={l.lineKey}>
                      {l.description ?? l.lineKey}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className={inlineNeutralClass}>Affects invoice totals only. Not allocated into inventory unit cost. Inventory effect: none.</p>
          </section>
        ) : null}

        {treatment === "CREDIT_RETURN" ? (
          <section className="flex flex-col gap-3">
            <fieldset>
              <legend className={labelClass}>Did tracked inventory physically leave the store?</legend>
              <div role="radiogroup" className="mt-1 flex flex-col gap-2">
                {CREDIT_SUBTYPE_CHOICES.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    role="radio"
                    aria-checked={creditSubtype === choice.value}
                    onClick={() => { setCreditSubtype(choice.value); setDirty(true); }}
                    className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${creditSubtype === choice.value ? "border-amber-500 bg-amber-950/30 text-amber-100" : "border-zinc-700 text-zinc-200"}`}
                  >
                    <span className="block font-medium">{choice.label}</span>
                    <span className="mt-0.5 block text-[11px] text-zinc-400">{choice.hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            {creditSubtype === "FINANCIAL_CREDIT" || creditSubtype === "RETURNABLE_CONTAINER_CREDIT" ? (
              <p className={inlineNeutralClass}>
                No item created. No expense category required. Invoice total decreases by {formatMoney(Math.abs(line.lineTotal ?? 0), currency)}. Inventory effect: none.
              </p>
            ) : null}
            {creditSubtype === "INVENTORY_RETURN" ? (
              <div className="flex flex-col gap-3 rounded-lg border border-amber-800/60 bg-amber-950/10 p-3">
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Find item by name</span>
                  <input type="search" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Type at least 2 characters to search all items" className={inputClass} aria-describedby={`return-item-search-hint-${line.lineKey}`} />
                  <span id={`return-item-search-hint-${line.lineKey}`} className="text-xs text-zinc-500">
                    {searchingItems ? "Searching…" : itemSearch.trim().length >= 2 ? `${searchedItems.length} matching item(s) added to the list below.` : "The list below shows the first 200 items; search to find others."}
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Returned item</span>
                  <select value={returnItemId} onChange={(e) => { setReturnItemId(e.target.value); setReturnUnitCode(""); setDirty(true); }} className={selectClass}>
                    <option value="">Select the canonical item…</option>
                    {inventoryItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}{i.baseUnitCode ? ` (${i.baseUnitCode})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>Quantity returned</span>
                    <input type="number" min="0" step="any" value={returnQuantity} onChange={(e) => { setReturnQuantity(e.target.value); setDirty(true); }} className={inputClass} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>Unit</span>
                    <select value={returnUnitCode} onChange={(e) => { setReturnUnitCode(e.target.value); setDirty(true); }} className={selectClass}>
                      <option value="">Select…</option>
                      {returnUnitOptions.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Source location</span>
                  {storageLocations.length === 1 ? (
                    <span className="text-sm text-zinc-100">{storageLocations[0].name}</span>
                  ) : (
                    <select value={returnLocationId} onChange={(e) => { setReturnLocationId(e.target.value); setDirty(true); }} className={selectClass}>
                      <option value="">Select…</option>
                      {storageLocations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Reason</span>
                  <input type="text" value={returnReason} onChange={(e) => { setReturnReason(e.target.value); setDirty(true); }} className={inputClass} placeholder="e.g. damaged on arrival, wrong item" />
                </label>
                {preview ? (
                  <p className={wouldGoNegative ? inlineErrorClass : inlineWarningClass}>
                    On hand before: {preview.onHand} {preview.baseUnitCode ?? ""} · after: {afterOnHand !== null ? afterOnHand : "—"} {preview.baseUnitCode ?? ""}
                    {wouldGoNegative ? " — inventory cannot go negative." : ""}
                    {returnInBase !== null ? ` Inventory will decrease by ${returnInBase} ${preview.baseUnitCode ?? ""}.` : ""}
                  </p>
                ) : null}
                <label className="flex items-start gap-2 text-sm text-zinc-200">
                  <input type="checkbox" checked={returnAcknowledged} onChange={(e) => { setReturnAcknowledged(e.target.checked); setDirty(true); }} className="mt-1" />
                  <span>I confirm this merchandise physically left the store and inventory should decrease.</span>
                </label>
              </div>
            ) : null}
          </section>
        ) : null}

        {treatment && treatment !== "INVENTORY_PURCHASE" ? (
          <label className="flex items-start gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={rememberRule} onChange={(e) => setRememberRule(e.target.checked)} className="mt-0.5" />
            <span>Remember this decision for this vendor{line.vendorSku ? ` and SKU ${line.vendorSku}` : " and description"} (auditable; Admin can disable it).</span>
          </label>
        ) : null}

        {error ? <p role="alert" className={inlineErrorClass}>{error}</p> : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 pt-3">
          <button type="button" onClick={onRequestClose} className={secondaryButtonClass} disabled={pending}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} className={primaryButtonClass} disabled={pending || !treatment} title={validation ?? undefined}>
            {pending ? "Saving…" : treatment === "INVENTORY_PURCHASE" ? "Save & match item" : "Save classification"}
          </button>
        </div>
      </div>
    </LineActionDrawer>
  );
}
