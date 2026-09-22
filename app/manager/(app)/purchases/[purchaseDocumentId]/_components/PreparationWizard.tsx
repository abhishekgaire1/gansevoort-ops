"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { savePurchaseDocumentDraft, submitPurchaseDocumentForVerification, getPurchaseDocumentPreparationStatus } from "@/app/actions/purchaseDocuments";
import { getPurchaseDocumentLineClassifications, ensureItemMatchingStarted, getClassificationMatchingStatus, type LineClassificationRow } from "@/app/actions/itemClassification";
import { acceptAiAssignedClassifications } from "@/app/actions/lineTreatment";
import { listInventoryItems, listSpendCategories, listUnits, type InventoryItemSummary, type SpendCategorySummary, type UnitSummary } from "@/app/actions/itemMaster";
import { listLocations, type LocationSummary } from "@/app/actions/receiving";
import { evaluateLineReadiness, summarizeLineReadiness, type LineReadiness } from "@/app/lib/purchaseDocuments/lineReadiness";
import { readinessInputFromRow } from "@/app/lib/purchaseDocuments/readinessInputFromRow";
import { Step3Unavailable } from "./Step3Unavailable";
import { reconcileStaleUnitFlags, buildResolvedUnitNotes, type ResolvedUnitNote } from "@/app/lib/purchaseDocuments/lineUnitResolution";
import { reconcileTreatmentFlags, reconcileTotalMismatchFlag } from "@/app/lib/purchaseDocuments/treatmentFlagReconciliation";
import { reconcileTotals } from "@/app/lib/purchaseDocuments/totalsReconciliation";
import { useCompactAskGansevoort } from "@/app/components/manager/askGansevoort/AskGansevoortDensityContext";
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
  useCompactAskGansevoort();
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
  const [step2Progress, setStep2Progress] = useState<{ readyCount: number; totalLines: number; expenseCount: number; needsAttentionCount: number } | null>(null);
  const [preparationStatus, setPreparationStatus] = useState<PreparationStatus | null>(null);
  // Step 1's own stale-unit reconciliation: which lines' classification is
  // genuinely CONFIRMED (Step 2's own authoritative status -- see
  // lineUnitResolution.ts), fetched independently since Step 1 is the
  // default landing step and ItemsAndReceivingPanel hasn't necessarily
  // mounted yet. Null until the first fetch resolves -- treated as "not
  // yet known," never as "resolved," so a fresh page load never
  // optimistically hides a genuine warning for a moment.
  const [resolvedLineKeys, setResolvedLineKeys] = useState<Set<string> | null>(null);
  const [resolvedUnitNotes, setResolvedUnitNotes] = useState<ResolvedUnitNote[]>([]);
  // Line-treatment model: the authoritative classification rows are needed
  // on Step 1 now (AI treatment / confidence / status per line), plus the
  // lookup lists the classification editor needs. Fetched once here and
  // refetched after every classification change.
  const [classificationRows, setClassificationRows] = useState<LineClassificationRow[] | null>(null);
  const [spendCategories, setSpendCategories] = useState<SpendCategorySummary[]>([]);
  const [items, setItems] = useState<InventoryItemSummary[]>([]);
  const [units, setUnits] = useState<UnitSummary[]>([]);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [matchingActive, setMatchingActive] = useState(false);
  const matchingAttempted = useRef(false);
  // ?line=<lineKey> deep link (Step 3's "Review line", Step 1's "Change
  // item match") -- consumed once by the step that mounts.
  const [focusLineKey, setFocusLineKey] = useState<string | null>(() => searchParams.get("line"));

  const setRequestedStep = useCallback(
    (step: WizardStepId, lineKey?: string | null) => {
      setRequestedStepState(step);
      setFocusLineKey(lineKey ?? null);
      router.push(`/manager/purchases/${purchaseDocumentId}?step=${WIZARD_STEP_SLUGS[step]}${lineKey ? `&line=${encodeURIComponent(lineKey)}` : ""}`, { scroll: false });
    },
    [purchaseDocumentId, router]
  );

  const rawDraftFlags = useMemo(() => validatePurchaseDocumentDraft({ ...header, lines }), [header, lines]);
  // Never a second, competing "is this line resolved" calculation -- the
  // exact same CONFIRMED classification status Step 2 already treats as
  // authoritative, just applied here to stop a genuinely-resolved line's
  // stale-unit warning from lingering on Step 1.
  // A credit/discount line is EXPECTED to be negative -- its extraction-time
  // "negative amount" errors are removed once the treatment says so (decided,
  // or AI-proposed and pending), never re-derived here.
  const treatmentByLineKey = useMemo(() => new Map((classificationRows ?? []).map((r) => [r.lineKey, r.lineTreatment] as const)), [classificationRows]);
  const treatmentAwareReconciles = useMemo(
    () =>
      classificationRows === null
        ? null
        : reconcileTotals(
            lines.map((l) => ({ treatment: (l.lineKey && treatmentByLineKey.get(l.lineKey)) || "UNRESOLVED", lineTotal: l.lineTotal })),
            { tax: header.tax, fees: header.fees, total: header.total }
          ).reconciles,
    [classificationRows, lines, treatmentByLineKey, header.tax, header.fees, header.total]
  );
  const draftFlags = useMemo(
    () => reconcileTotalMismatchFlag(reconcileTreatmentFlags(reconcileStaleUnitFlags(rawDraftFlags, lines, resolvedLineKeys ?? new Set()), lines, treatmentByLineKey), treatmentAwareReconciles),
    [rawDraftFlags, lines, resolvedLineKeys, treatmentByLineKey, treatmentAwareReconciles]
  );
  // THE shared per-line readiness (lineReadiness.ts) -- Step 1's gate is
  // "every saved line's classification is settled"; Step 2 adds receiving.
  const readinessByLineKey = useMemo(() => {
    const map = new Map<string, LineReadiness>();
    for (const row of classificationRows ?? []) map.set(row.lineKey, evaluateLineReadiness(readinessInputFromRow(row)));
    return map;
  }, [classificationRows]);
  const readinessSummary = useMemo(() => summarizeLineReadiness(Array.from(readinessByLineKey.values())), [readinessByLineKey]);
  const savedLineKeys = useMemo(() => new Set(lines.map((l) => l.lineKey).filter((k): k is string => Boolean(k))), [lines]);
  const unsettledLineKeys = useMemo(
    () => Array.from(readinessByLineKey.values()).filter((r) => !r.classificationSettled && savedLineKeys.has(r.lineKey)).map((r) => r.lineKey),
    [readinessByLineKey, savedLineKeys]
  );
  const classificationsSettled = classificationRows !== null && unsettledLineKeys.length === 0 && !matchingActive;
  const step1Complete = !draftFlags.some((f) => f.severity === "error") && classificationsSettled;
  const isDirty = useMemo(
    () => purchaseDocumentDiffCount(computePurchaseDocumentDiff(lastSavedHeader, lastSavedLines, header, lines)) > 0,
    [lastSavedHeader, lastSavedLines, header, lines]
  );

  const refetchLineClassifications = useCallback(async () => {
    const result = await getPurchaseDocumentLineClassifications(purchaseDocumentId);
    if (!result.ok) return;
    setClassificationRows(result.lines);
    setResolvedLineKeys(new Set(result.lines.filter((l) => l.status === "CONFIRMED").map((l) => l.lineKey)));
    setResolvedUnitNotes(buildResolvedUnitNotes(rawDraftFlags, lines, result.lines));
  }, [purchaseDocumentId, rawDraftFlags, lines]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listSpendCategories(), listInventoryItems(), listUnits(), listLocations()]).then(([spend, itemsResult, unitsResult, locationsResult]) => {
      if (cancelled) return;
      if (spend.ok) setSpendCategories(spend.categories);
      if (itemsResult.ok) setItems(itemsResult.items);
      if (unitsResult.ok) setUnits(unitsResult.units);
      if (locationsResult.ok) setLocations(locationsResult.locations);
    });
    return () => {
      cancelled = true;
    };
  }, []);


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
    await refetchLineClassifications();
  }, [purchaseDocumentId, refetchLineClassifications]);

  // Classification runs on Step 1 too (it used to start only on Step 2):
  // kick off item matching for any unclassified/stale line once, poll the
  // run, and refetch rows as soon as it finishes so the AI treatments
  // appear on Review Invoice.
  useEffect(() => {
    if (!editable || classificationRows === null) return;
    const needsRun = classificationRows.some((r) => r.status === "UNCLASSIFIED" || r.status === "STALE");
    if (!needsRun) {
      matchingAttempted.current = false;
      return;
    }
    if (matchingAttempted.current) return;
    matchingAttempted.current = true;
    let cancelled = false;
    (async () => {
      setMatchingActive(true);
      await ensureItemMatchingStarted(purchaseDocumentId);
      for (let attempt = 0; attempt < 40 && !cancelled; attempt++) {
        const status = await getClassificationMatchingStatus(purchaseDocumentId);
        if (!status.ok || !status.active) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (cancelled) return;
      setMatchingActive(false);
      await refetchPreparationStatus();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, classificationRows === null, classificationRows?.some((r) => r.status === "UNCLASSIFIED" || r.status === "STALE")]);

  const { steps, activeStep, furthestReachableStep } = deriveWizardProgress({
    step1Complete,
    step2Complete: step2Resolved,
    step2NeedsAttention: (step2Progress?.needsAttentionCount ?? 0) > 0,
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
    if (result.advanced && editable) {
      // The manager's acceptance of every "AI assigned" / "Matched previous
      // decision" proposal still pending -- recorded as their own decision.
      const accepted = await acceptAiAssignedClassifications(purchaseDocumentId);
      if (!accepted.ok) {
        setContinuePending(false);
        setStep1Error(accepted.message);
        return;
      }
      await refetchLineClassifications();
    }
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

  // Language matters here: "reviewed" implies a persisted review event
  // that doesn't exist -- what's actually true is READINESS (every line
  // is either ready for inventory or a classified expense), so the
  // sublabel says exactly that, never a stale/mismatched word.
  const step3Unavailable = requestedStep === 3 && unsettledLineKeys.length > 0;
  // Direct navigation to Review & Post: never flash Step 1 while the
  // classification rows (which decide reachability) are still loading.
  const step3Pending = requestedStep === 3 && classificationRows === null;
  const step2StatusText = step2Progress
    ? step2Progress.needsAttentionCount > 0
      ? `${step2Progress.needsAttentionCount} issue${step2Progress.needsAttentionCount === 1 ? "" : "s"} remaining`
      : step2Progress.readyCount + step2Progress.expenseCount >= step2Progress.totalLines && step2Progress.totalLines > 0
        ? `${step2Progress.totalLines} of ${step2Progress.totalLines} complete`
        : `${step2Progress.readyCount + step2Progress.expenseCount} of ${step2Progress.totalLines} lines complete`
    : undefined;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <Stepper
        steps={steps}
        activeStep={activeStep}
        furthestReachableStep={furthestReachableStep}
        onNavigate={setRequestedStep}
        stepStatusText={{
          ...(step2StatusText ? { 2: step2StatusText } : {}),
          ...(unsettledLineKeys.length > 0 ? { 3: `Unavailable — classify ${unsettledLineKeys.length} invoice line${unsettledLineKeys.length === 1 ? "" : "s"}` } : {}),
        }}
        readyToContinue={{ 1: step1Complete, 2: (step2Progress?.needsAttentionCount ?? 0) === 0 && (step2Progress?.totalLines ?? 0) > 0 }}
      />

      {step3Pending ? (
        <div aria-busy="true" className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-sm text-zinc-300">Loading…</p>
        </div>
      ) : null}

      {step3Unavailable ? (
        <Step3Unavailable
          count={unsettledLineKeys.length}
          onReviewLine={() => setRequestedStep(1, unsettledLineKeys[0] ?? null)}
          onBack={() => setRequestedStep(2)}
        />
      ) : null}

      {activeStep === 1 && !step3Unavailable && !step3Pending ? (
        <Step1ReviewInvoice
          purchaseDocumentId={purchaseDocumentId}
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
          resolvedUnitNotes={resolvedUnitNotes}
          aiWarnings={aiWarnings}
          aiModel={aiModel}
          classificationRows={classificationRows}
          readinessByLineKey={readinessByLineKey}
          matchingActive={matchingActive}
          spendCategories={spendCategories}
          items={items}
          units={units}
          locations={locations}
          onClassificationChanged={refetchPreparationStatus}
          onChangeItemMatch={(lineKey) => setRequestedStep(2, lineKey)}
          isDirty={isDirty}
          focusLineKey={focusLineKey}
          onContinue={handleContinueFromStep1}
          continuePending={continuePending}
          onSave={handleSave}
          savePending={savePending}
          savedMessage={savedMessage}
          stepError={step1Error}
        />
      ) : null}

      {activeStep === 2 && !step3Unavailable && !step3Pending ? (
        <ItemsAndReceivingPanel
          purchaseDocumentId={purchaseDocumentId}
          vendorName={vendorName}
          currency={header.currency}
          readOnly={!editable}
          focusLineKey={focusLineKey}
          onChange={refetchPreparationStatus}
          onAllResolvedChange={setStep2Resolved}
          onProgressChange={setStep2Progress}
          onContinue={editable ? () => setRequestedStep(3) : undefined}
          onNavigateToStep1={editable ? (lineKey?: string) => setRequestedStep(1, lineKey ?? null) : undefined}
        />
      ) : null}

      {activeStep === 3 && !step3Unavailable && !step3Pending ? (
        <Step4ReviewSend
          header={header}
          lines={lines}
          classificationRows={classificationRows}
          readinessSummary={readinessSummary}
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
          onNavigateToStep={(step, lineKey) => setRequestedStep(step, lineKey ?? null)}
          onPreparationStatusChange={refetchPreparationStatus}
          onPostedSoleApprover={onSubmitted}
        />
      ) : null}
    </div>
  );
}
