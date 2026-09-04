"use client";

import { useMemo, useState } from "react";
import { DocumentViewer } from "@/app/components/documents/DocumentViewer";
import { DateField, MismatchNote, NumberField, SelectField, TextField } from "./DocumentFields";
import { translateReviewFlags } from "@/app/lib/purchaseDocuments/reviewFlagText";
import { WorkflowFooter } from "@/app/components/receiving/WorkflowFooter";
import { blockingIssueSummaryLabel } from "@/app/components/receiving/blockingIssues";
import { isRecognizedCreditLine } from "@/app/lib/ai/tasks/invoiceExtraction/validate";
import { formatMoney } from "@/app/lib/formatMoney";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { ResolvedUnitNote } from "@/app/lib/purchaseDocuments/lineUnitResolution";
import { createVendorFromReceiving, type VendorSummary } from "@/app/actions/vendors";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, inlineWarningClass, inlineSuccessClass, inlineNeutralClass } from "@/app/components/manager/surfaces";
import { primaryButtonClass, textLinkClass } from "@/app/components/manager/buttonStyles";

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

/**
 * Step 1 -- a stable split-pane desktop workspace (Desktop Application
 * Design System pass): the original document stays visible at a fixed
 * ~55% width while the extracted header/lines scroll independently at
 * ~45%, both panes starting at the same height. Warnings render beside
 * the exact field/line they concern (never one giant detached banner);
 * a compact clickable issue navigator appears only when several genuine
 * issues exist. Narrow screens fall back to an Original/Extracted tab
 * toggle that hides panes via CSS (never unmounts them), so switching
 * tabs never loses scroll position, PDF page/zoom, or an unsaved edit.
 */
export function Step1ReviewInvoice({
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
  onContinue,
  continuePending,
  onSave,
  savePending,
  savedMessage,
  stepError,
}: {
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
  /** A vendor-printed account balance/amount due that appears to include
   * prior invoices -- distinct from header.total, which stays this
   * document's own total. Null on the ordinary invoice (most invoices),
   * where this block is not shown at all (never shown unless genuine
   * ambiguity exists). */
  aiAmountDue: number | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedDocumentType: string | null;
  vendors: VendorSummary[];
  /** Already reconciled against Step 2's own authoritative classification
   * state (see lineUnitResolution.ts) -- a resolved line's stale-unit
   * warning has already been removed from this array by the caller,
   * never re-derived here. */
  reviewFlags: ReviewFlag[];
  /** Which lines had a stale-unit warning removed, and WHERE that
   * resolution came from -- shown as a calm positive note in place of
   * the cleared warning, never silently vanishing with no explanation. */
  resolvedUnitNotes: ResolvedUnitNote[];
  aiWarnings: string[];
  aiModel: string | null;
  onContinue: () => void;
  continuePending: boolean;
  onSave: () => void;
  savePending: boolean;
  savedMessage: string | null;
  /** A save/continue failure -- shown right here on Step 1, never silently
   * swallowed into a state variable only some OTHER step happens to
   * render. */
  stepError: string | null;
}) {
  const [narrowPane, setNarrowPane] = useState<"document" | "form">("document");
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const [vendorList, setVendorList] = useState(vendors);
  const [creatingVendor, setCreatingVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [vendorCreatePending, setVendorCreatePending] = useState(false);
  const [vendorCreateError, setVendorCreateError] = useState<string | null>(null);

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
  const errorCount = blockingFlags.length;
  // "Needs attention" is for things that genuinely need it -- error/warning
  // only. A recognized credit line or a confidently-identified account
  // balance is an INFO-severity fact, not a problem, and is already shown
  // at its own line (the Credit badge) or in the Vendor Account block
  // above -- repeating it in this alarming banner would be exactly the
  // "giant NEEDS ATTENTION for clearly valid credit lines" bad UX this
  // fix removes.
  const attentionFlags = translatedFlags.filter((f) => f.severity !== "info");
  const resolvedNotesByLineIndex = new Map(
    resolvedUnitNotes.map((note) => [lines.findIndex((l) => l.lineKey === note.lineKey), note] as const)
  );

  function focusLine(lineIndex: number) {
    setNarrowPane("form");
    setHighlightedLine(lineIndex);
    const el = document.getElementById(`step1-line-${lineIndex}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlightedLine((current) => (current === lineIndex ? null : current)), 2000);
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* Compact issue navigator -- a slim clickable list, never one giant
          detached box competing with the actual work below. */}
      {attentionFlags.length > 0 ? (
        <div className={inlineWarningClass}>
          <p className="font-semibold uppercase tracking-wide text-amber-400">
            {errorCount > 0 ? blockingIssueSummaryLabel(errorCount, "issue") : `${attentionFlags.length} note${attentionFlags.length === 1 ? "" : "s"}`}
          </p>
          <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {attentionFlags.map((flag, index) => (
              <li key={index} className={flag.severity === "error" ? "text-red-300" : "text-amber-200"}>
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
      ) : (
        <p className={inlineSuccessClass}>✓ No extraction issues found.</p>
      )}

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
        <button
          type="button"
          onClick={() => setNarrowPane("document")}
          className={`rounded-lg px-4 py-1.5 text-xs font-semibold ${narrowPane === "document" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}
        >
          Original Invoice
        </button>
        <button
          type="button"
          onClick={() => setNarrowPane("form")}
          className={`rounded-lg px-4 py-1.5 text-xs font-semibold ${narrowPane === "form" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}
        >
          Extracted Data
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:h-[calc(100vh-14rem)] lg:min-h-[36rem] lg:grid-cols-[11fr_9fr]">
        <div className={`flex flex-col lg:h-full lg:overflow-hidden ${panelClass} ${narrowPane === "document" ? "" : "hidden lg:flex"}`}>
          <div className={panelHeaderClass}>
            <h2 className={panelTitleClass}>Original Invoice</h2>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <DocumentViewer viewUrl={viewUrl} viewError={viewError} contentType={contentType} heightClassName="h-full" />
          </div>
        </div>

        <div className={`flex flex-col gap-3 lg:h-full lg:overflow-y-auto lg:pr-1 ${narrowPane === "form" ? "" : "hidden lg:flex"}`}>
          <div className={panelClass}>
            <div className={panelHeaderClass}>
              <h2 className={panelTitleClass}>Header</h2>
            </div>
            <div className={panelBodyClass}>
              <MismatchNote label="Vendor" declared={declaredVendorName} aiSuggested={aiSuggestedVendorName} current={vendorList.find((v) => v.id === header.vendorId)?.name ?? null} />
              <MismatchNote label="Document type" declared={declaredDocumentType} aiSuggested={aiSuggestedDocumentType} current={header.documentType} />

              <div className="mt-3 grid grid-cols-2 gap-3">
                <SelectField
                  label="Vendor"
                  value={header.vendorId ?? ""}
                  disabled={!editable}
                  onChange={(v) => onHeaderChange("vendorId", v || null)}
                  options={[{ value: "", label: "Select vendor…" }, ...vendorList.map((v) => ({ value: v.id, label: v.name }))]}
                />
                <SelectField
                  label="Document type"
                  value={header.documentType ?? ""}
                  disabled={!editable}
                  onChange={(v) => onHeaderChange("documentType", (v || null) as PurchaseDocumentType | null)}
                  options={[{ value: "", label: "Select type…" }, ...DOCUMENT_TYPE_OPTIONS]}
                />
                <TextField
                  label={header.documentType ? DOCUMENT_NUMBER_LABEL[header.documentType] : "Document #"}
                  value={header.documentNumber}
                  disabled={!editable}
                  onChange={(v) => onHeaderChange("documentNumber", v)}
                />
                <DateField label="Document date" value={header.documentDate} disabled={!editable} onChange={(v) => onHeaderChange("documentDate", v)} />
                <TextField label="PO #" value={header.poNumber} disabled={!editable} onChange={(v) => onHeaderChange("poNumber", v)} />
                <DateField label="Delivery date" value={header.deliveryDate} disabled={!editable} onChange={(v) => onHeaderChange("deliveryDate", v)} />
                <NumberField label="Subtotal" value={header.subtotal} disabled={!editable} onChange={(v) => onHeaderChange("subtotal", v)} />
                <NumberField label="Tax" value={header.tax} disabled={!editable} onChange={(v) => onHeaderChange("tax", v)} />
                <NumberField label="Fees" value={header.fees} disabled={!editable} onChange={(v) => onHeaderChange("fees", v)} />
                <NumberField label="Total" value={header.total} disabled={!editable} onChange={(v) => onHeaderChange("total", v)} />
              </div>

              {/* Only shown when the extraction recognized a genuine
                  current-document-vs-account-balance ambiguity -- never on
                  the ordinary invoice, where this concept doesn't apply.
                  Informational only: the Manager corrects Total above
                  directly if it should read this document's own total
                  instead of the vendor's account balance. */}
              {aiAmountDue !== null ? (
                <div className={`mt-3 ${inlineWarningClass}`}>
                  <p className="font-semibold uppercase tracking-wide text-amber-400">Vendor Account</p>
                  <p className="mt-1">
                    This invoice&apos;s printed total ({formatMoney(aiAmountDue, header.currency)}) appears to include a prior account
                    balance, not just this document. If Total above should instead be this document&apos;s own subtotal + tax + fees,
                    correct it directly.
                  </p>
                </div>
              ) : null}

              {/* Controlled Manager exception: the true vendor may not
                  exist among active vendors yet -- minimal name-only
                  quick-create right here, no Admin required, so Receiving
                  never stalls. */}
              {editable ? (
                creatingVendor ? (
                  <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-950/60 p-3">
                    <label className="flex flex-col gap-1 text-xs text-zinc-400">
                      New Vendor Name
                      <input
                        value={newVendorName}
                        onChange={(e) => setNewVendorName(e.target.value)}
                        autoFocus
                        className="h-9 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50"
                      />
                    </label>
                    {vendorCreateError ? <p className="mt-2 text-xs text-red-400">{vendorCreateError}</p> : null}
                    <div className="mt-2 flex items-center gap-3">
                      <button type="button" disabled={vendorCreatePending || !newVendorName.trim()} onClick={handleCreateVendor} className={primaryButtonClass}>
                        {vendorCreatePending ? "Creating…" : "Create & Use Vendor"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCreatingVendor(false);
                          setNewVendorName("");
                          setVendorCreateError(null);
                        }}
                        className={textLinkClass}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setCreatingVendor(true)} className={`mt-3 ${textLinkClass} text-amber-300 hover:text-amber-200`}>
                    Vendor not listed? + Create New Vendor
                  </button>
                )
              ) : null}
            </div>
          </div>

          <div className={panelClass}>
            <div className={panelHeaderClass}>
              <h2 className={panelTitleClass}>Lines ({lines.length})</h2>
              {editable ? (
                <button type="button" onClick={onAddLine} className={`${textLinkClass} text-amber-400 hover:text-amber-300`}>
                  + Add Line
                </button>
              ) : null}
            </div>
            <div className={`${panelBodyClass} flex flex-col gap-2.5`}>
              {lines.length === 0 ? <p className="text-xs text-zinc-500">No lines.</p> : null}
              {lines.map((line, index) => {
                const resolvedNote = resolvedNotesByLineIndex.get(index);
                return (
                  <div
                    key={line.lineKey ?? index}
                    id={`step1-line-${index}`}
                    className={`rounded-lg border p-3 transition-colors ${highlightedLine === index ? "border-amber-500 bg-amber-950/20" : "border-zinc-800"}`}
                  >
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {isRecognizedCreditLine(line) ? (
                        // A legitimate credit/return line -- recognized from
                        // its own numbers (negative qty + negative total,
                        // reconciling arithmetic), never colored/treated
                        // like a system error.
                        <span className="col-span-full inline-flex w-fit items-center rounded-md bg-sky-950 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-400">
                          Credit
                        </span>
                      ) : null}
                      <TextField label="SKU" value={line.vendorSku} disabled={!editable} onChange={(v) => onLineChange(index, { vendorSku: v })} />
                      <TextField label="Description" value={line.description} disabled={!editable} onChange={(v) => onLineChange(index, { description: v })} />
                      <NumberField label="Pkg Qty" value={line.packageQuantity} disabled={!editable} onChange={(v) => onLineChange(index, { packageQuantity: v })} />
                      <TextField label="Pkg Unit" value={line.packageUnit} disabled={!editable} onChange={(v) => onLineChange(index, { packageUnit: v })} />
                      <NumberField label="Measured Qty" value={line.measuredQuantity} disabled={!editable} onChange={(v) => onLineChange(index, { measuredQuantity: v })} />
                      <TextField label="Measured Unit" value={line.measuredUnit} disabled={!editable} onChange={(v) => onLineChange(index, { measuredUnit: v })} />
                      <NumberField label="Unit Price" value={line.unitPrice} disabled={!editable} onChange={(v) => onLineChange(index, { unitPrice: v })} />
                      <TextField label="Price Basis" value={line.priceBasisUnit} disabled={!editable} onChange={(v) => onLineChange(index, { priceBasisUnit: v })} />
                      <NumberField label="Line Total" value={line.lineTotal} disabled={!editable} onChange={(v) => onLineChange(index, { lineTotal: v })} />
                    </div>
                    {resolvedNote ? (
                      <p className="mt-2 text-xs text-emerald-400">
                        ✓ Invoice unit resolved via confirmed item match{resolvedNote.itemName ? `: ${resolvedNote.itemName}` : ""}
                        {resolvedNote.unitCode ? ` (${resolvedNote.unitCode})` : ""} -- see Items &amp; Receiving.
                      </p>
                    ) : null}
                    {editable ? (
                      <button type="button" onClick={() => onRemoveLine(index)} className="mt-2 text-left text-xs text-red-400 underline underline-offset-2">
                        Remove Line
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {editable ? (
            <>
              {stepError ? <p className="text-sm text-red-400">{stepError}</p> : null}
              <WorkflowFooter
                contextLabel={blockingFlags.length > 0 ? blockingIssueSummaryLabel(blockingFlags.length, "field") : (savedMessage ?? undefined)}
                contextTone={blockingFlags.length > 0 ? "warning" : "neutral"}
                onContextClick={blockingFlags.length > 0 && blockingFlags[0].lineIndex !== null ? () => focusLine(blockingFlags[0].lineIndex!) : undefined}
                primaryLabel="Continue to Items & Receiving"
                onPrimary={onContinue}
                primaryDisabled={savePending || blockingFlags.length > 0}
                primaryPending={continuePending}
                primaryPendingLabel="Saving…"
                primaryTitle={blockingFlags.length > 0 ? "Complete the required fields listed above before continuing." : undefined}
                secondaryLabel="Save Draft"
                onSecondary={onSave}
                secondaryDisabled={continuePending}
                secondaryPending={savePending}
                secondaryPendingLabel="Saving…"
              />
              <p className={inlineNeutralClass}>Item matching may already be running in the background.</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { emptyLine as emptyStep1Line };
