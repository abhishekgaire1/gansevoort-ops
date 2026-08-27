"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDocumentPageNavigator, DocumentPageNavigatorControls } from "@/app/manager/(app)/_components/DocumentPageNavigator";
import { checkPurchaseDocumentDuplicates, discardPurchaseDocumentDraft, withdrawPurchaseDocumentSubmission } from "@/app/actions/purchaseDocuments";
import { PreparationWizard } from "./PreparationWizard";
import { FinalReviewView } from "./FinalReviewView";
import type { PossibleDuplicatePurchaseDocument } from "@/app/lib/purchaseDocuments/duplicateDetection";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentStatus, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { MappingProposals, ReceivingProposals } from "@/app/lib/purchaseDocuments/reviewProposals";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { VendorSummary } from "@/app/actions/vendors";

type ReviewableStatus = "DRAFT" | "READY_FOR_VERIFICATION";

/** Status Language -- Verification: the SAME canonical READY_FOR_
 * VERIFICATION status reads differently depending on whether the current
 * viewer is the document's own preparer (their work is done, waiting on
 * someone else) or the eligible reviewer (real, actionable work for
 * them) -- never a third database status, purely a presentation split
 * over the one existing enum value, mirroring receivingPresentation.ts's
 * own viewer-relative logic for the Receiving Queue. */
function statusLabelForViewer(status: ReviewableStatus, isPreparer: boolean): string {
  if (status === "DRAFT") return "Draft";
  return isPreparer ? "Sent for Verification" : "Needs Verification";
}

// Used only for a DIFFERENT document referenced in the "possible
// duplicate" list -- the current viewer's relationship to THAT other
// document isn't known here, so this stays deliberately neutral/generic.
const DUPLICATE_STATUS_LABEL: Record<PurchaseDocumentStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_VERIFICATION: "Awaiting Verification",
  VERIFIED: "Verified",
  DISCARDED: "Discarded",
};

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
  status: ReviewableStatus;
  version: number;
  revisionNumber: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  submittedHeader: PurchaseDocumentHeaderDraft;
  submittedLines: PurchaseDocumentLine[];
  vendorName: string | null;
  declaredVendorName: string | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedVendorName: string | null;
  aiSuggestedDocumentType: string | null;
  /** Distinct from header.total -- a vendor-printed account balance/amount
   * due that appears to include prior invoices, when the extraction
   * recognized that pattern. Null on the ordinary invoice where the
   * printed total already is just this document's own total. */
  aiAmountDue: number | null;
  aiWarnings: string[];
  aiReviewFlags: ReviewFlag[];
  aiModel: string | null;
  hasNewerExtraction: boolean;
  lastReturnedReason: string | null;
  lastReturnedAt: string | null;
  vendors: VendorSummary[];
  initialDuplicates: PossibleDuplicatePurchaseDocument[];
  deliveryVerifiedByName: string | null;
  preparerName: string | null;
  preparedAt: string | null;
  /** Manager 2's PERSISTED provisional correction overlay (empty objects
   * when none) -- see reviewProposals.ts. */
  initialMappingProposals: MappingProposals;
  initialReceivingProposals: ReceivingProposals;
  /** The overlay's optimistic-concurrency version (0 = none exists). */
  initialOverlayVersion: number;
}

/**
 * The top-level orchestrator for a DRAFT/READY_FOR_VERIFICATION purchase
 * document. Owns only what's genuinely shared across both experiences it
 * can render (document-lifecycle banners, duplicate detection, discard/
 * withdraw) -- everything about actually preparing or reviewing the
 * document lives in the two purpose-built views below, never both stacked
 * on one long page:
 *   - PreparationWizard: the four-step guided flow (Review Invoice ->
 *     Confirm Items -> Receive Delivery -> Review & Send), for the
 *     preparer while editable, or read-only if they're merely looking back
 *     at their own already-submitted draft.
 *   - FinalReviewView: the second manager's split-pane final-review
 *     experience (original document beside one consolidated review table,
 *     with controlled, audited reviewer corrections) -- never the
 *     preparation wizard.
 */
export function PurchaseDocumentReviewView(props: Props) {
  const router = useRouter();
  const { viewUrl, viewError, contentType: pageContentType, pageNumber, pageCount, goPrev, goNext } = useDocumentPageNavigator(props.documentId, props.contentType);
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

  const editableAsPreparer = props.isPreparer && props.status === "DRAFT";
  const editableAsReviewer = !props.isPreparer && props.status === "READY_FOR_VERIFICATION";
  const showFinalReview = editableAsReviewer;

  useEffect(() => {
    if (!editableAsPreparer) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      checkPurchaseDocumentDuplicates({
        purchaseDocumentId: props.purchaseDocumentId,
        vendorId: props.header.vendorId,
        documentType: props.header.documentType,
        documentNumber: props.header.documentNumber,
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
    // Only the initial header identity matters for this one-shot check on
    // mount -- the wizard's own live edits don't need to keep re-triggering
    // it from up here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableAsPreparer, props.purchaseDocumentId]);

  async function handleDiscard() {
    if (props.revisionNumber > 1 && !discardReason.trim()) {
      setDiscardError("A reason is required to discard an amendment.");
      return;
    }
    // Receiving UX pass, Part 38: the styled confirmation card below IS the
    // confirmation now -- a second native window.confirm() on top of it was
    // redundant double-confirmation, not a safety improvement.
    setDiscardPending(true);
    setDiscardError(null);
    const result = await discardPurchaseDocumentDraft(props.purchaseDocumentId, props.version, discardReason.trim() || undefined);
    setDiscardPending(false);
    if (!result.ok) {
      setDiscardError(result.message);
      return;
    }
    router.push("/manager/receiving");
    router.refresh();
  }

  async function handleWithdraw() {
    // The inline reason form below (revealed by "Withdraw Submission") is
    // itself the confirmation step -- no separate native confirm() needed.
    setWithdrawPending(true);
    setWithdrawError(null);
    const result = await withdrawPurchaseDocumentSubmission(props.purchaseDocumentId, props.version, withdrawReason.trim() || undefined);
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
          {/* Receiving UX pass, Part 9: once real invoice metadata exists,
              the manager orients around vendor/document number/status --
              the filename is still shown, but as secondary source evidence,
              never the primary heading (a filename like
              "Invoices_0-16675_20260816.pdf" tells a manager nothing about
              what they're actually reviewing). Never invents metadata: a
              document with no vendor/number yet (extraction still pending,
              or genuinely blank) falls back to the filename as the title,
              exactly as before. */}
          {props.vendorName || props.header.documentNumber ? (
            <>
              <h1 className="text-xl font-semibold">{props.vendorName ?? "Unknown Vendor"}</h1>
              <p className="mt-0.5 text-sm text-zinc-300">
                {DOCUMENT_NUMBER_LABEL[props.header.documentType ?? "INVOICE"]}
                {props.header.documentNumber ?? "—"}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {statusLabelForViewer(props.status, props.isPreparer)}
                {props.header.documentDate ? ` · ${new Date(props.header.documentDate).toLocaleDateString()}` : ""}
              </p>
              <p className="mt-2 text-xs text-zinc-600">Source file: {props.originalFilename}</p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">{props.originalFilename}</h1>
              <p className="mt-1 text-sm text-zinc-500">{statusLabelForViewer(props.status, props.isPreparer)}</p>
            </>
          )}
        </div>
      </div>

      {!props.isPreparer && props.status === "DRAFT" ? (
        <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          Only the preparer who created this draft can edit it. You can review it once submitted.
        </p>
      ) : null}
      {props.isPreparer && props.status === "READY_FOR_VERIFICATION" ? (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
          <p>Your review is complete. This document is waiting for verification by another manager -- you cannot verify your own submission.</p>
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
      {showFinalReview ? (
        <p className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          You are reviewing another manager&apos;s submission. Fields you change are marked below -- Final Verify to accept
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
                {props.header.documentType ? DOCUMENT_NUMBER_LABEL[props.header.documentType] : "Document #"} {dup.documentNumber}
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

      <DocumentPageNavigatorControls pageNumber={pageNumber} pageCount={pageCount} onPrev={goPrev} onNext={goNext} />

      {showFinalReview ? (
        <FinalReviewView
          purchaseDocumentId={props.purchaseDocumentId}
          version={props.version}
          header={props.header}
          lines={props.lines}
          submittedHeader={props.submittedHeader}
          submittedLines={props.submittedLines}
          viewUrl={viewUrl}
          viewError={viewError}
          contentType={pageContentType}
          vendors={props.vendors}
          vendorName={props.vendorName}
          declaredVendorName={props.declaredVendorName}
          aiSuggestedVendorName={props.aiSuggestedVendorName}
          declaredDocumentType={props.declaredDocumentType}
          aiSuggestedDocumentType={props.aiSuggestedDocumentType}
          deliveryVerifiedByName={props.deliveryVerifiedByName}
          preparerName={props.preparerName}
          initialMappingProposals={props.initialMappingProposals}
          initialReceivingProposals={props.initialReceivingProposals}
          initialOverlayVersion={props.initialOverlayVersion}
          onReturned={() => router.refresh()}
          onVerified={() => router.refresh()}
        />
      ) : (
        <PreparationWizard
          purchaseDocumentId={props.purchaseDocumentId}
          documentId={props.documentId}
          documentStatus={props.status}
          editable={editableAsPreparer}
          version={props.version}
          header={props.header}
          lines={props.lines}
          viewUrl={viewUrl}
          viewError={viewError}
          contentType={pageContentType}
          vendorName={props.vendorName}
          declaredVendorName={props.declaredVendorName}
          aiSuggestedVendorName={props.aiSuggestedVendorName}
          declaredDocumentType={props.declaredDocumentType}
          aiSuggestedDocumentType={props.aiSuggestedDocumentType}
          aiAmountDue={props.aiAmountDue}
          aiWarnings={props.aiWarnings}
          aiModel={props.aiModel}
          vendors={props.vendors}
          deliveryVerifiedByName={props.deliveryVerifiedByName}
          preparerName={props.preparerName}
          preparedAt={props.preparedAt}
          onSubmitted={() => router.refresh()}
        />
      )}

      {editableAsPreparer ? (
        <div className="mt-6 flex flex-col gap-3">
          {/* Receiving UX pass, Part 38: visually secondary (small, muted,
              never competing with Continue), but a real, styled
              confirmation dialog opens on click -- not a loose destructive
              link with no confirmation UI. */}
          <button type="button" onClick={() => setShowDiscardForm(true)} className="self-start text-xs text-zinc-500 underline underline-offset-2 hover:text-red-400">
            {props.revisionNumber > 1 ? "Discard Amendment" : "Discard Draft"}
          </button>
        </div>
      ) : null}

      {showDiscardForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="discard-draft-title" className="w-full max-w-md rounded-2xl border border-red-900 bg-zinc-900 p-5">
            <h2 id="discard-draft-title" className="text-sm font-semibold text-zinc-100">
              {props.revisionNumber > 1 ? "Discard this amendment?" : "Discard this draft?"}
            </h2>
            <p className="mt-2 text-sm text-zinc-400">
              The current invoice review and any unresolved changes will be removed. This cannot be undone.
            </p>
            <label className="mt-3 flex flex-col gap-1 text-xs text-zinc-400">
              {props.revisionNumber > 1 ? "Reason (required)" : "Reason (optional)"}
              <input
                type="text"
                value={discardReason}
                onChange={(event) => setDiscardReason(event.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
            </label>
            {discardError ? <p className="mt-2 text-sm text-red-400">{discardError}</p> : null}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                disabled={discardPending}
                onClick={() => {
                  setShowDiscardForm(false);
                  setDiscardError(null);
                }}
                className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs font-semibold text-zinc-300 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDiscard}
                disabled={discardPending}
                className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                {discardPending ? "Discarding…" : props.revisionNumber > 1 ? "Discard Amendment" : "Discard Draft"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
