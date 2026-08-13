"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDocumentViewUrl } from "@/app/actions/documentAccess";
import {
  savePurchaseDocumentDraft,
  submitPurchaseDocumentForVerification,
  verifyPurchaseDocument,
  returnPurchaseDocumentToDraft,
  checkPurchaseDocumentDuplicates,
} from "@/app/actions/purchaseDocuments";
import type { PossibleDuplicatePurchaseDocument } from "@/app/lib/purchaseDocuments/duplicateDetection";
import { DocumentViewer } from "@/app/components/documents/DocumentViewer";
import { validatePurchaseDocumentDraft } from "@/app/lib/purchaseDocuments/validatePurchaseDocumentDraft";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentStatus, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { NormalizedInvoiceLine, ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { VendorSummary } from "@/app/actions/vendors";

const STATUS_LABEL: Record<PurchaseDocumentStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_VERIFICATION: "Ready for Verification",
  VERIFIED: "Verified",
};

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

interface Props {
  purchaseDocumentId: string;
  documentId: string;
  currentAppUserId: string;
  isPreparer: boolean;
  originalFilename: string;
  contentType: string;
  status: PurchaseDocumentStatus;
  version: number;
  header: PurchaseDocumentHeaderDraft;
  lines: NormalizedInvoiceLine[];
  vendorName: string | null;
  declaredVendorName: string | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedVendorName: string | null;
  aiSuggestedDocumentType: string | null;
  aiWarnings: string[];
  aiReviewFlags: ReviewFlag[];
  aiModel: string | null;
  hasNewerExtraction: boolean;
  verifiedByAppUserId: string | null;
  verifiedAt: string | null;
  lastReturnedReason: string | null;
  lastReturnedAt: string | null;
  vendors: VendorSummary[];
  initialDuplicates: PossibleDuplicatePurchaseDocument[];
}

const DUPLICATE_STATUS_LABEL: Record<PurchaseDocumentStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_VERIFICATION: "Ready for Verification",
  VERIFIED: "Verified",
};

function emptyLine(): NormalizedInvoiceLine {
  return {
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

export function PurchaseDocumentReviewView(props: Props) {
  const router = useRouter();
  const [header, setHeader] = useState<PurchaseDocumentHeaderDraft>({
    vendorId: props.header.vendorId,
    documentType: props.header.documentType,
    documentNumber: props.header.documentNumber,
    documentDate: props.header.documentDate,
    poNumber: props.header.poNumber,
    deliveryDate: props.header.deliveryDate,
    subtotal: props.header.subtotal,
    tax: props.header.tax,
    fees: props.header.fees,
    total: props.header.total,
    currency: props.header.currency,
  });
  const [lines, setLines] = useState<NormalizedInvoiceLine[]>(props.lines);
  const [version, setVersion] = useState(props.version);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useState<"document" | "form">("document");
  const [savePending, setSavePending] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [duplicates, setDuplicates] = useState<PossibleDuplicatePurchaseDocument[]>(props.initialDuplicates);
  const [duplicatesDismissed, setDuplicatesDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDocumentViewUrl(props.documentId).then((result) => {
      if (cancelled) return;
      if (result.ok) setViewUrl(result.url);
      else setViewError(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [props.documentId]);

  const editable = props.isPreparer && props.status === "DRAFT";

  // Non-blocking re-check as the preparer edits vendor/type/number -- surfaces
  // the warning during draft review, well before Submit, without gating any
  // button. Debounced so it doesn't fire on every keystroke.
  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      checkPurchaseDocumentDuplicates({
        purchaseDocumentId: props.purchaseDocumentId,
        vendorId: header.vendorId,
        documentType: header.documentType,
        documentNumber: header.documentNumber,
      }).then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setDuplicates(result.duplicates);
          setDuplicatesDismissed(false);
        }
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editable, props.purchaseDocumentId, header.vendorId, header.documentType, header.documentNumber]);

  const flags = useMemo(() => validatePurchaseDocumentDraft({ ...header, lines }), [header, lines]);
  const canSubmit = Boolean(header.vendorId) && Boolean(header.documentType) && lines.length > 0;

  function updateHeader<K extends keyof PurchaseDocumentHeaderDraft>(key: K, value: PurchaseDocumentHeaderDraft[K]) {
    setHeader((prev) => ({ ...prev, [key]: value }));
    setSavedMessage(null);
  }

  function updateLine(index: number, patch: Partial<NormalizedInvoiceLine>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
    setSavedMessage(null);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
    setSavedMessage(null);
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
    setSavedMessage(null);
  }

  async function handleSave() {
    setSavePending(true);
    setActionError(null);
    setSavedMessage(null);
    const result = await savePurchaseDocumentDraft({
      purchaseDocumentId: props.purchaseDocumentId,
      expectedVersion: version,
      header,
      lines,
    });
    setSavePending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    setVersion(result.version);
    setSavedMessage("Draft saved.");
  }

  async function handleSubmit() {
    setActionPending(true);
    setActionError(null);
    const result = await submitPurchaseDocumentForVerification(props.purchaseDocumentId, version);
    setActionPending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    router.refresh();
  }

  async function handleVerify() {
    setActionPending(true);
    setActionError(null);
    const result = await verifyPurchaseDocument(props.purchaseDocumentId, version);
    setActionPending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    router.refresh();
  }

  async function handleReturn() {
    setActionPending(true);
    setActionError(null);
    const result = await returnPurchaseDocumentToDraft(props.purchaseDocumentId, version, returnReason || undefined);
    setActionPending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    router.refresh();
  }

  const canVerifyOrReturn = !props.isPreparer && props.status === "READY_FOR_VERIFICATION";

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/manager/receiving" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
        ← Receiving Queue
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{props.originalFilename}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {STATUS_LABEL[props.status]}
            {props.status === "VERIFIED" && props.verifiedAt ? ` · ${new Date(props.verifiedAt).toLocaleString()}` : ""}
          </p>
        </div>
      </div>

      {!props.isPreparer && props.status === "DRAFT" ? (
        <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          Only the manager who uploaded this document can edit its draft. You can review it once submitted.
        </p>
      ) : null}
      {props.isPreparer && props.status === "READY_FOR_VERIFICATION" ? (
        <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          Submitted for verification. Another manager must verify or return this document -- you cannot verify your own
          submission.
        </p>
      ) : null}
      {props.lastReturnedReason && props.status === "DRAFT" ? (
        <p className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          Returned{props.lastReturnedAt ? ` on ${new Date(props.lastReturnedAt).toLocaleString()}` : ""}: {props.lastReturnedReason}
        </p>
      ) : null}
      {props.hasNewerExtraction ? (
        <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          A newer AI extraction attempt is available for this document -- this draft was not automatically updated.
        </p>
      ) : null}
      {duplicates.length > 0 && !duplicatesDismissed ? (
        <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          <p className="font-semibold">Possible duplicate</p>
          <ul className="mt-1 flex flex-col gap-1">
            {duplicates.map((dup) => (
              <li key={dup.purchaseDocumentId}>
                {props.vendorName ?? "This vendor"} ·{" "}
                {header.documentType ? DOCUMENT_NUMBER_LABEL[header.documentType] : "Document #"} {dup.documentNumber}
                <br />
                {dup.documentDate ? `${new Date(dup.documentDate).toLocaleDateString()} · ` : ""}
                {DUPLICATE_STATUS_LABEL[dup.status]}
                {" · "}
                <Link href={`/manager/purchases/${dup.purchaseDocumentId}`} className="underline">
                  Open Existing
                </Link>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setDuplicatesDismissed(true)} className="mt-2 text-xs text-amber-300 underline">
            Continue Anyway
          </button>
        </div>
      ) : null}
      {actionError ? <p className="mt-3 text-sm text-red-400">{actionError}</p> : null}

      <div className="mt-4 flex gap-2 lg:hidden">
        <button
          type="button"
          onClick={() => setNarrowPane("document")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold ${
            narrowPane === "document" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"
          }`}
        >
          Document
        </button>
        <button
          type="button"
          onClick={() => setNarrowPane("form")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold ${
            narrowPane === "form" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"
          }`}
        >
          Draft
        </button>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className={`rounded-2xl border border-zinc-800 bg-zinc-900 p-4 ${narrowPane === "document" ? "" : "hidden lg:block"}`}>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Original Document</h2>
          <DocumentViewer viewUrl={viewUrl} viewError={viewError} contentType={props.contentType} />
        </div>

        <div className={`flex flex-col gap-6 ${narrowPane === "form" ? "" : "hidden lg:flex"}`}>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Header</h2>

            <MismatchNote label="Vendor" declared={props.declaredVendorName} aiSuggested={props.aiSuggestedVendorName} current={props.vendorName} />
            <MismatchNote
              label="Document type"
              declared={props.declaredDocumentType}
              aiSuggested={props.aiSuggestedDocumentType}
              current={header.documentType}
            />

            <div className="mt-3 grid grid-cols-2 gap-3">
              <SelectField
                label="Vendor"
                value={header.vendorId ?? ""}
                disabled={!editable}
                onChange={(v) => updateHeader("vendorId", v || null)}
                options={[{ value: "", label: "Select vendor…" }, ...props.vendors.map((v) => ({ value: v.id, label: v.name }))]}
              />
              <SelectField
                label="Document type"
                value={header.documentType ?? ""}
                disabled={!editable}
                onChange={(v) => updateHeader("documentType", (v || null) as PurchaseDocumentType | null)}
                options={[{ value: "", label: "Select type…" }, ...DOCUMENT_TYPE_OPTIONS]}
              />
              <TextField
                label={header.documentType ? DOCUMENT_NUMBER_LABEL[header.documentType] : "Document #"}
                value={header.documentNumber}
                disabled={!editable}
                onChange={(v) => updateHeader("documentNumber", v)}
              />
              <DateField label="Document date" value={header.documentDate} disabled={!editable} onChange={(v) => updateHeader("documentDate", v)} />
              <TextField label="PO #" value={header.poNumber} disabled={!editable} onChange={(v) => updateHeader("poNumber", v)} />
              <DateField label="Delivery date" value={header.deliveryDate} disabled={!editable} onChange={(v) => updateHeader("deliveryDate", v)} />
              <NumberField label="Subtotal" value={header.subtotal} disabled={!editable} onChange={(v) => updateHeader("subtotal", v)} />
              <NumberField label="Tax" value={header.tax} disabled={!editable} onChange={(v) => updateHeader("tax", v)} />
              <NumberField label="Fees" value={header.fees} disabled={!editable} onChange={(v) => updateHeader("fees", v)} />
              <NumberField label="Total" value={header.total} disabled={!editable} onChange={(v) => updateHeader("total", v)} />
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Lines</h2>
              {editable ? (
                <button type="button" onClick={addLine} className="text-xs text-amber-400 underline">
                  + Add Line
                </button>
              ) : null}
            </div>
            <div className="flex flex-col gap-3">
              {lines.length === 0 ? <p className="text-xs text-zinc-500">No lines.</p> : null}
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-800 p-3 sm:grid-cols-3">
                  <TextField label="SKU" value={line.vendorSku} disabled={!editable} onChange={(v) => updateLine(index, { vendorSku: v })} />
                  <TextField
                    label="Description"
                    value={line.description}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { description: v })}
                  />
                  <NumberField
                    label="Pkg Qty"
                    value={line.packageQuantity}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { packageQuantity: v })}
                  />
                  <TextField
                    label="Pkg Unit"
                    value={line.packageUnit}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { packageUnit: v })}
                  />
                  <NumberField
                    label="Measured Qty"
                    value={line.measuredQuantity}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { measuredQuantity: v })}
                  />
                  <TextField
                    label="Measured Unit"
                    value={line.measuredUnit}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { measuredUnit: v })}
                  />
                  <NumberField
                    label="Unit Price"
                    value={line.unitPrice}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { unitPrice: v })}
                  />
                  <TextField
                    label="Price Basis"
                    value={line.priceBasisUnit}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { priceBasisUnit: v })}
                  />
                  <NumberField
                    label="Line Total"
                    value={line.lineTotal}
                    disabled={!editable}
                    onChange={(v) => updateLine(index, { lineTotal: v })}
                  />
                  {editable ? (
                    <button type="button" onClick={() => removeLine(index)} className="col-span-full text-left text-xs text-red-400 underline">
                      Remove Line
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <ReviewFlagsPanel title="Review flags" flags={flags} />
          {props.aiWarnings.length > 0 ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Gemini warnings{props.aiModel ? ` (${props.aiModel})` : ""}
              </h3>
              <ul className="flex flex-col gap-1 text-xs text-zinc-400">
                {props.aiWarnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {editable ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={savePending}
                className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
              >
                {savePending ? "Saving…" : "Save Draft"}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={actionPending || !canSubmit}
                title={!canSubmit ? "Select a vendor, a document type, and add at least one line to submit." : undefined}
                className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                {actionPending ? "Submitting…" : "Submit for Verification"}
              </button>
              {savedMessage ? <span className="text-xs text-emerald-400">{savedMessage}</span> : null}
            </div>
          ) : null}

          {canVerifyOrReturn ? (
            <div className="flex flex-col gap-3">
              <input
                type="text"
                value={returnReason}
                onChange={(event) => setReturnReason(event.target.value)}
                placeholder="Reason for returning (optional)"
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handleReturn}
                  disabled={actionPending}
                  className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
                >
                  {actionPending ? "…" : "Return to Draft"}
                </button>
                <button
                  type="button"
                  onClick={handleVerify}
                  disabled={actionPending}
                  className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
                >
                  {actionPending ? "…" : "Verify Invoice"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MismatchNote({
  label,
  declared,
  aiSuggested,
  current,
}: {
  label: string;
  declared: string | null;
  aiSuggested: string | null;
  current: string | null;
}) {
  const notes: string[] = [];
  if (declared && declared !== current) notes.push(`Originally selected: ${declared}`);
  if (aiSuggested && aiSuggested !== current && aiSuggested !== declared) notes.push(`Gemini suggested: ${aiSuggested}`);
  if (notes.length === 0) return null;
  return (
    <p className="mb-2 text-xs text-amber-400">
      {label} — {notes.join(" · ")}
    </p>
  );
}

function ReviewFlagsPanel({ title, flags }: { title: string; flags: ReviewFlag[] }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-400">{title}</h3>
      {flags.length === 0 ? (
        <p className="text-xs text-emerald-400">None.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {flags.map((flag, index) => (
            <li key={index} className={flag.severity === "error" ? "text-red-300" : flag.severity === "warning" ? "text-amber-300" : "text-zinc-400"}>
              [{flag.severity}] {flag.code}
              {flag.field ? ` (${flag.field})` : ""}: {flag.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <input
        type="text"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </label>
  );
}

function DateField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <input
        type="date"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <input
        type="number"
        step="0.01"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  disabled,
  onChange,
  options,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
