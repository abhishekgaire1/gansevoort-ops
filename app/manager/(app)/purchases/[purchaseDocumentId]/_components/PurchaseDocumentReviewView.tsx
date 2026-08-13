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
  saveReviewCorrections,
  checkPurchaseDocumentDuplicates,
  discardPurchaseDocumentDraft,
  withdrawPurchaseDocumentSubmission,
} from "@/app/actions/purchaseDocuments";
import type { PossibleDuplicatePurchaseDocument } from "@/app/lib/purchaseDocuments/duplicateDetection";
import { DocumentViewer } from "@/app/components/documents/DocumentViewer";
import { validatePurchaseDocumentDraft } from "@/app/lib/purchaseDocuments/validatePurchaseDocumentDraft";
import { computePurchaseDocumentDiff, purchaseDocumentDiffCount } from "@/app/lib/purchaseDocuments/diff";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentStatus, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { VendorSummary } from "@/app/actions/vendors";

/** This component only ever renders for DRAFT or READY_FOR_VERIFICATION --
 * VERIFIED routes to VerifiedPurchaseDocumentSummary and DISCARDED routes
 * to DiscardedPurchaseDocumentSummary (see page.tsx), so this narrower
 * type keeps STATUS_LABEL exhaustive without a dead DISCARDED entry. */
type ReviewableStatus = "DRAFT" | "READY_FOR_VERIFICATION";

const STATUS_LABEL: Record<ReviewableStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_VERIFICATION: "Ready for Verification",
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
  /** Preparer of THIS revision (purchase_documents.created_by_app_user_id)
   * -- for revision 1 this is always the original document uploader; for
   * an amendment it's whoever initiated it. */
  isPreparer: boolean;
  originalFilename: string;
  contentType: string;
  status: ReviewableStatus;
  version: number;
  /** 1 for the original document, >1 for an amendment -- drives whether
   * discard requires a reason and whether the button reads "Discard
   * Draft" or "Discard Amendment". */
  revisionNumber: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  /** The immutable PURCHASE_DOCUMENT_SUBMITTED baseline -- only meaningful
   * while READY_FOR_VERIFICATION, used to show "Submitted" vs. "Current"
   * and drive the live correction-count preview. Equal to header/lines
   * for any other status (harmless, unused). */
  submittedHeader: PurchaseDocumentHeaderDraft;
  submittedLines: PurchaseDocumentLine[];
  vendorName: string | null;
  declaredVendorName: string | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedVendorName: string | null;
  aiSuggestedDocumentType: string | null;
  aiWarnings: string[];
  aiReviewFlags: ReviewFlag[];
  aiModel: string | null;
  hasNewerExtraction: boolean;
  lastReturnedReason: string | null;
  lastReturnedAt: string | null;
  vendors: VendorSummary[];
  initialDuplicates: PossibleDuplicatePurchaseDocument[];
}

// Duplicate matches can, in principle, be any active status (DISCARDED
// duplicates are excluded server-side, but the type is the full
// PurchaseDocumentStatus, unlike this component's own narrower status).
const DUPLICATE_STATUS_LABEL: Record<PurchaseDocumentStatus, string> = {
  ...STATUS_LABEL,
  VERIFIED: "Verified",
  DISCARDED: "Discarded",
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

export function PurchaseDocumentReviewView(props: Props) {
  const router = useRouter();
  const [header, setHeader] = useState<PurchaseDocumentHeaderDraft>({ ...props.header });
  const [lines, setLines] = useState<PurchaseDocumentLine[]>(props.lines);
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
  const [showDiscardForm, setShowDiscardForm] = useState(false);
  const [discardReason, setDiscardReason] = useState("");
  const [discardPending, setDiscardPending] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [showWithdrawForm, setShowWithdrawForm] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawPending, setWithdrawPending] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

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

  const editableAsPreparer = props.isPreparer && props.status === "DRAFT";
  const editableAsReviewer = !props.isPreparer && props.status === "READY_FOR_VERIFICATION";
  const editable = editableAsPreparer || editableAsReviewer;

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

  const liveDiff = useMemo(
    () => computePurchaseDocumentDiff(props.submittedHeader, props.submittedLines, header, lines),
    [props.submittedHeader, props.submittedLines, header, lines]
  );
  const liveCorrectionCount = useMemo(() => purchaseDocumentDiffCount(liveDiff), [liveDiff]);
  const changedHeaderFields = useMemo(() => new Set(liveDiff.headerChanges.map((c) => c.field)), [liveDiff]);

  function submittedValueFor(field: keyof PurchaseDocumentHeaderDraft): string | null {
    const value = props.submittedHeader[field];
    if (value === null || value === undefined || value === "") return null;
    return String(value);
  }

  function updateHeader<K extends keyof PurchaseDocumentHeaderDraft>(key: K, value: PurchaseDocumentHeaderDraft[K]) {
    setHeader((prev) => ({ ...prev, [key]: value }));
    setSavedMessage(null);
  }

  function updateLine(index: number, patch: Partial<PurchaseDocumentLine>) {
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
    const result = editableAsReviewer
      ? await saveReviewCorrections({ purchaseDocumentId: props.purchaseDocumentId, expectedVersion: version, header, lines })
      : await savePurchaseDocumentDraft({ purchaseDocumentId: props.purchaseDocumentId, expectedVersion: version, header, lines });
    setSavePending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    setVersion(result.version);
    setSavedMessage("Saved.");
  }

  async function handleSubmit() {
    setActionPending(true);
    setActionError(null);
    // Sends the exact current on-screen header/lines -- the RPC persists
    // them atomically with the DRAFT -> READY_FOR_VERIFICATION transition,
    // so a prior Save Draft click is never required.
    const result = await submitPurchaseDocumentForVerification(props.purchaseDocumentId, version, header, lines);
    setActionPending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    setVersion(result.version);
    router.refresh();
  }

  async function handleVerify() {
    setActionPending(true);
    setActionError(null);
    // Sends the exact current on-screen reviewer state -- the RPC persists
    // any unsaved edits atomically with the READY -> VERIFIED transition,
    // so a prior Save Corrections click is never required.
    const result = await verifyPurchaseDocument(props.purchaseDocumentId, version, header, lines);
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

  async function handleDiscard() {
    if (props.revisionNumber > 1 && !discardReason.trim()) {
      setDiscardError("A reason is required to discard an amendment.");
      return;
    }
    if (!window.confirm(props.revisionNumber > 1 ? "Discard this amendment? This cannot be undone." : "Discard this draft? This cannot be undone.")) {
      return;
    }
    setDiscardPending(true);
    setDiscardError(null);
    const result = await discardPurchaseDocumentDraft(props.purchaseDocumentId, version, discardReason.trim() || undefined);
    setDiscardPending(false);
    if (!result.ok) {
      setDiscardError(result.message);
      return;
    }
    router.push("/manager/receiving");
    router.refresh();
  }

  async function handleWithdraw() {
    if (!window.confirm("Withdraw this submission back to Draft?")) {
      return;
    }
    setWithdrawPending(true);
    setWithdrawError(null);
    const result = await withdrawPurchaseDocumentSubmission(props.purchaseDocumentId, version, withdrawReason.trim() || undefined);
    setWithdrawPending(false);
    if (!result.ok) {
      setWithdrawError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/manager/receiving" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
        ← Receiving Queue
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{props.originalFilename}</h1>
          <p className="mt-1 text-sm text-zinc-500">{STATUS_LABEL[props.status]}</p>
        </div>
      </div>

      {!props.isPreparer && props.status === "DRAFT" ? (
        <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          Only the preparer who created this draft can edit it. You can review it once submitted.
        </p>
      ) : null}
      {props.isPreparer && props.status === "READY_FOR_VERIFICATION" ? (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          <p>
            Submitted for verification. Another manager must review or verify this document -- you cannot review your
            own submission.
          </p>
          {!showWithdrawForm ? (
            <button type="button" onClick={() => setShowWithdrawForm(true)} className="mt-2 text-xs text-amber-400 underline">
              Withdraw Submission
            </button>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <input
                type="text"
                value={withdrawReason}
                onChange={(event) => setWithdrawReason(event.target.value)}
                placeholder="Reason (optional)"
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleWithdraw}
                  disabled={withdrawPending}
                  className="rounded-full border border-amber-700 px-4 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-40"
                >
                  {withdrawPending ? "Withdrawing…" : "Confirm Withdraw"}
                </button>
                <button type="button" onClick={() => setShowWithdrawForm(false)} className="text-xs text-zinc-400 underline">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {withdrawError ? <p className="mt-2 text-xs text-red-400">{withdrawError}</p> : null}
        </div>
      ) : null}
      {editableAsReviewer ? (
        <p className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          You are reviewing another manager&apos;s submission. Fields you change are marked below -- Verify to accept
          them as final, or Return to Preparer if you&apos;d rather they resolve it.
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
                changed={editableAsReviewer && changedHeaderFields.has("vendorId")}
                submitted={editableAsReviewer ? props.vendors.find((v) => v.id === props.submittedHeader.vendorId)?.name ?? null : null}
                onChange={(v) => updateHeader("vendorId", v || null)}
                options={[{ value: "", label: "Select vendor…" }, ...props.vendors.map((v) => ({ value: v.id, label: v.name }))]}
              />
              <SelectField
                label="Document type"
                value={header.documentType ?? ""}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("documentType")}
                submitted={editableAsReviewer ? props.submittedHeader.documentType : null}
                onChange={(v) => updateHeader("documentType", (v || null) as PurchaseDocumentType | null)}
                options={[{ value: "", label: "Select type…" }, ...DOCUMENT_TYPE_OPTIONS]}
              />
              <TextField
                label={header.documentType ? DOCUMENT_NUMBER_LABEL[header.documentType] : "Document #"}
                value={header.documentNumber}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("documentNumber")}
                submitted={editableAsReviewer ? submittedValueFor("documentNumber") : null}
                onChange={(v) => updateHeader("documentNumber", v)}
              />
              <DateField
                label="Document date"
                value={header.documentDate}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("documentDate")}
                submitted={editableAsReviewer ? submittedValueFor("documentDate") : null}
                onChange={(v) => updateHeader("documentDate", v)}
              />
              <TextField
                label="PO #"
                value={header.poNumber}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("poNumber")}
                submitted={editableAsReviewer ? submittedValueFor("poNumber") : null}
                onChange={(v) => updateHeader("poNumber", v)}
              />
              <DateField
                label="Delivery date"
                value={header.deliveryDate}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("deliveryDate")}
                submitted={editableAsReviewer ? submittedValueFor("deliveryDate") : null}
                onChange={(v) => updateHeader("deliveryDate", v)}
              />
              <NumberField
                label="Subtotal"
                value={header.subtotal}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("subtotal")}
                submitted={editableAsReviewer ? submittedValueFor("subtotal") : null}
                onChange={(v) => updateHeader("subtotal", v)}
              />
              <NumberField
                label="Tax"
                value={header.tax}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("tax")}
                submitted={editableAsReviewer ? submittedValueFor("tax") : null}
                onChange={(v) => updateHeader("tax", v)}
              />
              <NumberField
                label="Fees"
                value={header.fees}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("fees")}
                submitted={editableAsReviewer ? submittedValueFor("fees") : null}
                onChange={(v) => updateHeader("fees", v)}
              />
              <NumberField
                label="Total"
                value={header.total}
                disabled={!editable}
                changed={editableAsReviewer && changedHeaderFields.has("total")}
                submitted={editableAsReviewer ? submittedValueFor("total") : null}
                onChange={(v) => updateHeader("total", v)}
              />
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
              {lines.map((line, index) => {
                const lineChange = editableAsReviewer ? liveDiff.lineChanges.find((c) => c.lineKey === line.lineKey) : undefined;
                const changedFields = lineChange?.kind === "modified" ? new Set(lineChange.fields.map((f) => f.field)) : new Set<string>();
                const isNewLine = editableAsReviewer && lineChange?.kind === "added";
                return (
                  <div
                    key={line.lineKey ?? index}
                    className={`grid grid-cols-2 gap-2 rounded-lg border p-3 sm:grid-cols-3 ${
                      isNewLine ? "border-emerald-700 bg-emerald-950/20" : "border-zinc-800"
                    }`}
                  >
                    {isNewLine ? <p className="col-span-full text-xs font-semibold text-emerald-400">New line</p> : null}
                    <TextField label="SKU" value={line.vendorSku} disabled={!editable} changed={changedFields.has("vendorSku")} onChange={(v) => updateLine(index, { vendorSku: v })} />
                    <TextField
                      label="Description"
                      value={line.description}
                      disabled={!editable}
                      changed={changedFields.has("description")}
                      onChange={(v) => updateLine(index, { description: v })}
                    />
                    <NumberField
                      label="Pkg Qty"
                      value={line.packageQuantity}
                      disabled={!editable}
                      changed={changedFields.has("packageQuantity")}
                      onChange={(v) => updateLine(index, { packageQuantity: v })}
                    />
                    <TextField
                      label="Pkg Unit"
                      value={line.packageUnit}
                      disabled={!editable}
                      changed={changedFields.has("packageUnit")}
                      onChange={(v) => updateLine(index, { packageUnit: v })}
                    />
                    <NumberField
                      label="Measured Qty"
                      value={line.measuredQuantity}
                      disabled={!editable}
                      changed={changedFields.has("measuredQuantity")}
                      onChange={(v) => updateLine(index, { measuredQuantity: v })}
                    />
                    <TextField
                      label="Measured Unit"
                      value={line.measuredUnit}
                      disabled={!editable}
                      changed={changedFields.has("measuredUnit")}
                      onChange={(v) => updateLine(index, { measuredUnit: v })}
                    />
                    <NumberField
                      label="Unit Price"
                      value={line.unitPrice}
                      disabled={!editable}
                      changed={changedFields.has("unitPrice")}
                      onChange={(v) => updateLine(index, { unitPrice: v })}
                    />
                    <TextField
                      label="Price Basis"
                      value={line.priceBasisUnit}
                      disabled={!editable}
                      changed={changedFields.has("priceBasisUnit")}
                      onChange={(v) => updateLine(index, { priceBasisUnit: v })}
                    />
                    <NumberField
                      label="Line Total"
                      value={line.lineTotal}
                      disabled={!editable}
                      changed={changedFields.has("lineTotal")}
                      onChange={(v) => updateLine(index, { lineTotal: v })}
                    />
                    {editable ? (
                      <button type="button" onClick={() => removeLine(index)} className="col-span-full text-left text-xs text-red-400 underline">
                        Remove Line
                      </button>
                    ) : null}
                  </div>
                );
              })}
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

          {editableAsPreparer ? (
            <div className="flex flex-col gap-3">
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

              {!showDiscardForm ? (
                <button type="button" onClick={() => setShowDiscardForm(true)} className="self-start text-xs text-red-400 underline">
                  {props.revisionNumber > 1 ? "Discard Amendment" : "Discard Draft"}
                </button>
              ) : (
                <div className="flex flex-col gap-2 rounded-lg border border-red-900 bg-red-950/20 p-3">
                  <input
                    type="text"
                    value={discardReason}
                    onChange={(event) => setDiscardReason(event.target.value)}
                    placeholder={props.revisionNumber > 1 ? "Reason (required)" : "Reason (optional)"}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                  />
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleDiscard}
                      disabled={discardPending}
                      className="rounded-full border border-red-700 px-4 py-1.5 text-xs font-semibold text-red-300 disabled:opacity-40"
                    >
                      {discardPending ? "Discarding…" : props.revisionNumber > 1 ? "Confirm Discard Amendment" : "Confirm Discard Draft"}
                    </button>
                    <button type="button" onClick={() => setShowDiscardForm(false)} className="text-xs text-zinc-400 underline">
                      Cancel
                    </button>
                  </div>
                  {discardError ? <p className="text-xs text-red-400">{discardError}</p> : null}
                </div>
              )}
            </div>
          ) : null}

          {editableAsReviewer ? (
            <div className="flex flex-col gap-3">
              {liveCorrectionCount > 0 ? (
                <p className="text-xs font-semibold text-amber-400">
                  {liveCorrectionCount} correction{liveCorrectionCount === 1 ? "" : "s"} made
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={savePending}
                  className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
                >
                  {savePending ? "Saving…" : "Save Corrections"}
                </button>
                {savedMessage ? <span className="text-xs text-emerald-400">{savedMessage}</span> : null}
              </div>
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
                  {actionPending ? "…" : "Return to Preparer"}
                </button>
                <button
                  type="button"
                  onClick={handleVerify}
                  disabled={actionPending}
                  className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
                >
                  {actionPending ? "…" : liveCorrectionCount > 0 ? `Verify with ${liveCorrectionCount} Correction${liveCorrectionCount === 1 ? "" : "s"}` : "Verify"}
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

function FieldShell({ label, changed, submitted, children }: { label: string; changed?: boolean; submitted?: string | null; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      <span className="flex items-center gap-1.5">
        {label}
        {changed ? <span className="rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">Changed</span> : null}
      </span>
      {changed && submitted !== null && submitted !== undefined ? <span className="text-[10px] text-zinc-500">Submitted: {submitted}</span> : null}
      {children}
    </label>
  );
}

function TextField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
      <input
        type="text"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </FieldShell>
  );
}

function DateField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
      <input
        type="date"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </FieldShell>
  );
}

function NumberField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
      <input
        type="number"
        step="0.01"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </FieldShell>
  );
}

function SelectField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
  options,
}: {
  label: string;
  value: string;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
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
    </FieldShell>
  );
}
