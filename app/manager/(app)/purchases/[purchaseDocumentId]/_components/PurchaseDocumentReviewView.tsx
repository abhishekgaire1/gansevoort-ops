"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDocumentViewUrl } from "@/app/actions/documentAccess";
import { checkPurchaseDocumentDuplicates, discardPurchaseDocumentDraft, withdrawPurchaseDocumentSubmission } from "@/app/actions/purchaseDocuments";
import { PreparationWizard } from "./PreparationWizard";
import { FinalReviewView } from "./FinalReviewView";
import type { PossibleDuplicatePurchaseDocument } from "@/app/lib/purchaseDocuments/duplicateDetection";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentStatus, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { MappingProposals, ReceivingProposals } from "@/app/lib/purchaseDocuments/reviewProposals";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { VendorSummary } from "@/app/actions/vendors";

type ReviewableStatus = "DRAFT" | "READY_FOR_VERIFICATION";

const STATUS_LABEL: Record<ReviewableStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_VERIFICATION: "Ready for Verification",
};

const DUPLICATE_STATUS_LABEL: Record<PurchaseDocumentStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_VERIFICATION: "Ready for Verification",
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
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
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
    if (!window.confirm(props.revisionNumber > 1 ? "Discard this amendment? This cannot be undone." : "Discard this draft? This cannot be undone.")) {
      return;
    }
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
    if (!window.confirm("Withdraw this submission back to Draft?")) {
      return;
    }
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
          contentType={props.contentType}
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
          contentType={props.contentType}
          vendorName={props.vendorName}
          declaredVendorName={props.declaredVendorName}
          aiSuggestedVendorName={props.aiSuggestedVendorName}
          declaredDocumentType={props.declaredDocumentType}
          aiSuggestedDocumentType={props.aiSuggestedDocumentType}
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
    </div>
  );
}
