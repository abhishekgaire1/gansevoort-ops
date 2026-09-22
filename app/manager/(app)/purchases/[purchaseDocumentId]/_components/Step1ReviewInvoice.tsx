"use client";

import { useEffect, useMemo, useState } from "react";
import { DocumentViewer } from "@/app/components/documents/DocumentViewer";
import { DateField, MismatchNote, NumberField, SelectField, TextField } from "./DocumentFields";
import { translateReviewFlags } from "@/app/lib/purchaseDocuments/reviewFlagText";
import { WorkflowFooter } from "@/app/components/receiving/WorkflowFooter";
import { formatMoney } from "@/app/lib/formatMoney";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { ResolvedUnitNote } from "@/app/lib/purchaseDocuments/lineUnitResolution";
import { createVendorFromReceiving, type VendorSummary } from "@/app/actions/vendors";
import type { LineClassificationRow } from "@/app/actions/itemClassification";
import type { InventoryItemSummary, SpendCategorySummary, UnitSummary } from "@/app/actions/itemMaster";
import type { LocationSummary } from "@/app/actions/receiving";
import type { LineReadiness } from "@/app/lib/purchaseDocuments/lineReadiness";
import { issueCountLabel } from "@/app/lib/purchaseDocuments/lineReadiness";
import { LINE_TREATMENT_LABEL, CREDIT_SUBTYPE_LABEL, formatConfidence, confidenceBand } from "@/app/lib/purchaseDocuments/lineTreatment";
import { reconcileTotals } from "@/app/lib/purchaseDocuments/totalsReconciliation";
import { ClassifyLineDrawer } from "./ClassifyLineDrawer";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, panelMetaClass, inlineWarningClass, inlineSuccessClass, inlineNeutralClass, tableWrapClass, tableClass, tableHeadClass, tableHeadCellClass, tableHeadCellRightClass, tableCellClass, tableCellRightClass } from "@/app/components/manager/surfaces";
import { primaryButtonClass, textLinkClass } from "@/app/components/manager/buttonStyles";
import { vendorOptionLabel } from "@/app/lib/vendors/vendorPresentation";

const DOCUMENT_TYPE_OPTIONS: { value: PurchaseDocumentType; label: string }[] = [
  { value: "INVOICE", label: "Invoice" },
  { value: "RECEIPT", label: "Receipt" },
  { value: "CREDIT_MEMO", label: "Credit Memo" },
];

const DOCUMENT_NUMBER_LABEL: Record<PurchaseDocumentType, string> = {
  INVOICE: "Invoice #",
  RECEIPT: "Receipt/Transaction #",
  CREDIT_MEMO: "Credit Memo #",
};

function emptyLine(): PurchaseDocumentLine {
  return {
    lineKey: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null,
    vendorSku: null,
    description: null,
    packageQuantity: null,
    packageUnit: null,
    measuredQuantity: null,
    measuredUnit: null,
    unitPrice: null,
    priceBasisUnit: null,
    lineTotal: null,
    rawLineText: null,
  };
}

const compactButtonClass =
  "inline-flex h-7 items-center justify-center rounded-md border border-zinc-600 px-2.5 text-xs font-medium leading-none text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Step 1 -- Review Invoice. Information architecture (in order):
 *   1. issues-first navigator (extraction flags + classification issues)
 *   2. compact invoice header (vendor / type / number / dates / totals)
 *   3. document viewer (left) beside the extracted data (right)
 *   4. invoice-line table: raw description, SKU, qty, unit, unit price,
 *      amount, AI treatment + confidence, status, contextual action
 *   5. classification editor (ClassifyLineDrawer -- right-side drawer,
 *      full-screen sheet on narrow screens); every classification editable
 *   6. totals reconciliation across all line types
 *   7. sticky continue footer driven by the same readiness the Stepper,
 *      Step 2 and Step 3 use.
 * Only unmatched INVENTORY PURCHASES ever go to "New Items Found"
 * (Step 2); expenses, tax, credits, discounts and fees never do.
 */
export function Step1ReviewInvoice({
  purchaseDocumentId,
  viewUrl,
  viewError,
  contentType,
  editable,
  header,
  lines,
  onHeaderChange,
  onLineChange,
  onAddLine,
  onRemoveLine,
  declaredVendorName,
  aiSuggestedVendorName,
  declaredDocumentType,
  aiSuggestedDocumentType,
  aiAmountDue,
  vendors,
  reviewFlags,
  resolvedUnitNotes,
  aiWarnings,
  aiModel,
  classificationRows,
  readinessByLineKey,
  matchingActive,
  spendCategories,
  items,
  units,
  locations,
  onClassificationChanged,
  onChangeItemMatch,
  isDirty,
  onContinue,
  continuePending,
  onSave,
  savePending,
  savedMessage,
  stepError,
  focusLineKey,
}: {
  purchaseDocumentId: string;
  viewUrl: string | null;
  viewError: string | null;
  contentType: string;
  editable: boolean;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  onHeaderChange: <K extends keyof PurchaseDocumentHeaderDraft>(key: K, value: PurchaseDocumentHeaderDraft[K]) => void;
  onLineChange: (index: number, patch: Partial<PurchaseDocumentLine>) => void;
  onAddLine: () => void;
  onRemoveLine: (index: number) => void;
  declaredVendorName: string | null;
  aiSuggestedVendorName: string | null;
  aiAmountDue: number | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedDocumentType: string | null;
  vendors: VendorSummary[];
  reviewFlags: ReviewFlag[];
  resolvedUnitNotes: ResolvedUnitNote[];
  aiWarnings: string[];
  aiModel: string | null;
  /** The authoritative per-line classification rows (null while loading). */
  classificationRows: LineClassificationRow[] | null;
  /** THE shared readiness result per line (lineReadiness.ts). */
  readinessByLineKey: Map<string, LineReadiness>;
  /** True while item matching / classification is running for this document. */
  matchingActive: boolean;
  spendCategories: SpendCategorySummary[];
  items: InventoryItemSummary[];
  units: UnitSummary[];
  locations: LocationSummary[];
  /** Refetch classification rows + readiness after a save. */
  onClassificationChanged: () => Promise<void> | void;
  /** "Change item match" for an inventory purchase -- deep-links to that
   * line on Items & Receiving. */
  onChangeItemMatch: (lineKey: string) => void;
  isDirty: boolean;
  onContinue: () => void;
  continuePending: boolean;
  onSave: () => void;
  savePending: boolean;
  savedMessage: string | null;
  stepError: string | null;
  /** A line to scroll to and open (deep link from Step 3's blocker). */
  focusLineKey?: string | null;
}) {
  const [narrowPane, setNarrowPane] = useState<"document" | "form">("form");
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const [vendorList, setVendorList] = useState(vendors);
  const [creatingVendor, setCreatingVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [vendorCreatePending, setVendorCreatePending] = useState(false);
  const [vendorCreateError, setVendorCreateError] = useState<string | null>(null);
  const [editingValuesIndex, setEditingValuesIndex] = useState<number | null>(null);
  const [classifyingLineKey, setClassifyingLineKey] = useState<string | null>(null);

  async function handleCreateVendor() {
    if (!newVendorName.trim()) return;
    setVendorCreatePending(true);
    setVendorCreateError(null);
    const result = await createVendorFromReceiving(newVendorName.trim());
    setVendorCreatePending(false);
    if (!result.ok) {
      setVendorCreateError(result.message);
      return;
    }
    setVendorList((list) => [...list, result.vendor].sort((a, b) => a.name.localeCompare(b.name)));
    onHeaderChange("vendorId", result.vendor.id);
    setCreatingVendor(false);
    setNewVendorName("");
  }

  const translatedFlags = useMemo(() => translateReviewFlags(reviewFlags, lines), [reviewFlags, lines]);
  const blockingFlags = translatedFlags.filter((f) => f.severity === "error");
  const attentionFlags = translatedFlags.filter((f) => f.severity !== "info");
  const resolvedNotesByLineIndex = new Map(resolvedUnitNotes.map((note) => [lines.findIndex((l) => l.lineKey === note.lineKey), note] as const));
  const rowByLineKey = useMemo(() => new Map((classificationRows ?? []).map((r) => [r.lineKey, r])), [classificationRows]);

  // Classification issues, in line order -- an UNRESOLVED / unsettled line
  // is a Step 1 blocker (the treatment must be decided before Items &
  // Receiving); the same readiness result drives the Stepper/footer.
  const classificationIssues = lines
    .map((line, index) => ({ line, index, readiness: line.lineKey ? readinessByLineKey.get(line.lineKey) ?? null : null }))
    .filter((x) => x.readiness && !x.readiness.classificationSettled);
  const unresolvedCount = classificationIssues.filter((x) => x.readiness!.status === "needs_classification").length;
  const issueCount = blockingFlags.length + classificationIssues.length;
  const savedLineCount = lines.filter((l) => l.lineKey && rowByLineKey.has(l.lineKey)).length;
  const unsavedLineCount = lines.length - savedLineCount;

  const totals = useMemo(
    () =>
      reconcileTotals(
        lines.map((l) => ({ treatment: (l.lineKey && rowByLineKey.get(l.lineKey)?.lineTreatment) || "UNRESOLVED", lineTotal: l.lineTotal })),
        { tax: header.tax, fees: header.fees, total: header.total }
      ),
    [lines, rowByLineKey, header.tax, header.fees, header.total]
  );

  function focusLine(lineIndex: number) {
    setNarrowPane("form");
    setHighlightedLine(lineIndex);
    const el = document.getElementById(`step1-line-${lineIndex}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus();
    window.setTimeout(() => setHighlightedLine((current) => (current === lineIndex ? null : current)), 2000);
  }

  function openClassifier(lineKey: string) {
    const index = lines.findIndex((l) => l.lineKey === lineKey);
    if (index >= 0) focusLine(index);
    setClassifyingLineKey(lineKey);
  }

  // Deep link (Step 3's "Review line", or the wizard's first-issue focus):
  // scroll to and open the unresolved line without a discovery click.
  useEffect(() => {
    if (!focusLineKey || !editable) return;
    if (!rowByLineKey.has(focusLineKey)) return;
    const index = lines.findIndex((l) => l.lineKey === focusLineKey);
    if (index >= 0) {
      // Deep-link consumption: scroll + open once when the target arrives.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      focusLine(index);
      setClassifyingLineKey(focusLineKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLineKey, rowByLineKey.size]);

  const classifyingRow = classifyingLineKey ? rowByLineKey.get(classifyingLineKey) ?? null : null;
  const issueLineKeys = classificationIssues.map((x) => x.line.lineKey).filter((k): k is string => Boolean(k));
  const classifyingIssueIndex = classifyingLineKey ? issueLineKeys.indexOf(classifyingLineKey) : -1;
  const currency = header.currency;

  function statusBadge(readiness: LineReadiness | null, row: LineClassificationRow | null, saved: boolean) {
    if (!saved) return <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-zinc-600" />{classificationRows === null ? "Loading…" : "Save to classify"}</span>;
    if (!row || row.status === "UNCLASSIFIED") {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-amber-300">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {matchingActive ? "Classifying…" : "Needs classification"}
        </span>
      );
    }
    if (!readiness) return null;
    if (readiness.status === "needs_classification") return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />Needs classification</span>;
    if (!readiness.classificationSettled) return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />{readiness.status === "review_recommended" ? "Review recommended" : "Needs attention"}</span>;
    return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{readiness.aiLabel === "AI assigned" || readiness.aiLabel === "Matched previous decision" ? readiness.aiLabel : "Ready"}</span>;
  }

  function treatmentCell(row: LineClassificationRow | null) {
    if (!row || row.status === "UNCLASSIFIED") return <span className="text-xs text-zinc-500">—</span>;
    const label = LINE_TREATMENT_LABEL[row.lineTreatment];
    const detail =
      row.lineTreatment === "INVENTORY_PURCHASE"
        ? row.inventoryItemName ?? (row.aiSuggestedIsNewProposal ? "New item proposed" : row.aiSuggestedInventoryItemName ? `Suggested: ${row.aiSuggestedInventoryItemName}` : "No item match yet")
        : row.lineTreatment === "EXPENSE" || row.lineTreatment === "FREIGHT_FEE"
          ? row.spendCategoryName ?? "No category"
          : row.lineTreatment === "CREDIT_RETURN"
            ? row.creditSubtype ? CREDIT_SUBTYPE_LABEL[row.creditSubtype] : "Credit type not chosen"
            : row.lineTreatment === "DISCOUNT"
              ? row.discountScope ? (row.discountScope === "LINE" ? "Line discount" : "Document discount") : "Scope not chosen"
              : row.lineTreatment === "TAX"
                ? "Document-level tax"
                : row.aiProposedTreatment ? `AI guess: ${LINE_TREATMENT_LABEL[row.aiProposedTreatment]}` : "Unclear line";
    const band = confidenceBand(row.aiConfidence);
    return (
      <div className="min-w-0">
        <p className={`text-sm ${row.lineTreatment === "UNRESOLVED" ? "text-amber-200" : "text-zinc-100"}`}>{label}</p>
        <p className="truncate text-xs text-zinc-400">{detail}</p>
        {row.lineTreatment === "INVENTORY_PURCHASE" && row.inventoryBaseUnitCode ? <p className="text-[11px] text-zinc-500">Base unit {row.inventoryBaseUnitCode}{row.resolutionSource ? ` · ${matchSourceLabel(row.resolutionSource)}` : ""}</p> : null}
        {row.aiReason && band !== null ? <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{row.aiReason}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* 1. Issues-first navigator */}
      {attentionFlags.length > 0 || classificationIssues.length > 0 ? (
        <div className={inlineWarningClass} role="status">
          <p className="font-semibold uppercase tracking-wide text-amber-400">
            {issueCount > 0 ? issueCountLabel(issueCount) : `${attentionFlags.length} note${attentionFlags.length === 1 ? "" : "s"}`}
          </p>
          <ul className="mt-1.5 flex max-h-44 flex-col gap-1 overflow-y-auto">
            {classificationIssues.map(({ line, index, readiness }) => (
              <li key={line.lineKey ?? index} className="text-red-300">
                <button type="button" onClick={() => line.lineKey && openClassifier(line.lineKey)} className="text-left underline decoration-dotted underline-offset-2 hover:text-amber-50">
                  • {line.description ?? `Line ${index + 1}`} — {readiness!.primaryIssue ?? readiness!.statusLabel}
                </button>
              </li>
            ))}
            {attentionFlags.map((flag, index) => (
              <li key={`flag-${index}`} className={flag.severity === "error" ? "text-red-300" : "text-amber-200"}>
                {flag.lineIndex !== null ? (
                  <button type="button" onClick={() => focusLine(flag.lineIndex!)} className="text-left underline decoration-dotted underline-offset-2 hover:text-amber-50">
                    • {flag.text}
                  </button>
                ) : (
                  <>• {flag.text}</>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : classificationRows !== null && lines.length > 0 && !matchingActive ? (
        <p className={inlineSuccessClass}>✓ Every line is classified and no extraction issues were found.</p>
      ) : null}

      {matchingActive ? (
        <p aria-busy="true" className={inlineNeutralClass}>AI is reading the invoice lines… classifications appear as they are ready.</p>
      ) : null}

      {aiWarnings.length > 0 ? (
        <details className={`${panelClass} px-4 py-3 text-xs text-zinc-400`}>
          <summary className="cursor-pointer font-semibold uppercase tracking-wide text-zinc-500">AI notes{aiModel ? ` (${aiModel})` : ""}</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {aiWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex gap-2 lg:hidden">
        <button type="button" onClick={() => setNarrowPane("document")} className={`rounded-lg px-4 py-1.5 text-xs font-semibold ${narrowPane === "document" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}>
          Original invoice
        </button>
        <button type="button" onClick={() => setNarrowPane("form")} className={`rounded-lg px-4 py-1.5 text-xs font-semibold ${narrowPane === "form" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}>
          Extracted data
        </button>
      </div>

      {/* Desktop: document beside the operational table (the table scrolls
          inside its own container when narrow -- never the page). Tablet /
          phone: one pane at a time via the toggle above. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(300px,2fr)_minmax(0,5fr)]">
        {/* 2. Document viewer */}
        <div className={`flex flex-col ${panelClass} h-[28rem] lg:sticky lg:top-4 lg:h-[calc(100vh-10rem)] lg:min-h-[32rem] ${narrowPane === "document" ? "" : "hidden lg:flex"}`}>
          <div className={panelHeaderClass}>
            <h2 className={panelTitleClass}>Original invoice</h2>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <DocumentViewer viewUrl={viewUrl} viewError={viewError} contentType={contentType} heightClassName="h-full" />
          </div>
        </div>

        <div className={`flex min-w-0 flex-col gap-3 ${narrowPane === "form" ? "" : "hidden lg:flex"}`}>
          {/* 3. Compact invoice header */}
          <div className={panelClass}>
            <div className={panelHeaderClass}>
              <h2 className={panelTitleClass}>Invoice header</h2>
            </div>
            <div className={panelBodyClass}>
              <MismatchNote label="Vendor" declared={declaredVendorName} aiSuggested={aiSuggestedVendorName} current={vendorList.find((v) => v.id === header.vendorId)?.name ?? null} />
              <MismatchNote label="Document type" declared={declaredDocumentType} aiSuggested={aiSuggestedDocumentType} current={header.documentType} />
              <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
                <SelectField label="Vendor" value={header.vendorId ?? ""} disabled={!editable} onChange={(v) => onHeaderChange("vendorId", v || null)} options={[{ value: "", label: "Select vendor…" }, ...vendorList.map((v) => ({ value: v.id, label: vendorOptionLabel(v) }))]} />
                <SelectField label="Document type" value={header.documentType ?? ""} disabled={!editable} onChange={(v) => onHeaderChange("documentType", (v || null) as PurchaseDocumentType | null)} options={[{ value: "", label: "Select type…" }, ...DOCUMENT_TYPE_OPTIONS]} />
                <TextField label={header.documentType ? DOCUMENT_NUMBER_LABEL[header.documentType] : "Document #"} value={header.documentNumber} disabled={!editable} onChange={(v) => onHeaderChange("documentNumber", v)} />
                <DateField label="Document date" value={header.documentDate} disabled={!editable} onChange={(v) => onHeaderChange("documentDate", v)} />
                <TextField label="PO #" value={header.poNumber} disabled={!editable} onChange={(v) => onHeaderChange("poNumber", v)} />
                <DateField label="Delivery date" value={header.deliveryDate} disabled={!editable} onChange={(v) => onHeaderChange("deliveryDate", v)} />
                <NumberField label="Subtotal" value={header.subtotal} disabled={!editable} onChange={(v) => onHeaderChange("subtotal", v)} />
                <NumberField label="Tax" value={header.tax} disabled={!editable} onChange={(v) => onHeaderChange("tax", v)} />
                <NumberField label="Fees" value={header.fees} disabled={!editable} onChange={(v) => onHeaderChange("fees", v)} />
                <NumberField label="Total" value={header.total} disabled={!editable} onChange={(v) => onHeaderChange("total", v)} />
              </div>

              {aiAmountDue !== null ? (
                <div className={`mt-3 ${inlineWarningClass}`}>
                  <p className="font-semibold uppercase tracking-wide text-amber-400">Vendor account</p>
                  <p className="mt-1">
                    This invoice&apos;s printed total ({formatMoney(aiAmountDue, header.currency)}) appears to include a prior account balance, not just this document. If Total above should instead be this document&apos;s own total, correct it directly.
                  </p>
                </div>
              ) : null}

              {editable ? (
                creatingVendor ? (
                  <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-950/60 p-3">
                    <label className="flex flex-col gap-1 text-xs text-zinc-400">
                      New vendor name
                      <input value={newVendorName} onChange={(e) => setNewVendorName(e.target.value)} autoFocus className="h-9 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50" />
                    </label>
                    {vendorCreateError ? <p className="mt-2 text-xs text-red-400">{vendorCreateError}</p> : null}
                    <div className="mt-2 flex items-center gap-3">
                      <button type="button" disabled={vendorCreatePending || !newVendorName.trim()} onClick={handleCreateVendor} className={primaryButtonClass}>
                        {vendorCreatePending ? "Creating…" : "Create & use vendor"}
                      </button>
                      <button type="button" onClick={() => { setCreatingVendor(false); setNewVendorName(""); setVendorCreateError(null); }} className={textLinkClass}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setCreatingVendor(true)} className={`mt-3 ${textLinkClass} text-amber-300 hover:text-amber-200`}>
                    Vendor not listed? + Create new vendor
                  </button>
                )
              ) : null}
            </div>
          </div>

          {/* 4. Invoice-line table with AI classification */}
          <div className={panelClass}>
            <div className={panelHeaderClass}>
              <div>
                <h2 className={panelTitleClass}>Invoice lines ({lines.length})</h2>
                <p className={panelMetaClass}>AI has read each line and proposed how it should be treated. Review and change any classification.</p>
              </div>
              {editable ? (
                <button type="button" onClick={onAddLine} className={`${textLinkClass} text-amber-400 hover:text-amber-300`}>
                  + Add line
                </button>
              ) : null}
            </div>
            {lines.length === 0 ? <p className={`${panelBodyClass} text-xs text-zinc-500`}>No lines.</p> : null}
            {lines.length > 0 ? (
              <div className={`${tableWrapClass} rounded-t-none border-0`}>
                <table className={tableClass}>
                  <thead className={tableHeadClass}>
                    <tr>
                      <th className={tableHeadCellClass}>#</th>
                      <th className={tableHeadCellClass}>Raw description</th>
                      <th className={tableHeadCellClass}>SKU</th>
                      <th className={tableHeadCellRightClass}>Qty</th>
                      <th className={tableHeadCellClass}>Unit</th>
                      <th className={tableHeadCellRightClass}>Unit price</th>
                      <th className={tableHeadCellRightClass}>Amount</th>
                      <th className={tableHeadCellClass}>AI treatment</th>
                      <th className={tableHeadCellClass}>Confidence</th>
                      <th className={tableHeadCellClass}>Status</th>
                      <th className={tableHeadCellClass}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const row = line.lineKey ? rowByLineKey.get(line.lineKey) ?? null : null;
                      const readiness = line.lineKey ? readinessByLineKey.get(line.lineKey) ?? null : null;
                      const saved = Boolean(line.lineKey && rowByLineKey.has(line.lineKey));
                      const resolvedNote = resolvedNotesByLineIndex.get(index);
                      const attention = readiness ? !readiness.classificationSettled : saved && !matchingActive;
                      const band = confidenceBand(row?.aiConfidence ?? null);
                      const editingValues = editingValuesIndex === index;
                      const qty = line.packageQuantity ?? line.measuredQuantity;
                      const unit = line.packageQuantity !== null ? line.packageUnit : line.measuredUnit;
                      return (
                        <RowGroup key={line.lineKey ?? index}>
                          <tr
                            id={`step1-line-${index}`}
                            tabIndex={-1}
                            className={`border-b border-zinc-800/70 align-top transition-colors focus:outline-none ${highlightedLine === index ? "bg-amber-950/20" : attention ? "border-l-2 border-l-amber-500 bg-amber-950/5" : "hover:bg-zinc-800/30"}`}
                          >
                            <td className={`${tableCellClass} text-xs text-zinc-500`}>{index + 1}</td>
                            <td className={`${tableCellClass} max-w-64`}>
                              <p className="whitespace-normal break-words font-mono text-[13px] text-zinc-100">{line.description ?? "—"}</p>
                              {resolvedNote ? <p className="mt-1 text-[11px] text-emerald-400">✓ Invoice unit resolved via confirmed item match{resolvedNote.unitCode ? ` (${resolvedNote.unitCode})` : ""}</p> : null}
                            </td>
                            <td className={`${tableCellClass} text-xs text-zinc-300`}>{line.vendorSku ?? "—"}</td>
                            <td className={tableCellRightClass}>{qty ?? "—"}</td>
                            <td className={`${tableCellClass} text-xs text-zinc-300`}>{unit ?? "—"}</td>
                            <td className={tableCellRightClass}>{formatMoney(line.unitPrice, currency)}</td>
                            <td className={`${tableCellRightClass} font-medium ${line.lineTotal !== null && line.lineTotal < 0 ? "text-sky-300" : ""}`}>{formatMoney(line.lineTotal, currency)}</td>
                            <td className={`${tableCellClass} max-w-56`}>{treatmentCell(row)}</td>
                            <td className={`${tableCellClass} text-xs`}>
                              {row && row.aiConfidence !== null ? (
                                <span className={band === "high" ? "text-emerald-300" : band === "medium" ? "text-amber-300" : "text-red-300"}>
                                  {formatConfidence(row.aiConfidence)}
                                  {readiness?.aiLabel ? <span className="block text-[11px] text-zinc-500">{readiness.aiLabel}</span> : null}
                                </span>
                              ) : (
                                <span className="text-zinc-500">—</span>
                              )}
                            </td>
                            <td className={tableCellClass}>{statusBadge(readiness, row, saved)}</td>
                            <td className={tableCellClass}>
                              {editable ? (
                                <div className="flex flex-col items-start gap-1">
                                  {saved && row ? (
                                    <button type="button" onClick={() => openClassifier(row.lineKey)} className={compactButtonClass}>
                                      {row.status === "UNCLASSIFIED" || row.lineTreatment === "UNRESOLVED"
                                        ? "Classify"
                                        : readiness && !readiness.classificationSettled && readiness.status === "review_recommended"
                                          ? "Confirm"
                                          : row.lineTreatment === "INVENTORY_PURCHASE"
                                            ? "Change classification"
                                            : row.lineTreatment === "EXPENSE" || row.lineTreatment === "FREIGHT_FEE"
                                              ? "Edit expense category"
                                              : "Change treatment"}
                                    </button>
                                  ) : null}
                                  {saved && row && row.lineTreatment === "INVENTORY_PURCHASE" ? (
                                    <button type="button" onClick={() => onChangeItemMatch(row.lineKey)} className={`${textLinkClass} text-amber-300 hover:text-amber-200`}>
                                      Change item match
                                    </button>
                                  ) : null}
                                  <button type="button" onClick={() => setEditingValuesIndex(editingValues ? null : index)} className={textLinkClass} aria-expanded={editingValues}>
                                    {editingValues ? "Done editing values" : "Correct invoice value"}
                                  </button>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                          {editingValues && editable ? (
                            <tr className="border-b border-zinc-800/70 bg-zinc-950/40">
                              <td colSpan={11} className="px-3 py-3">
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                                  <TextField label="SKU" value={line.vendorSku} disabled={false} onChange={(v) => onLineChange(index, { vendorSku: v })} />
                                  <TextField label="Description" value={line.description} disabled={false} onChange={(v) => onLineChange(index, { description: v })} />
                                  <NumberField label="Pkg qty" value={line.packageQuantity} disabled={false} onChange={(v) => onLineChange(index, { packageQuantity: v })} />
                                  <TextField label="Pkg unit" value={line.packageUnit} disabled={false} onChange={(v) => onLineChange(index, { packageUnit: v })} />
                                  <NumberField label="Measured qty" value={line.measuredQuantity} disabled={false} onChange={(v) => onLineChange(index, { measuredQuantity: v })} />
                                  <TextField label="Measured unit" value={line.measuredUnit} disabled={false} onChange={(v) => onLineChange(index, { measuredUnit: v })} />
                                  <NumberField label="Unit price" value={line.unitPrice} disabled={false} onChange={(v) => onLineChange(index, { unitPrice: v })} />
                                  <TextField label="Price basis" value={line.priceBasisUnit} disabled={false} onChange={(v) => onLineChange(index, { priceBasisUnit: v })} />
                                  <NumberField label="Line total" value={line.lineTotal} disabled={false} onChange={(v) => onLineChange(index, { lineTotal: v })} />
                                </div>
                                <p className="mt-2 text-[11px] text-zinc-500">Changing the description, SKU or units re-opens the classification for this line after you save.</p>
                                <button type="button" onClick={() => { onRemoveLine(index); setEditingValuesIndex(null); }} className="mt-2 text-xs text-red-400 underline underline-offset-2">
                                  Remove line
                                </button>
                              </td>
                            </tr>
                          ) : null}
                        </RowGroup>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            {classificationRows === null && lines.length > 0 ? (
              <p aria-busy="true" className={`${panelBodyClass} pt-2 text-xs text-zinc-500`}>Loading classifications…</p>
            ) : unsavedLineCount > 0 && editable ? (
              <p className={`${panelBodyClass} pt-2 text-xs text-zinc-500`}>{unsavedLineCount} new line{unsavedLineCount === 1 ? "" : "s"} will be classified after you save.</p>
            ) : null}
          </div>

          {/* 6. Totals reconciliation */}
          <div className={panelClass}>
            <div className={panelHeaderClass}>
              <h2 className={panelTitleClass}>Totals reconciliation</h2>
              {totals.reconciles === null ? null : totals.reconciles ? (
                <span className="text-xs font-medium text-emerald-400">✓ Reconciles with invoice total</span>
              ) : (
                <span className="text-xs font-medium text-amber-300">Differs from invoice total by {formatMoney(totals.difference, currency)}</span>
              )}
            </div>
            <dl className={`${panelBodyClass} grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3`}>
              <TotalsRow label="Merchandise subtotal" value={formatMoney(totals.merchandiseSubtotal, currency)} />
              <TotalsRow label="Expenses & fees" value={formatMoney(totals.expensesAndFees, currency)} />
              <TotalsRow label={totals.usedHeaderTax ? "Tax (from header)" : "Tax"} value={formatMoney(totals.tax, currency)} />
              <TotalsRow label="Discounts" value={formatMoney(totals.discounts, currency)} />
              <TotalsRow label="Credits" value={formatMoney(totals.credits, currency)} />
              {totals.unresolved !== 0 ? <TotalsRow label="Unclassified lines" value={formatMoney(totals.unresolved, currency)} warn /> : null}
              <TotalsRow label="Computed total" value={formatMoney(totals.computedTotal, currency)} emphasize />
              <TotalsRow label="Invoice total (header)" value={formatMoney(totals.headerTotal, currency)} emphasize />
            </dl>
          </div>
        </div>
      </div>

      {/* 5. Classification editor */}
      {editable ? (
        <ClassifyLineDrawer
          open={classifyingRow !== null}
          line={classifyingRow}
          purchaseDocumentId={purchaseDocumentId}
          currency={currency}
          spendCategories={spendCategories}
          items={items}
          units={units}
          locations={locations}
          documentLines={lines.filter((l) => l.lineKey).map((l) => ({ lineKey: l.lineKey as string, description: l.description }))}
          onSaved={async () => {
            await onClassificationChanged();
            setClassifyingLineKey(null);
          }}
          onRequestClose={() => setClassifyingLineKey(null)}
          onChangeItemMatch={(lineKey) => {
            setClassifyingLineKey(null);
            onChangeItemMatch(lineKey);
          }}
          onPrev={classifyingIssueIndex > 0 ? () => setClassifyingLineKey(issueLineKeys[classifyingIssueIndex - 1]) : undefined}
          onNext={classifyingIssueIndex >= 0 && classifyingIssueIndex < issueLineKeys.length - 1 ? () => setClassifyingLineKey(issueLineKeys[classifyingIssueIndex + 1]) : undefined}
          navLabel={classifyingIssueIndex >= 0 && issueLineKeys.length > 1 ? `Issue ${classifyingIssueIndex + 1} of ${issueLineKeys.length}` : undefined}
        />
      ) : null}

      {/* 7. Sticky continue footer -- same readiness as the Stepper */}
      {editable ? (
        <>
          {stepError ? <p className="text-sm text-red-400">{stepError}</p> : null}
          <WorkflowFooter
            contextLabel={
              issueCount > 0
                ? issueCountLabel(issueCount)
                : isDirty
                  ? "Unsaved changes — Continue saves them first"
                  : (savedMessage ?? (classificationRows !== null && lines.length > 0 ? `${lines.length} line${lines.length === 1 ? "" : "s"} classified` : undefined))
            }
            contextTone={issueCount > 0 ? "warning" : "neutral"}
            onContextClick={
              issueCount > 0
                ? () => {
                    if (classificationIssues.length > 0 && classificationIssues[0].line.lineKey) openClassifier(classificationIssues[0].line.lineKey);
                    else if (blockingFlags[0]?.lineIndex !== null && blockingFlags[0]?.lineIndex !== undefined) focusLine(blockingFlags[0].lineIndex);
                  }
                : undefined
            }
            primaryLabel="Continue to Items & Receiving"
            onPrimary={onContinue}
            primaryDisabled={savePending || issueCount > 0 || matchingActive}
            primaryPending={continuePending}
            primaryPendingLabel="Saving…"
            primaryTitle={
              blockingFlags.length > 0
                ? "Complete the required fields listed above before continuing."
                : unresolvedCount > 0
                  ? `Classify ${unresolvedCount} invoice line${unresolvedCount === 1 ? "" : "s"} before continuing.`
                  : classificationIssues.length > 0
                    ? "Confirm the recommended classifications before continuing."
                    : matchingActive
                      ? "Wait for classification to finish."
                      : undefined
            }
            secondaryLabel="Save draft"
            onSecondary={onSave}
            secondaryDisabled={continuePending}
            secondaryPending={savePending}
            secondaryPendingLabel="Saving…"
          />
        </>
      ) : null}
    </div>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function TotalsRow({ label, value, emphasize, warn }: { label: string; value: string; emphasize?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 py-1 sm:border-0">
      <dt className={`text-xs ${warn ? "text-amber-300" : "text-zinc-500"}`}>{label}</dt>
      <dd className={`tabular-nums ${emphasize ? "font-semibold text-zinc-100" : warn ? "text-amber-200" : "text-zinc-200"}`}>{value}</dd>
    </div>
  );
}

function matchSourceLabel(source: string): string {
  switch (source) {
    case "VENDOR_SKU_MAPPING":
      return "Vendor SKU mapping";
    case "VENDOR_DESCRIPTION_MAPPING":
      return "Vendor description mapping";
    case "NORMALIZED_NAME_MATCH":
      return "Name match";
    case "AI_SUGGESTED":
      return "AI suggestion";
    case "AI_ACCEPTED":
      return "AI assigned";
    case "VENDOR_TREATMENT_RULE":
      return "Previous decision";
    default:
      return "Manager set";
  }
}

export { emptyLine as emptyStep1Line };
