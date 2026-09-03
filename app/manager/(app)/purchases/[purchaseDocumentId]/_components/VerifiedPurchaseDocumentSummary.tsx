"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDocumentDownloadUrl } from "@/app/actions/documentAccess";
import { openPendingTab, resolvePendingTab, closePendingTab } from "@/app/lib/browser/pendingTab";
import {
  initiatePurchaseDocumentAmendment,
  getPurchaseDocumentReviewSummary,
  getReceiptHistoryForPurchaseDocument,
  getPurchaseDocumentPreparationStatus,
} from "@/app/actions/purchaseDocuments";
import { ReceivingPanel } from "./ReceivingPanel";
import { inventoryPostingBadgeLabel } from "@/app/lib/purchaseDocuments/getInventoryPostingStatus";
import { SOLE_APPROVER_REASON_OPTIONS } from "@/app/lib/purchaseDocuments/soleApproverReason";
import { postPurchaseDocumentToInventory, getPurchaseDocumentInventoryPosting } from "@/app/actions/inventory";
import type { InventoryPostingDetail } from "@/app/lib/inventory/getInventoryPostingDetail";
import type { InventoryPostingBlocker } from "@/app/lib/inventory/errors";
import { formatMoney } from "@/app/lib/formatMoney";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, RevisionSummary } from "@/app/lib/purchaseDocuments/types";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import type { ReceiptHistoryEntry } from "@/app/lib/purchaseDocuments/getReceiptHistory";
import { lineLevelBlockers } from "@/app/lib/purchaseDocuments/preparationBlockers";

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
 * receipt timeline), and getPurchaseDocumentInventoryPosting (the actual posting
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
  /** "SOLE_APPROVER" when this revision was verified+posted via Post Now
   * as Sole Approver (20260811100133) -- never "independently reviewed"
   * language for this case. Null for the normal second-review path. */
  verificationMethod: string | null;
  soleApproverReason: string | null;
  soleApproverNotes: string | null;
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
  const [viewError, setViewError] = useState<string | null>(null);
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
  const [posting, setPosting] = useState<InventoryPostingDetail | null>(null);
  const [postPending, setPostPending] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [postBlockers, setPostBlockers] = useState<InventoryPostingBlocker[]>([]);
  // Proactive re-check (fix for a confirmed defect: the manager used to
  // discover a purchase-package mismatch for the first time here, only
  // after every line was already approved through the four-step review).
  // Every affected line SHOULD already have been caught during the
  // four-step review itself -- this only fires when the vendor/SKU's
  // purchase package configuration genuinely changed AFTER this document
  // was verified (the same "unit configuration changed after the delivery
  // was recorded" blocker getPreparationStatus already computes for Step
  // 3/4, reused here rather than re-implemented).
  const [packageMismatchBlockerDescriptions, setPackageMismatchBlockerDescriptions] = useState<string[]>([]);

  useEffect(() => {
    if (!props.isCurrentVerified) return;
    let cancelled = false;
    Promise.all([
      getPurchaseDocumentReviewSummary(props.purchaseDocumentId),
      getReceiptHistoryForPurchaseDocument(props.purchaseDocumentId),
      getPurchaseDocumentInventoryPosting(props.purchaseDocumentId),
      getPurchaseDocumentPreparationStatus(props.purchaseDocumentId),
    ]).then(([summaryResult, historyResult, postingResult, preparationResult]) => {
      if (cancelled) return;
      if (summaryResult.ok) setSummary(summaryResult.summary);
      if (historyResult.ok) setHistory(historyResult.history);
      if (postingResult.ok) setPosting(postingResult.detail);
      if (preparationResult.ok) {
        const mismatchBlockers = lineLevelBlockers(preparationResult.status.blockers).filter((b) => /unit configuration changed/i.test(b.reason));
        setPackageMismatchBlockerDescriptions(mismatchBlockers.map((b) => b.description ?? "Line"));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.purchaseDocumentId, props.isCurrentVerified]);

  const typeLabel = props.header.documentType ? (DOCUMENT_TYPE_LABEL[props.header.documentType] ?? props.header.documentType) : "Document";
  const receivingAllComplete = summary ? summary.receivingCompleteCount === summary.receivingTotalCount && summary.receivingTotalCount > 0 : false;
  const inventoryCount = summary ? summary.items.filter((i) => i.disposition === "INVENTORY").length : null;
  const nonInventoryCount = summary ? summary.items.filter((i) => i.disposition === "NON_INVENTORY").length : null;

  const receivedByLineKey = new Map((summary?.receiving ?? []).map((r) => [r.lineKey, r]));

  // Receiving UX Interaction System pass, Part 32: READY TO POST is not
  // operationally finished -- while this is true, Post to Inventory is the
  // one sticky top-level workflow action, never buried in the Inventory
  // Posting card further down the page. Non-inventory-only documents never
  // reach this (requiredLineCount === 0), matching Part 35.
  const readyToPost = Boolean(props.isCurrentVerified && posting && posting.status !== "POSTED" && posting.requiredLineCount > 0);

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
    // Opened synchronously, before the await below, so Mobile Safari's
    // popup blocker never gets a chance to treat this as a non-gesture-
    // triggered window.open() (see app/lib/browser/pendingTab.ts).
    const pendingTab = openPendingTab();
    setViewPending(true);
    setViewError(null);
    const result = await getDocumentDownloadUrl(props.documentId);
    setViewPending(false);
    if (!result.ok) {
      closePendingTab(pendingTab);
      setViewError(result.message);
      return;
    }
    resolvePendingTab(pendingTab, result.url);
  }

  async function handlePostToInventory() {
    if (postPending) return; // already in flight -- a double-click must never fire twice (the RPC is idempotent regardless)
    setPostPending(true);
    setPostError(null);
    setPostBlockers([]);
    const result = await postPurchaseDocumentToInventory(props.purchaseDocumentId);
    setPostPending(false);
    if (!result.ok) {
      setPostError(result.message);
      if (result.reason === "blocked") setPostBlockers(result.blockers);
      return;
    }
    // Refresh the posting section (and the header badge) from the real
    // posting records -- never assume success shaped the data.
    const refreshed = await getPurchaseDocumentInventoryPosting(props.purchaseDocumentId);
    if (refreshed.ok) setPosting(refreshed.detail);
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
              {!props.isCurrentVerified
                ? "Verified · Superseded"
                : props.verificationMethod === "SOLE_APPROVER"
                  ? "Posted · Single-manager approval"
                  : inventoryPostingBadgeLabel(posting?.status ?? "NOT_POSTED")}
              {props.isCurrentVerified && props.revisionNumber > 1 ? ` · Rev ${props.revisionNumber}` : ""}
            </span>
            {props.isCurrentVerified && props.verificationMethod === "SOLE_APPROVER" ? (
              <span className="text-xs text-amber-400">
                Sole approver: {props.verifiedByName ?? "—"} · {props.verifiedAt ? new Date(props.verifiedAt).toLocaleString() : "—"}
              </span>
            ) : null}
            {!props.isCurrentVerified ? <span className="text-xs text-amber-400">A newer revision is current -- see Revision History below.</span> : null}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500">Total</p>
            <p className="text-2xl font-semibold text-zinc-50">{formatMoney(props.header.total, props.header.currency)}</p>
          </div>
          <div className="text-right text-xs text-zinc-500">
            {summary ? (
              <p>
                {summary.itemsTotalCount} items · {inventoryCount} inventory · {nonInventoryCount} non-inventory
              </p>
            ) : null}
            {props.isCurrentVerified ? (
              posting === null || posting.status === "NOT_POSTED" ? (
                <p className="mt-0.5">Inventory posting: Not posted</p>
              ) : posting.postings.length > 0 ? (
                <p className="mt-0.5">Inventory posted {new Date(posting.postings[posting.postings.length - 1].postedAt).toLocaleString()}</p>
              ) : null
            ) : null}
          </div>
        </div>

        {/* ============ READY TO POST ============ */}
        {/* Receiving UX Interaction System pass, Part 32-33: the ONE
            top-level workflow action while inventory is verified but
            unposted -- never buried in the "Inventory Posting" card
            further down the page. Disappears entirely once posted (Part
            34) or if this document has no inventory lines at all (Part
            35) -- the card below still shows the read-only posting
            record either way. */}
        {readyToPost && packageMismatchBlockerDescriptions.length > 0 ? (
          // The information that changed since this document was verified
          // -- never a surprise re-discovery of a mismatch every line had
          // already cleared during review. "Review line" opens the one
          // legitimate correction path for an already-VERIFIED document
          // (Correct Verified Document -- a new DRAFT revision), never a
          // silent overwrite.
          <div className="mt-4 rounded-xl border border-red-800 bg-red-950/20 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-400">Purchase package needs review</p>
            <p className="mt-1 text-sm text-zinc-300">This item&apos;s purchase-package configuration changed after review. Please return to the affected line.</p>
            <ul className="mt-2 flex flex-col gap-1 text-xs text-zinc-400">
              {packageMismatchBlockerDescriptions.map((description, index) => (
                <li key={index}>• {description}</li>
              ))}
            </ul>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => {
                  setAmendReason("Purchase-package configuration changed after review -- correcting the affected line.");
                  setShowAmendForm(true);
                }}
                className="rounded-full bg-red-400 px-5 py-2 text-sm font-semibold text-zinc-950"
              >
                Review line
              </button>
            </div>
          </div>
        ) : readyToPost ? (
          <div className="mt-4 rounded-xl border border-emerald-800 bg-emerald-950/20 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">Ready to Post</p>
            <p className="mt-1 text-sm text-zinc-300">
              {posting!.requiredLineCount} inventory line{posting!.requiredLineCount === 1 ? "" : "s"} ready to be added to stock
              {nonInventoryCount && nonInventoryCount > 0 ? ` · ${nonInventoryCount} expense line${nonInventoryCount === 1 ? "" : "s"} will not post` : ""}
              .
            </p>
            {postError ? (
              <div className="mt-3 rounded-lg border border-red-900 bg-red-950/20 p-3 text-sm text-red-300">
                <p>{postError}</p>
                {postBlockers.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {postBlockers.map((blocker, index) => (
                      <li key={index}>
                        • {blocker.description ?? "Line"} — {blocker.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="mt-3">
              <button
                type="button"
                onClick={handlePostToInventory}
                disabled={postPending}
                className="rounded-full bg-emerald-400 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                {postPending ? "Posting Inventory…" : "Post to Inventory →"}
              </button>
            </div>
          </div>
        ) : null}

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
                      <td className="py-2 pr-3 text-zinc-300">{formatMoney(line.unitPrice, props.header.currency)}</td>
                      <td className="py-2 text-right text-zinc-100">{formatMoney(line.lineTotal, props.header.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 ml-auto flex max-w-xs flex-col gap-1 text-sm">
            <div className="flex justify-between text-zinc-400">
              <span>Subtotal</span>
              <span>{formatMoney(props.header.subtotal, props.header.currency)}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>Tax</span>
              <span>{formatMoney(props.header.tax, props.header.currency)}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>Fees</span>
              <span>{formatMoney(props.header.fees, props.header.currency)}</span>
            </div>
            <div className="flex justify-between border-t border-zinc-800 pt-1 font-semibold text-zinc-100">
              <span>Total</span>
              <span>{formatMoney(props.header.total, props.header.currency)}</span>
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
          {viewError ? <p className="mt-2 text-xs text-red-400">{viewError}</p> : null}
          {downloadError ? <p className="mt-2 text-xs text-red-400">{downloadError}</p> : null}

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
            {/* Never "Final review verified by/at" for a sole-approver posting --
                that label implies an independent second reviewer, which never
                happened here (Do not label it as independently reviewed). */}
            <DetailField label={props.verificationMethod === "SOLE_APPROVER" ? "Posted by (sole approver)" : "Final review verified by"} value={props.verifiedByName} />
            <DetailField
              label={props.verificationMethod === "SOLE_APPROVER" ? "Posted at" : "Final review verified at"}
              value={props.verifiedAt ? new Date(props.verifiedAt).toLocaleString() : null}
            />
          </div>
          {props.verificationMethod === "SOLE_APPROVER" ? (
            <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Single-manager approval</p>
              <p className="mt-1 text-sm text-amber-100">
                Reason: {SOLE_APPROVER_REASON_OPTIONS.find((o) => o.code === props.soleApproverReason)?.label ?? props.soleApproverReason ?? "—"}
              </p>
              {props.soleApproverNotes ? <p className="mt-1 text-xs text-amber-200">Notes: {props.soleApproverNotes}</p> : null}
              <p className="mt-1 text-xs text-zinc-400">Not independently reviewed by a second manager.</p>
            </div>
          ) : null}
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
              ) : (
                <>
                  {posting.status === "NOT_POSTED" ? (
                    <p className="text-sm text-zinc-400">Not posted</p>
                  ) : (
                    <>
                      <p className={posting.status === "POSTED" ? "text-sm font-semibold text-emerald-400" : "text-sm font-semibold text-amber-300"}>
                        {posting.status === "POSTED" ? "✓ Inventory Posted" : "⚠ Partially Posted"}
                      </p>
                      <p className="mt-1 text-sm text-zinc-300">
                        {posting.postedLineCount} / {posting.requiredLineCount} inventory lines posted
                      </p>
                      {posting.postings.map((record) => (
                        <div key={record.postingId} className="mt-3 rounded-lg border border-zinc-800 p-3">
                          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
                            <span>Posted at {new Date(record.postedAt).toLocaleString()}</span>
                            {record.postedByName ? <span>Posted by {record.postedByName}</span> : null}
                          </div>
                          <ul className="mt-2 flex flex-col divide-y divide-zinc-800">
                            {record.lines.map((line) => (
                              <li key={line.movementId + line.itemName} className="py-2 text-sm">
                                <p className="text-zinc-100">{line.itemName ?? "—"}</p>
                                <p className="text-xs text-zinc-500">
                                  +{line.postedBaseQuantity} {line.baseUnitCode} · {line.locationName ?? "—"}
                                  <span className="ml-2 text-zinc-600">movement {line.movementId.slice(0, 8)}</span>
                                </p>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </>
                  )}

                  {posting.status === "NOT_POSTED" && posting.requiredLineCount === 0 ? (
                    <p className="mt-1 text-xs text-zinc-500">No inventory lines to post on this document.</p>
                  ) : null}
                  {/* Receiving UX Interaction System pass, Part 32: Post to
                      Inventory itself is no longer a button buried in this
                      mid-page card -- it's the sticky top-level workflow
                      action below (see readyToPost). This section stays the
                      read record of what's posted/pending, not the action. */}
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
                      <span className="text-zinc-200">{formatMoney(line.lineTotal, props.header.currency)}</span>
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

        {viewError ? <p className="mt-4 text-sm text-red-400">{viewError}</p> : null}
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
