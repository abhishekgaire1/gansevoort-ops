"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { savePurchaseDocumentDraft, submitPurchaseDocumentForVerification, getPurchaseDocumentPreparationStatus } from "@/app/actions/purchaseDocuments";
import { Stepper } from "./Stepper";
import { Step1ReviewInvoice, emptyStep1Line } from "./Step1ReviewInvoice";
import { ItemsAndReceivingPanel } from "./ItemsAndReceivingPanel";
import { Step4ReviewSend } from "./Step4ReviewSend";
import { deriveWizardProgress, type WizardStepId } from "@/app/lib/purchaseDocuments/deriveWizardProgress";
import { lineLevelBlockers } from "@/app/lib/purchaseDocuments/preparationBlockers";
import { WIZARD_STEP_SLUGS, wizardStepFromSlug } from "@/app/lib/purchaseDocuments/wizardStepSlug";
import { continueFromStep1 } from "@/app/lib/purchaseDocuments/continueFromStep1";
import type { PreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import { validatePurchaseDocumentDraft } from "@/app/lib/purchaseDocuments/validatePurchaseDocumentDraft";
import { computePurchaseDocumentDiff, purchaseDocumentDiffCount } from "@/app/lib/purchaseDocuments/diff";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { VendorSummary } from "@/app/actions/vendors";

/**
 * The three-step manager preparation workflow (this replaces the previous
 * single long page that stacked PDF review, item mapping, receiving, and
 * blockers all at once -- and, in a later redesign, the previous 4-step
 * wizard's separate Confirm Items / Confirm Receiving steps, now combined
 * into one "Confirm Items & Receiving" step so a manager reviews what the
 * invoice says, which item it matches, and what was received together,
 * not across two screens). One primary task dominates the screen at a
 * time; the Stepper stays visible so the manager always knows where they
 * are, what's done, and what remains.
 *
 * Every step's completion is DERIVED from the same backend data the rest
 * of this codebase already treats as authoritative -- no second,
 * independently-persisted workflow-state system:
 *   - Step 1: validatePurchaseDocumentDraft's error-severity flags.
 *   - Step 2: every current line is ready for inventory, a correctly
 *     classified expense, or explicitly rejected/damaged
 *     (ItemsAndReceivingPanel's own onAllResolvedChange, backed by
 *     combinedLineReadiness.ts).
 *   - Step 3: the existing first-manager completion gate's own preview
 *     (getPreparationStatus, backed by the same RPC-enforced rule
 *     submit_purchase_document_for_verification already uses
 *     authoritatively).
 * Refreshing the page re-derives the same progress -- there is nothing to
 * lose, and navigating backward is always safe.
 */
export function PreparationWizard({
  purchaseDocumentId,
  documentId,
  documentStatus,
  editable,
  version: initialVersion,
  header: initialHeader,
  lines: initialLines,
  viewUrl,
  viewError,
  contentType,
  vendorName,
  declaredVendorName,
  aiSuggestedVendorName,
  declaredDocumentType,
  aiSuggestedDocumentType,
  aiAmountDue,
  aiWarnings,
  aiModel,
  vendors,
  deliveryVerifiedByName,
  preparerName,
  preparedAt,
  onSubmitted,
}: {
  purchaseDocumentId: string;
  documentId: string;
  /** The document's lifecycle status -- Step 4 derives its primary action
   * from this (Send only while DRAFT; an inert "Sent" state once
   * READY_FOR_VERIFICATION), so an already-submitted document never
   * renders an actionable Send button again. */
  documentStatus: "DRAFT" | "READY_FOR_VERIFICATION";
  editable: boolean;
  version: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  viewUrl: string | null;
  viewError: string | null;
  contentType: string;
  vendorName: string | null;
  declaredVendorName: string | null;
  aiSuggestedVendorName: string | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedDocumentType: string | null;
  aiAmountDue: number | null;
  aiWarnings: string[];
  aiModel: string | null;
  vendors: VendorSummary[];
  deliveryVerifiedByName: string | null;
  preparerName: string | null;
  preparedAt: string | null;
  onSubmitted: () => void;
}) {
  const [header, setHeader] = useState<PurchaseDocumentHeaderDraft>(initialHeader);
  const [lines, setLines] = useState<PurchaseDocumentLine[]>(initialLines);
  // What's actually persisted as of the last successful save -- compared
  // against the current on-screen header/lines to decide whether Continue
  // to Items needs to save at all ("If everything is already saved:
  // Continue to Items -> Step 2 immediately," never a redundant round trip
  // or a forced second Save Draft click first).
  const [lastSavedHeader, setLastSavedHeader] = useState<PurchaseDocumentHeaderDraft>(initialHeader);
  const [lastSavedLines, setLastSavedLines] = useState<PurchaseDocumentLine[]>(initialLines);
  const [version, setVersion] = useState(initialVersion);
  const [savePending, setSavePending] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [continuePending, setContinuePending] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  // Seeded from ?step= on first render so a refresh or a Back/Forward
  // navigation lands back where the manager actually was -- purely a
  // navigation hint, never trusted on its own: deriveWizardProgress below
  // still clamps it to the furthest step actually reachable from real
  // backend state, so a stale/tampered query param can never skip ahead
  // of genuinely incomplete work.
  const [requestedStep, setRequestedStepState] = useState<WizardStepId | null>(() => wizardStepFromSlug(searchParams.get("step")));
  const [step2Resolved, setStep2Resolved] = useState<boolean | null>(null);
  // The Stepper's own "7 of 9 reviewed" status text -- reported by
  // ItemsAndReceivingPanel itself (the authoritative source, same
  // combinedLineReadiness.ts summary the panel's own footer uses), never
  // recomputed separately here. Null until the panel has loaded once.
  const [step2Progress, setStep2Progress] = useState<{ readyCount: number; totalLines: number; expenseCount: number } | null>(null);
  const [preparationStatus, setPreparationStatus] = useState<PreparationStatus | null>(null);

  const setRequestedStep = useCallback(
    (step: WizardStepId) => {
      setRequestedStepState(step);
      router.push(`/manager/purchases/${purchaseDocumentId}?step=${WIZARD_STEP_SLUGS[step]}`, { scroll: false });
    },
    [purchaseDocumentId, router]
  );

  const draftFlags = useMemo(() => validatePurchaseDocumentDraft({ ...header, lines }), [header, lines]);
  const step1Complete = !draftFlags.some((f) => f.severity === "error");
  const isDirty = useMemo(
    () => purchaseDocumentDiffCount(computePurchaseDocumentDiff(lastSavedHeader, lastSavedLines, header, lines)) > 0,
    [lastSavedHeader, lastSavedLines, header, lines]
  );

  const refetchPreparationStatus = useCallback(async () => {
    const result = await getPurchaseDocumentPreparationStatus(purchaseDocumentId);
    if (result.ok) {
      setPreparationStatus(result.status);
      // Eager, approximate combined-step-2 completion (independent of
      // whether Step 2 is actually the active step) so a manager who
      // refreshes the page while on Step 3 resumes there directly, rather
      // than flashing through Step 2 while ItemsAndReceivingPanel's own
      // (authoritative) fetch loads -- getPreparationStatus's own
      // per-line blockers already cover both classification and receiving
      // completeness, the SAME two facts the combined step's own
      // completion depends on, so no separate fetch is duplicated here.
      setStep2Resolved(lineLevelBlockers(result.status.blockers).length === 0);
    }
  }, [purchaseDocumentId]);

  const { steps, activeStep, furthestReachableStep } = deriveWizardProgress({
    step1Complete,
    step2Complete: step2Resolved,
    requestedStep,
  });

  function updateHeader<K extends keyof PurchaseDocumentHeaderDraft>(key: K, value: PurchaseDocumentHeaderDraft[K]) {
    setHeader((prev) => ({ ...prev, [key]: value }));
    setSavedMessage(null);
    setStep1Error(null);
  }

  function updateLine(index: number, patch: Partial<PurchaseDocumentLine>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
    setSavedMessage(null);
    setStep1Error(null);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
    setSavedMessage(null);
    setStep1Error(null);
  }

  function addLine() {
    setLines((prev) => [...prev, emptyStep1Line()]);
    setSavedMessage(null);
    setStep1Error(null);
  }

  async function persistDraft(): Promise<{ ok: true } | { ok: false; message: string }> {
    setSavePending(true);
    setSavedMessage(null);
    setStep1Error(null);
    const result = await savePurchaseDocumentDraft({ purchaseDocumentId, expectedVersion: version, header, lines });
    setSavePending(false);
    if (!result.ok) {
      setStep1Error(result.message);
      return { ok: false, message: result.message };
    }
    setVersion(result.version);
    setLastSavedHeader(header);
    setLastSavedLines(lines);
    setSavedMessage("Saved.");
    return { ok: true };
  }

  async function handleSave() {
    await persistDraft();
  }

  async function handleContinueFromStep1() {
    if (continuePending) return; // already in flight -- ignore a duplicate click rather than starting a second save
    setContinuePending(true);
    setStep1Error(null);
    const result = await continueFromStep1({ step1Complete, editable, isDirty, persistDraft });
    setContinuePending(false);
    if (result.advanced) {
      setRequestedStep(2);
    } else if (result.error) {
      setStep1Error(result.error);
    }
  }

  async function handleSend() {
    if (sendPending) return; // already in flight -- a fast double-click must only ever submit once
    setSendPending(true);
    setSendError(null);
    const result = await submitPurchaseDocumentForVerification(purchaseDocumentId, version, header, lines);
    setSendPending(false);
    if (!result.ok) {
      if (result.reason === "stale") {
        // The genuine stale-tab race: this tab held an outdated view (e.g.
        // another tab already submitted). Say specifically what happened
        // and reload the authoritative state -- the refreshed page then
        // renders the correct lifecycle (e.g. the inert Sent state).
        setSendError("This invoice was already sent for final review, or changed in another tab — reloading the latest state…");
        router.refresh();
        return;
      }
      setSendError(result.message);
      return;
    }
    onSubmitted();
  }

  useEffect(() => {
    // Deliberate fetch-on-mount for the completion-gate preview (which
    // also seeds the eager, approximate step-2 resolution summary --
    // see refetchPreparationStatus above), same pattern already used
    // across this app's section-level panels.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchPreparationStatus();
  }, [refetchPreparationStatus]);

  useEffect(() => {
    // Keeps local step-navigation state in sync with the URL after a
    // browser Back/Forward navigation (our own forward navigations via
    // setRequestedStep already update this state directly, before the
    // matching router.push resolves -- this just re-confirms it, a no-op
    // in that case).
    const slugStep = wizardStepFromSlug(searchParams.get("step"));
    if (slugStep !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRequestedStepState(slugStep);
    }
  }, [searchParams]);

  const step2StatusText = step2Progress
    ? step2Progress.readyCount + step2Progress.expenseCount >= step2Progress.totalLines
      ? "Complete — ready to continue"
      : `${step2Progress.readyCount + step2Progress.expenseCount} of ${step2Progress.totalLines} reviewed`
    : undefined;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <Stepper
        steps={steps}
        activeStep={activeStep}
        furthestReachableStep={furthestReachableStep}
        onNavigate={setRequestedStep}
        stepStatusText={step2StatusText ? { 2: step2StatusText } : undefined}
      />

      {activeStep === 1 ? (
        <Step1ReviewInvoice
          viewUrl={viewUrl}
          viewError={viewError}
          contentType={contentType}
          editable={editable}
          header={header}
          lines={lines}
          onHeaderChange={updateHeader}
          onLineChange={updateLine}
          onAddLine={addLine}
          onRemoveLine={removeLine}
          declaredVendorName={declaredVendorName}
          aiSuggestedVendorName={aiSuggestedVendorName}
          declaredDocumentType={declaredDocumentType}
          aiSuggestedDocumentType={aiSuggestedDocumentType}
          aiAmountDue={aiAmountDue}
          vendors={vendors}
          reviewFlags={draftFlags}
          aiWarnings={aiWarnings}
          aiModel={aiModel}
          onContinue={handleContinueFromStep1}
          continuePending={continuePending}
          onSave={handleSave}
          savePending={savePending}
          savedMessage={savedMessage}
          stepError={step1Error}
        />
      ) : null}

      {activeStep === 2 ? (
        <ItemsAndReceivingPanel
          purchaseDocumentId={purchaseDocumentId}
          vendorName={vendorName}
          readOnly={!editable}
          onChange={refetchPreparationStatus}
          onAllResolvedChange={setStep2Resolved}
          onProgressChange={setStep2Progress}
          onContinue={editable ? () => setRequestedStep(3) : undefined}
          onNavigateToStep1={editable ? () => setRequestedStep(1) : undefined}
        />
      ) : null}

      {activeStep === 3 ? (
        <Step4ReviewSend
          header={header}
          lines={lines}
          documentStatus={documentStatus}
          version={version}
          vendorName={vendorName}
          preparationStatus={preparationStatus}
          deliveryVerifiedByName={deliveryVerifiedByName}
          preparerName={preparerName}
          preparedAt={preparedAt}
          purchaseDocumentId={purchaseDocumentId}
          documentId={documentId}
          editable={editable}
          onSend={handleSend}
          sendPending={sendPending}
          sendError={sendError}
          onNavigateToStep={setRequestedStep}
          onPreparationStatusChange={refetchPreparationStatus}
          onPostedSoleApprover={onSubmitted}
        />
      ) : null}
    </div>
  );
}
