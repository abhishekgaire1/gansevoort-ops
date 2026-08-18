"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDocumentDownloadUrl } from "@/app/actions/documentAccess";
import { initiatePurchaseDocumentAmendment, getPurchaseDocumentReviewSummary, getReceiptHistoryForPurchaseDocument } from "@/app/actions/purchaseDocuments";
import { ReceivingPanel } from "./ReceivingPanel";
import { getInventoryPostingSummary, inventoryPostingBadgeLabel } from "@/app/lib/purchaseDocuments/getInventoryPostingStatus";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, RevisionSummary } from "@/app/lib/purchaseDocuments/types";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import type { ReceiptHistoryEntry } from "@/app/lib/purchaseDocuments/getReceiptHistory";

/**
 * The VERIFIED page -- a READ-ONLY operational record of what Manager 1
 * prepared and Manager 2 final-verified, never another editable
 * preparation form. Once a document reaches VERIFIED, every normal
 * mutation path (item classification, receiving, invoice-unit
 * confirmation, non-additional receipts) is ALSO rejected server-side
 * (20260811100056) -- this component simply never offers those controls
 * in the first place, matching the backend rather than being the only
 * thing enforcing it. The one legitimate post-VERIFIED action --
 * recording a genuinely new physical delivery -- is a separate, explicit,
 * append-only action, not a permanently-visible editable form.
 *
 * Every section pulls from the same aggregation functions the rest of
 * this app already treats as authoritative -- getPurchaseDocumentReviewSummary
 * (item resolution, receiving, non-inventory, exceptions -- all derived
 * from CURRENT lines and EFFECTIVE receipts), getReceiptHistory (the full
 * receipt timeline), and getInventoryPostingSummary (the actual posting
 * source of truth, never receipt existence or receiving completeness).
 * Nothing here recomputes a business fact independently.
 */

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_MEMO: "Credit Memo",
};

const RECEIVING_BEHAVIOR_LABEL: Record<string, string> = {
  SAME_UNIT: "Same unit",
  FIXED_CONVERSION: "Fixed conversion",
  MEASURE_EACH_DELIVERY: "Measured each delivery",
  COUNT_EACH_DELIVERY: "Counted each delivery",
};

interface Props {
  purchaseDocumentId: string;
  documentId: string;
  originalFilename: string;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  vendorName: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  preparedByName: string | null;
  uploadedByName: string | null;
  /** The physical delivery verifier -- an employee, never an app_user
   * (captured once at upload, correctable afterward). Distinct from
   * verifiedByName, which is the second manager's own final review. A
   * blank value on an already-historical document is shown as-is (—),
   * never invented -- the gate that now requires it only protects FUTURE
   * inventory documents (20260811100056). */
  deliveryVerifiedByName: string | null;
  isOriginalUploader: boolean;
  finalCorrectionCount: number;
  revisionNumber: number;
  amendmentReason: string | null;
  isCurrentVerified: boolean;
  revisions: RevisionSummary[];
}

function money(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  const symbol = currency && currency.length <= 3 ? currency : "$";
  return `${symbol}${value.toFixed(2)}`;
}

function quantityUnit(quantity: number | null, unit: string | null): string {
  if (quantity === null) return "—";
  return unit ? `${quantity} ${unit}` : String(quantity);
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function VerifiedPurchaseDocumentSummary(props: Props) {
  const router = useRouter();
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [viewPending, setViewPending] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [amendPending, setAmendPending] = useState(false);
  const [amendError, setAmendError] = useState<string | null>(null);
  const [showAmendForm, setShowAmendForm] = useState(false);
  const [showItemMappings, setShowItemMappings] = useState(false);
  const [showReceivingDetails, setShowReceivingDetails] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAdditionalDelivery, setShowAdditionalDelivery] = useState(false);

  const [summary, setSummary] = useState<PurchaseDocumentReviewSummary | null>(null);
  const [history, setHistory] = useState<ReceiptHistoryEntry[] | null>(null);

  useEffect(() => {
    if (!props.isCurrentVerified) return;
    let cancelled = false;
    Promise.all([getPurchaseDocumentReviewSummary(props.purchaseDocumentId), getReceiptHistoryForPurchaseDocument(props.purchaseDocumentId)]).then(
      ([summaryResult, historyResult]) => {
        if (cancelled) return;
        if (summaryResult.ok) setSummary(summaryResult.summary);
        if (historyResult.ok) setHistory(historyResult.history);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [props.purchaseDocumentId, props.isCurrentVerified]);

  const typeLabel = props.header.documentType ? (DOCUMENT_TYPE_LABEL[props.header.documentType] ?? props.header.documentType) : "Document";
  const receivingAllComplete = summary ? summary.receivingCompleteCount === summary.receivingTotalCount && summary.receivingTotalCount > 0 : false;
  const posting = summary ? getInventoryPostingSummary(summary.receivingTotalCount) : null;
  const inventoryCount = summary ? summary.items.filter((i) => i.disposition === "INVENTORY").length : null;
  const nonInventoryCount = summary ? summary.items.filter((i) => i.disposition === "NON_INVENTORY").length : null;

  const receivedByLineKey = new Map((summary?.receiving ?? []).map((r) => [r.lineKey, r]));

  async function handleDownload() {
    setDownloadPending(true);
    setDownloadError(null);
    const result = await getDocumentDownloadUrl(props.documentId);
    setDownloadPending(false);
    if (!result.ok) {
      setDownloadError(result.message);
      return;
    }
    window.location.href = result.url;
  }

  async function handleViewOriginal() {
    setViewPending(true);
    const result = await getDocumentDownloadUrl(props.documentId);
    setViewPending(false);
    if (result.ok) {
      window.open(result.url, "_blank", "noopener,noreferrer");
    }
  }

  async function handleInitiateAmendment() {
    if (!amendReason.trim()) {
      setAmendError("A reason is required.");
      return;
    }
    setAmendPending(true);
    setAmendError(null);
    const result = await initiatePurchaseDocumentAmendment(props.purchaseDocumentId, amendReason.trim());
    setAmendPending(false);
    if (!result.ok) {
      setAmendError(result.message);
      return;
    }
    router.push(`/manager/purchases/${result.purchaseDocumentId}`);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/manager/receiving" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
        ← Receiving Queue
      </Link>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        {/* ============ HEADER ============ */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold uppercase tracking-wide text-zinc-100">{props.vendorName ?? props.originalFilename}</h1>
            <p className="mt-1 text-sm text-zinc-400">
              {typeLabel}
              {props.header.documentNumber ? ` #${props.header.documentNumber}` : ""}
              {props.header.documentDate ? ` · ${shortDate(props.header.documentDate)}` : ""}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="rounded-full bg-emerald-400/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-300">
              {!props.isCurrentVerified ? "Verified · Superseded" : inventoryPostingBadgeLabel(posting?.status ?? "NOT_POSTED")}
              {props.isCurrentVerified && props.revisionNumber > 1 ? ` · Rev ${props.revisionNumber}` : ""}
            </span>
            {!props.isCurrentVerified ? <span className="text-xs text-amber-400">A newer revision is current -- see Revision History below.</span> : null}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500">Total</p>
            <p className="text-2xl font-semibold text-zinc-50">{money(props.header.total, props.header.currency)}</p>
          </div>
          <div className="text-right text-xs text-zinc-500">
            {summary ? (
              <p>
                {summary.itemsTotalCount} items · {inventoryCount} inventory · {nonInventoryCount} non-inventory
              </p>
            ) : null}
            {props.isCurrentVerified ? (
              posting?.status === "NOT_POSTED" ? (
                <p className="mt-0.5">Inventory posting: Not posted</p>
              ) : posting?.lastPostedAt ? (
                <p className="mt-0.5">Inventory posted {new Date(posting.lastPostedAt).toLocaleString()}</p>
              ) : null
            ) : null}
          </div>
        </div>

        {/* ============ 1. INVOICE ============ */}
        <Section title="Invoice">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-zinc-500">
                  <th className="pb-2 font-normal">Item</th>
                  <th className="pb-2 font-normal">Qty</th>
                  <th className="pb-2 font-normal">Unit</th>
                  <th className="pb-2 font-normal">Unit Price</th>
                  <th className="pb-2 text-right font-normal">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {props.lines.map((line) => {
                  const receivingLine = line.lineKey ? receivedByLineKey.get(line.lineKey) : undefined;
                  const unit = line.packageUnit ?? receivingLine?.expectedUnit ?? null;
                  return (
                    <tr key={line.lineKey ?? line.description}>
                      <td className="py-2 pr-3">
                        <p className="text-zinc-100">{line.description ?? "—"}</p>
                        <p className="text-xs text-zinc-500">
                          {[line.vendorSku ? `SKU ${line.vendorSku}` : null, line.measuredQuantity && line.measuredUnit ? `${line.measuredQuantity} ${line.measuredUnit}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </td>
                      <td className="py-2 pr-3 text-zinc-300">{line.packageQuantity ?? "—"}</td>
                      <td className="py-2 pr-3 text-zinc-300">{unit ?? "—"}</td>
                      <td className="py-2 pr-3 text-zinc-300">{money(line.unitPrice, props.header.currency)}</td>
                      <td className="py-2 text-right text-zinc-100">{money(line.lineTotal, props.header.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 ml-auto flex max-w-xs flex-col gap-1 text-sm">
            <div className="flex justify-between text-zinc-400">
              <span>Subtotal</span>
              <span>{money(props.header.subtotal, props.header.currency)}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>Tax</span>
              <span>{money(props.header.tax, props.header.currency)}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>Fees</span>
              <span>{money(props.header.fees, props.header.currency)}</span>
            </div>
            <div className="flex justify-between border-t border-zinc-800 pt-1 font-semibold text-zinc-100">
              <span>Total</span>
              <span>{money(props.header.total, props.header.currency)}</span>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" onClick={handleViewOriginal} disabled={viewPending} className="text-xs text-zinc-400 underline disabled:opacity-40">
              View Original Invoice
            </button>
            <button type="button" onClick={handleDownload} disabled={downloadPending} className="text-xs text-zinc-400 underline disabled:opacity-40">
              {downloadPending ? "Preparing…" : "Download"}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <DetailField label="Vendor" value={props.vendorName} />
            <DetailField label="Document type" value={typeLabel} />
            <DetailField label="Document number" value={props.header.documentNumber} />
            <DetailField label="Document date" value={props.header.documentDate} />
            <DetailField label="PO number" value={props.header.poNumber} />
            <DetailField label="Delivery date" value={props.header.deliveryDate} />
          </div>
        </Section>

        {/* ============ 2. WORKFLOW ============ */}
        <Section title="Workflow">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <DetailField label="Uploaded by" value={props.uploadedByName} />
            <DetailField label="Prepared by" value={props.preparedByName} />
            <DetailField label="Delivery verified by" value={props.deliveryVerifiedByName} />
            <DetailField label="Final review verified by" value={props.verifiedByName} />
            <DetailField label="Final review verified at" value={props.verifiedAt ? new Date(props.verifiedAt).toLocaleString() : null} />
          </div>
          {props.amendmentReason ? (
            <p className="mt-3 text-xs text-amber-400">
              Amendment reason (Rev {props.revisionNumber}): {props.amendmentReason}
            </p>
          ) : null}
          {props.finalCorrectionCount > 0 ? (
            <p className="mt-3 text-xs text-amber-400">
              {props.finalCorrectionCount} correction{props.finalCorrectionCount === 1 ? "" : "s"} made during verification.{" "}
              <Link href={`/manager/purchases/${props.purchaseDocumentId}/changes`} className="underline">
                View Changes
              </Link>
            </p>
          ) : null}
        </Section>

        {props.isCurrentVerified ? (
          <>
            {/* ============ 3. ITEMS ============ */}
            <Section title="Items">
              {summary ? (
                <p className="text-sm text-zinc-300">
                  {inventoryCount} Inventory
                  <br />
                  {nonInventoryCount} Non-Inventory
                </p>
              ) : (
                <p className="text-sm text-zinc-500">Loading…</p>
              )}
              <button type="button" onClick={() => setShowItemMappings((v) => !v)} className="mt-2 text-xs text-zinc-400 underline">
                {showItemMappings ? "Hide Item Mappings" : "View Item Mappings"}
              </button>
              {showItemMappings && summary ? (
                <ul className="mt-3 flex flex-col divide-y divide-zinc-800">
                  {summary.items.map((item) => (
                    <li key={item.lineKey} className="flex flex-col gap-0.5 py-2 text-sm">
                      <span className="font-medium text-zinc-100">{item.description ?? item.vendorSku ?? "—"}</span>
                      <p className="text-xs text-zinc-500">
                        {item.vendorSku ? `Vendor SKU ${item.vendorSku}` : "No vendor SKU"}
                        {item.canonicalItemName ? ` → ${item.canonicalItemName}` : ""}
                      </p>
                      {item.disposition === "INVENTORY" ? (
                        <p className="text-xs text-zinc-500">
                          {[item.categoryName, item.baseUnitCode, item.receivingBehavior ? RECEIVING_BEHAVIOR_LABEL[item.receivingBehavior] : null]
                            .filter(Boolean)
                            .join(" · ")}
                          {item.spendCategoryPath ? <span className="block">{item.spendCategoryPath}</span> : null}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>

            {/* ============ 4. RECEIVING ============ */}
            <Section title="Receiving" countLabel={summary ? `${summary.receivingCompleteCount} / ${summary.receivingTotalCount} complete` : undefined}>
              {summary ? (
                receivingAllComplete ? (
                  <ul className="flex flex-col gap-1 text-sm text-emerald-400">
                    <li>✓ All inventory lines received</li>
                    <li>✓ Required measurements complete</li>
                    <li>✓ Locations complete</li>
                    <li>{summary.exceptions.length === 0 ? "✓ No shortages/damage" : `⚠ ${summary.exceptions.length} documented exception${summary.exceptions.length === 1 ? "" : "s"}`}</li>
                  </ul>
                ) : (
                  <p className="text-sm text-amber-300">
                    {summary.receivingCompleteCount} / {summary.receivingTotalCount} lines complete
                  </p>
                )
              ) : (
                <p className="text-sm text-zinc-500">Loading…</p>
              )}

              <button type="button" onClick={() => setShowReceivingDetails((v) => !v)} className="mt-2 text-xs text-zinc-400 underline">
                {showReceivingDetails ? "Hide Receiving Details" : "View Receiving Details"}
              </button>

              {showReceivingDetails && summary ? (
                summary.receiving.length > 0 ? (
                  <ul className="mt-3 flex flex-col divide-y divide-zinc-800">
                    {summary.receiving.map((line) => (
                      <li key={line.lineKey} className="flex flex-col gap-2 py-3 text-sm">
                        <p className="font-medium text-zinc-100">{line.description ?? "—"}</p>
                        <div className="flex flex-wrap gap-x-6 gap-y-2">
                          <DetailField label="Expected" value={quantityUnit(line.expectedQuantity, line.expectedUnit)} />
                          <DetailField label="Received" value={quantityUnit(line.receivedQuantity, line.receivedUnit)} />
                          {line.inventoryQuantity !== null ? <DetailField label="Inventory Quantity" value={quantityUnit(line.inventoryQuantity, line.verifiedUnit)} /> : null}
                          {line.requiresVerifiedMeasurement ? <DetailField label={`Verified ${line.verifiedUnit ?? ""}`} value={quantityUnit(line.verifiedQuantity, line.verifiedUnit)} /> : null}
                          <DetailField label="Location" value={line.locationName} />
                          <DetailField label="Condition" value={line.conditionStatus === "RECEIVED_AS_INVOICED" ? "As invoiced" : (line.conditionStatus?.replace(/_/g, " ") ?? null)} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">No inventory lines.</p>
                )
              ) : null}
            </Section>

            {/* ============ 5. INVENTORY POSTING ============ */}
            <Section title="Inventory Posting">
              {!posting ? (
                <p className="text-sm text-zinc-500">Loading…</p>
              ) : posting.status === "NOT_POSTED" ? (
                <p className="text-sm text-zinc-400">Not posted</p>
              ) : (
                <>
                  <p className={posting.status === "POSTED" ? "text-sm font-semibold text-emerald-400" : "text-sm font-semibold text-amber-300"}>
                    {posting.status === "POSTED" ? "✓ Posted" : "⚠ Partially Posted"}
                  </p>
                  <p className="mt-1 text-sm text-zinc-300">
                    {posting.postedLineCount} / {posting.totalInventoryLines} lines posted
                  </p>
                  {posting.lastPostedAt ? <DetailField label="Posted at" value={new Date(posting.lastPostedAt).toLocaleString()} /> : null}
                  <ul className="mt-3 flex flex-col divide-y divide-zinc-800">
                    {posting.postedLines.map((line) => (
                      <li key={line.lineKey} className="py-2 text-sm">
                        <p className="text-zinc-100">{line.description ?? "—"}</p>
                        <p className="text-xs text-zinc-500">
                          +{line.postedQuantity} {line.postedUnit} · {line.locationName ?? "—"}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Section>

            {/* ============ 6. NON-INVENTORY ============ */}
            {summary && summary.nonInventory.length > 0 ? (
              <Section title="Non-Inventory">
                <ul className="flex flex-col divide-y divide-zinc-800">
                  {summary.nonInventory.map((line) => (
                    <li key={line.lineKey} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                      <div>
                        <p className="font-medium text-zinc-100">{line.description ?? "—"}</p>
                        {line.spendCategoryPath ? <p className="text-xs text-zinc-500">Spend Category: {line.spendCategoryPath}</p> : null}
                      </div>
                      <span className="text-zinc-200">{money(line.lineTotal, props.header.currency)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* ============ 7. EXCEPTIONS ============ */}
            <Section title="Exceptions">
              {summary ? (
                summary.exceptions.length === 0 ? (
                  <p className="text-sm text-emerald-400">✓ None</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm text-amber-200">
                    {summary.exceptions.map((exception, i) => (
                      <li key={i}>• {exception.message}</li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="text-sm text-zinc-500">Loading…</p>
              )}
            </Section>

            {/* ============ 8. RECEIVING HISTORY ============ */}
            <Section title="Receiving History" countLabel={history ? `${history.length} record${history.length === 1 ? "" : "s"}` : undefined}>
              {history === null ? (
                <p className="text-sm text-zinc-500">Loading…</p>
              ) : history.length === 0 ? (
                <p className="text-sm text-zinc-500">No receipts recorded.</p>
              ) : !showHistory ? (
                <>
                  <p className="text-xs text-zinc-500">Latest:</p>
                  <p className="text-sm text-zinc-200">{new Date(history[history.length - 1].occurredAt).toLocaleString()}</p>
                  <p className="text-xs text-zinc-500">
                    {history[history.length - 1].recordedByName ? `Recorded by ${history[history.length - 1].recordedByName}` : "Recorded"} ·{" "}
                    {history[history.length - 1].effective ? "Effective" : "Superseded"}
                  </p>
                  <button type="button" onClick={() => setShowHistory(true)} className="mt-2 text-xs text-zinc-400 underline">
                    View History
                  </button>
                </>
              ) : (
                <>
                  <ul className="flex flex-col gap-2 text-sm">
                    {history.map((receipt, i) => (
                      <li key={receipt.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2">
                        <div>
                          <p className="text-zinc-100">
                            Receipt #{i + 1}
                            {receipt.receiptKind === "CORRECTION" ? " (Correction)" : ""} — {new Date(receipt.occurredAt).toLocaleString()}
                          </p>
                          <p className="text-xs text-zinc-500">
                            {receipt.recordedByName ? `Recorded by ${receipt.recordedByName}` : "Recorded"}
                            {receipt.correctsReceiptId ? " · corrects an earlier receipt" : ""}
                          </p>
                        </div>
                        <span className={receipt.effective ? "text-xs font-semibold text-emerald-400" : "text-xs text-zinc-500"}>
                          {receipt.effective ? "Effective" : "Superseded"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button type="button" onClick={() => setShowHistory(false)} className="mt-2 text-xs text-zinc-500 underline">
                    Hide History
                  </button>
                </>
              )}
            </Section>

            {/* ============ RECORD ADDITIONAL DELIVERY ============ */}
            {/* Never prominently offered when the document is already
                fully received -- an explicit, de-emphasized, append-only
                action for the genuine "more goods arrived later" case,
                never an editable form permanently sitting on this page. */}
            <div className="mt-6">
              {!showAdditionalDelivery ? (
                receivingAllComplete ? (
                  <button type="button" onClick={() => setShowAdditionalDelivery(true)} className="text-xs text-zinc-500 underline">
                    All lines received — Record Additional Delivery anyway
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowAdditionalDelivery(true)}
                    className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs font-semibold text-zinc-200"
                  >
                    Record Additional Delivery
                  </button>
                )
              ) : (
                <div className="rounded-xl border border-amber-800 bg-amber-950/10 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-400">Record Additional Delivery</p>
                  <p className="mb-3 text-xs text-zinc-400">
                    This records a NEW, separate delivery event -- it never edits or replaces the receiving history above.
                  </p>
                  <ReceivingPanel purchaseDocumentId={props.purchaseDocumentId} />
                  <button type="button" onClick={() => setShowAdditionalDelivery(false)} className="mt-2 text-xs text-zinc-500 underline">
                    Close
                  </button>
                </div>
              )}
            </div>
          </>
        ) : null}

        {props.revisions.length > 1 ? (
          <Section title="Revision History">
            <ul className="flex flex-col gap-1 text-sm">
              {props.revisions.map((revision) => (
                <li key={revision.purchaseDocumentId} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between">
                    <Link
                      href={`/manager/purchases/${revision.purchaseDocumentId}`}
                      className={revision.purchaseDocumentId === props.purchaseDocumentId ? "font-semibold text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}
                    >
                      Revision {revision.revisionNumber}
                    </Link>
                    <span
                      className={
                        revision.isCurrentVerified
                          ? "text-xs text-emerald-400"
                          : revision.status === "DISCARDED"
                            ? "text-xs text-red-400"
                            : "text-xs text-zinc-500"
                      }
                    >
                      {revision.isCurrentVerified ? "Current" : revision.status === "VERIFIED" ? "Superseded" : revision.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  {revision.status === "DISCARDED" ? (
                    <p className="pl-1 text-xs text-zinc-500">
                      {revision.discardedByName ? `Discarded by ${revision.discardedByName}` : "Discarded"}
                      {revision.discardedAt ? ` on ${new Date(revision.discardedAt).toLocaleString()}` : ""}
                      {revision.discardReason ? ` — ${revision.discardReason}` : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {downloadError ? <p className="mt-4 text-sm text-red-400">{downloadError}</p> : null}
        {amendError ? <p className="mt-4 text-sm text-red-400">{amendError}</p> : null}

        {/* ============ BOTTOM ACTIONS ============ */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleViewOriginal}
            disabled={viewPending}
            className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
          >
            View Original Invoice
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloadPending}
            className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
          >
            {downloadPending ? "Preparing…" : "Download"}
          </button>
          {props.isCurrentVerified ? (
            <button
              type="button"
              onClick={() => setShowAmendForm((v) => !v)}
              className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950"
            >
              Correct Verified Document
            </button>
          ) : null}
        </div>

        {showAmendForm ? (
          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-800 bg-amber-950/30 p-4">
            <p className="text-xs text-amber-200">
              This never edits the verified record in place -- it opens a new revision in DRAFT for Manager 1 to correct, preserving this verified
              revision exactly as-is. The completion gate runs again, and Manager 2 must Final Verify the new revision separately.
            </p>
            <label className="flex flex-col gap-1 text-xs text-amber-200">
              Reason for correction
              <input
                type="text"
                value={amendReason}
                onChange={(event) => setAmendReason(event.target.value)}
                placeholder="e.g. Total transcribed incorrectly"
                className="rounded-lg border border-amber-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
            </label>
            <div>
              <button
                type="button"
                onClick={handleInitiateAmendment}
                disabled={amendPending}
                className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                {amendPending ? "Starting…" : "Start Correction"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, countLabel, children }: { title: string; countLabel?: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
        {countLabel ? <span className="text-xs text-zinc-500">{countLabel}</span> : null}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-sm text-zinc-200">{value ?? "—"}</p>
    </div>
  );
}
