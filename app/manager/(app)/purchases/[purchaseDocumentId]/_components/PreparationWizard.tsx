"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { savePurchaseDocumentDraft, submitPurchaseDocumentForVerification, getPurchaseDocumentPreparationStatus } from "@/app/actions/purchaseDocuments";
import { getPurchaseDocumentLineClassifications } from "@/app/actions/itemClassification";
import { Stepper } from "./Stepper";
import { Step1ReviewInvoice, emptyStep1Line } from "./Step1ReviewInvoice";
import { ItemMappingPanel } from "./ItemMappingPanel";
import { ReceivingPanel } from "./ReceivingPanel";
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
 * The four-step manager preparation workflow (this replaces the previous
 * single long page that stacked PDF review, item mapping, receiving, and
 * blockers all at once). One primary task dominates the screen at a time;
 * the Stepper stays visible so the manager always knows where they are,
 * what's done, and what remains.
 *
 * Every step's completion is DERIVED from the same backend data the rest
 * of this codebase already treats as authoritative -- no second,
 * independently-persisted workflow-state system:
 *   - Step 1: validatePurchaseDocumentDraft's error-severity flags.
 *   - Step 2: every current line's classification is CONFIRMED
 *     (ItemMappingPanel's own onAllResolvedChange).
 *   - Step 3/4: the existing first-manager completion gate's own preview
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
    if (result.ok) setPreparationStatus(result.status);
  }, [purchaseDocumentId]);

  // Fetched eagerly (independent of whether Step 2 is actually the active
  // step) so a manager who refreshes the page while on Step 3/4 resumes
  // there directly, rather than flashing through Step 2 while it loads --
  // ItemMappingPanel fetches this same data again for its own detailed UI
  // once mounted, the same established "each section fetches what it
  // needs" pattern already used throughout this app.
  const refetchStep2Resolved = useCallback(async () => {
    const result = await getPurchaseDocumentLineClassifications(purchaseDocumentId);
    if (result.ok) setStep2Resolved(result.lines.length > 0 && result.lines.every((l) => l.status === "CONFIRMED"));
  }, [purchaseDocumentId]);

  // Step 3 completes on LINE-LEVEL receiving completeness only.
  // Document-level requirements (delivery verifier, plausible date) are
  // Step 4's job -- their controls live there, and the authoritative
  // submit RPC still enforces the full gate regardless. Gating Step 3's
  // Continue on the full `ready` deadlocked the wizard: Step 4 was
  // unreachable until a delivery verifier was set, and the verifier can
  // only be set on Step 4.
  const receivingComplete = preparationStatus ? preparationStatus.receivingComplete : null;
  const receivingBlockers = preparationStatus ? lineLevelBlockers(preparationStatus.blockers) : [];

  const { steps, activeStep, furthestReachableStep } = deriveWizardProgress({
    step1Complete,
    step2Complete: step2Resolved,
    step3Complete: receivingComplete,
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
    // Deliberate fetch-on-mount for the completion-gate preview and the
    // step-2 resolution summary, same pattern already used across this
    // app's section-level panels.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchPreparationStatus();
    refetchStep2Resolved();
  }, [refetchPreparationStatus, refetchStep2Resolved]);

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

  return (
    <div className="mt-4 flex flex-col gap-4">
      <Stepper steps={steps} activeStep={activeStep} furthestReachableStep={furthestReachableStep} onNavigate={setRequestedStep} />

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
        <ItemMappingPanel
          purchaseDocumentId={purchaseDocumentId}
          vendorName={vendorName}
          readOnly={!editable}
          onChange={refetchPreparationStatus}
          onAllResolvedChange={setStep2Resolved}
          onContinue={editable ? () => setRequestedStep(3) : undefined}
        />
      ) : null}

      {activeStep === 3 ? (
        <div className="mt-4 flex flex-col gap-4">
          <ReceivingPanel purchaseDocumentId={purchaseDocumentId} readOnly={!editable} collapseWhenReceived onChange={refetchPreparationStatus} />
          {editable && receivingComplete === false && receivingBlockers.length > 0 ? (
            // Never just a disabled button -- the exact line-level reasons,
            // from the SAME source of truth as the gate itself.
            <div className="rounded-2xl border border-amber-800 bg-amber-950/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Cannot continue yet</p>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-amber-200">
                {receivingBlockers.map((blocker, index) => (
                  <li key={index}>
                    • {blocker.description ?? "A line"} — {blocker.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {editable ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setRequestedStep(4)}
                disabled={!receivingComplete}
                title={!receivingComplete ? "Finish receiving every inventory line before continuing." : undefined}
                className="self-start rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                Continue to Review & Send
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeStep === 4 ? (
        <Step4ReviewSend
          header={header}
          lines={lines}
          documentStatus={documentStatus}
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
        />
      ) : null}
    </div>
  );
}
