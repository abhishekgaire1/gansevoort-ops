"use client";

import { useMemo, useState } from "react";
import { DocumentViewer } from "@/app/components/documents/DocumentViewer";
import { DateField, MismatchNote, NumberField, SelectField, TextField } from "./DocumentFields";
import { translateReviewFlags } from "@/app/lib/purchaseDocuments/reviewFlagText";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { VendorSummary } from "@/app/actions/vendors";

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
 * Step 1 -- the original PDF stays visible (sticky within this step's own
 * fixed-height workspace) while the extracted header/lines scroll
 * independently on the right, exactly like comparing a paper invoice
 * against a printed worksheet side by side. Never Item Mapping or
 * Receiving -- those are Steps 2/3.
 *
 * Desktop: a two-column workspace sized to the viewport (so the manager
 * never scrolls the OUTER page through thousands of pixels of line items --
 * only the right pane scrolls, internally). Narrow screens: an Original/
 * Extracted tab toggle that hides panes via CSS (never unmounts them), so
 * switching tabs never loses the right pane's scroll position, the PDF's
 * current page/zoom, or any unsaved field edit.
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
  vendors,
  reviewFlags,
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
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedDocumentType: string | null;
  vendors: VendorSummary[];
  reviewFlags: ReviewFlag[];
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

  const translatedFlags = useMemo(() => translateReviewFlags(reviewFlags, lines), [reviewFlags, lines]);
  const blockingFlags = translatedFlags.filter((f) => f.severity === "error");
  const errorCount = blockingFlags.length;

  function focusLine(lineIndex: number) {
    setNarrowPane("form");
    setHighlightedLine(lineIndex);
    const el = document.getElementById(`step1-line-${lineIndex}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlightedLine((current) => (current === lineIndex ? null : current)), 2000);
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      {translatedFlags.length > 0 ? (
        <div className="rounded-2xl border border-amber-800 bg-amber-950/20 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-400">
            Needs attention{errorCount > 0 ? ` (${errorCount})` : ""}
          </h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {translatedFlags.map((flag, index) => (
              <li key={index} className={flag.severity === "error" ? "text-red-300" : flag.severity === "warning" ? "text-amber-200" : "text-zinc-400"}>
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
        <p className="rounded-2xl border border-emerald-800 bg-emerald-950/10 px-4 py-2 text-sm text-emerald-400">✓ No extraction issues found.</p>
      )}

      {aiWarnings.length > 0 ? (
        <details className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400">
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
          className={`rounded-full px-4 py-1.5 text-xs font-semibold ${narrowPane === "document" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}
        >
          Original Invoice
        </button>
        <button
          type="button"
          onClick={() => setNarrowPane("form")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold ${narrowPane === "form" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}
        >
          Extracted Data
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:h-[calc(100vh-16rem)] lg:min-h-[36rem] lg:grid-cols-2">
        <div
          className={`flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-4 lg:h-full lg:overflow-hidden ${narrowPane === "document" ? "" : "hidden lg:flex"}`}
        >
          <h2 className="mb-3 shrink-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">Original Invoice</h2>
          <div className="min-h-0 flex-1">
            <DocumentViewer viewUrl={viewUrl} viewError={viewError} contentType={contentType} heightClassName="h-full" />
          </div>
        </div>

        <div className={`flex flex-col gap-4 lg:h-full lg:overflow-y-auto lg:pr-1 ${narrowPane === "form" ? "" : "hidden lg:flex"}`}>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Header</h2>

            <MismatchNote label="Vendor" declared={declaredVendorName} aiSuggested={aiSuggestedVendorName} current={vendors.find((v) => v.id === header.vendorId)?.name ?? null} />
            <MismatchNote label="Document type" declared={declaredDocumentType} aiSuggested={aiSuggestedDocumentType} current={header.documentType} />

            <div className="mt-3 grid grid-cols-2 gap-3">
              <SelectField
                label="Vendor"
                value={header.vendorId ?? ""}
                disabled={!editable}
                onChange={(v) => onHeaderChange("vendorId", v || null)}
                options={[{ value: "", label: "Select vendor…" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
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
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Lines ({lines.length})</h2>
              {editable ? (
                <button type="button" onClick={onAddLine} className="text-xs text-amber-400 underline">
                  + Add Line
                </button>
              ) : null}
            </div>
            <div className="flex flex-col gap-3">
              {lines.length === 0 ? <p className="text-xs text-zinc-500">No lines.</p> : null}
              {lines.map((line, index) => (
                <div
                  key={line.lineKey ?? index}
                  id={`step1-line-${index}`}
                  className={`grid grid-cols-2 gap-2 rounded-lg border p-3 transition-colors sm:grid-cols-3 ${
                    highlightedLine === index ? "border-amber-500 bg-amber-950/20" : "border-zinc-800"
                  }`}
                >
                  <TextField label="SKU" value={line.vendorSku} disabled={!editable} onChange={(v) => onLineChange(index, { vendorSku: v })} />
                  <TextField label="Description" value={line.description} disabled={!editable} onChange={(v) => onLineChange(index, { description: v })} />
                  <NumberField label="Pkg Qty" value={line.packageQuantity} disabled={!editable} onChange={(v) => onLineChange(index, { packageQuantity: v })} />
                  <TextField label="Pkg Unit" value={line.packageUnit} disabled={!editable} onChange={(v) => onLineChange(index, { packageUnit: v })} />
                  <NumberField label="Measured Qty" value={line.measuredQuantity} disabled={!editable} onChange={(v) => onLineChange(index, { measuredQuantity: v })} />
                  <TextField label="Measured Unit" value={line.measuredUnit} disabled={!editable} onChange={(v) => onLineChange(index, { measuredUnit: v })} />
                  <NumberField label="Unit Price" value={line.unitPrice} disabled={!editable} onChange={(v) => onLineChange(index, { unitPrice: v })} />
                  <TextField label="Price Basis" value={line.priceBasisUnit} disabled={!editable} onChange={(v) => onLineChange(index, { priceBasisUnit: v })} />
                  <NumberField label="Line Total" value={line.lineTotal} disabled={!editable} onChange={(v) => onLineChange(index, { lineTotal: v })} />
                  {editable ? (
                    <button type="button" onClick={() => onRemoveLine(index)} className="col-span-full text-left text-xs text-red-400 underline">
                      Remove Line
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          {editable ? (
            <div className="sticky bottom-0 -mx-1 flex flex-col gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
              {blockingFlags.length > 0 ? (
                <p className="text-xs text-amber-400">
                  Complete {blockingFlags.length} required field{blockingFlags.length === 1 ? "" : "s"} before continuing:{" "}
                  {blockingFlags.map((f) => f.text).join(" ")}
                </p>
              ) : null}
              {stepError ? <p className="text-sm text-red-400">{stepError}</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onContinue}
                  disabled={continuePending || savePending || blockingFlags.length > 0}
                  aria-disabled={continuePending || savePending || blockingFlags.length > 0}
                  title={blockingFlags.length > 0 ? "Complete the required fields listed above before continuing." : undefined}
                  className="rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {continuePending ? "Saving…" : "Continue to Items"}
                </button>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={savePending || continuePending}
                  className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-200 disabled:opacity-40"
                >
                  {savePending ? "Saving…" : "Save Draft"}
                </button>
                {savedMessage ? <span className="text-xs text-emerald-400">{savedMessage}</span> : null}
                <span className="text-xs text-zinc-500">Item matching may already be running in the background.</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { emptyLine as emptyStep1Line };
