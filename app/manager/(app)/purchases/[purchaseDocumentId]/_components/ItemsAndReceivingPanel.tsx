"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getPurchaseDocumentLineClassifications,
  runItemMatchingNow,
  ensureItemMatchingStarted,
  getClassificationMatchingStatus,
  approveExistingItemClassification,
  markLineNonInventory,
  bulkConfirmClassifications,
  type LineClassificationRow,
} from "@/app/actions/itemClassification";
import { decideMatchingOutcome } from "@/app/lib/itemMaster/classificationMatchingOutcome";
import type { ClassificationRunStatus } from "@/app/lib/itemMaster/getClassificationRunStatus";
import {
  listInventoryItems,
  listInventoryCategories,
  listSpendCategories,
  listUnits,
  type InventoryItemSummary,
  type CategorySummary,
  type SpendCategorySummary,
  type UnitSummary,
} from "@/app/actions/itemMaster";
import { ExistingItemOverrideForm, type ExistingItemVendorPackageInput } from "@/app/manager/(app)/_components/ItemClassificationForms";
import { NewItemReviewModal, type NewItemReviewCandidate } from "@/app/manager/(app)/_components/NewItemReviewModal";
import { flattenSpendCategoryPaths } from "@/app/lib/itemMaster/spendCategoryPaths";
import { formatSourceQuantity } from "@/app/lib/purchaseDocuments/matchSourcePresentation";
import { WorkflowFooter } from "@/app/components/receiving/WorkflowFooter";
import { scrollToFirstIssue } from "@/app/components/receiving/blockingIssues";
import { getPriceComparisons } from "@/app/actions/priceComparison";
import type { PriceComparisonResult } from "@/app/lib/purchasing/priceComparison";
import { priceChangeTone } from "@/app/lib/purchasing/priceChangePresentation";
import { formatPackageConfirmation } from "@/app/lib/purchaseDocuments/packageUnitMismatch";
import { classifyLineOutcome, summarizeCombinedStep, checklistCompletion, type LineOutcome } from "@/app/lib/purchaseDocuments/combinedLineReadiness";
import {
  isCardExpanded,
  receivingLineIsReady,
  applyLocationToAll,
  applyConditionToAll,
  summarizeBulkLocations,
  missingReceivingReason,
} from "@/app/lib/purchaseDocuments/itemsAndReceivingCardState";
import { deriveLineProvenance } from "@/app/lib/purchaseDocuments/lineProvenance";
import { getAmendmentAlreadyPosted } from "@/app/actions/purchaseDocuments";
import {
  recordReceipt,
  listEffectiveReceiptsForPurchaseDocument,
  getReceivingLinesForPurchaseDocument,
  getEffectiveReceivingLinesForPurchaseDocument,
  correctEffectiveReceiving,
  listLocations,
  type LocationSummary,
} from "@/app/actions/receiving";
import type { ReceivingLineEdit } from "@/app/lib/receiving/effectiveReceivingEdit";
import { computeReceivingPrefill, recomputeFixedConversionVerifiedQuantity } from "@/app/lib/receiving/computeReceivingPrefill";
import { mergeReceivingLineState, type ReceivingLineDraft } from "@/app/lib/receiving/mergeReceivingLineState";

/**
 * Redesign: the combined "Confirm Items & Receiving" step -- a visible
 * verification CHECKLIST per invoice line (Item Match / Purchase Package /
 * Receiving), always shown, never hidden behind an accordion. A manager
 * looks at a card for two seconds and sees exactly what's been completed,
 * where it came from (provenance -- never falsely attributed), and what,
 * if anything, still needs attention. Only the raw EDITING controls
 * collapse; the completed verification summary itself never does.
 *
 * Item-matching actions remain per-line, immediate RPC calls (approve/
 * mark-non-inventory/etc, unchanged); receiving fields are a local draft,
 * submitted together as one receipt when the manager continues
 * (recordReceipt, unchanged) -- once a delivery receipt already exists,
 * further edits to that line go through the append-only receiving
 * correction instead (correctEffectiveReceiving, also unchanged), never a
 * second competing delivery event.
 *
 * The combined per-line readiness decision (combinedLineReadiness.ts) is
 * the ONE shared source for the card badge, the checklist's own "complete"
 * marks, the page-level completion panel, and the step's completion gate
 * -- never recomputed separately here.
 */

function lineToCandidate(line: LineClassificationRow, vendorName: string | null, documentNumber: string | null): NewItemReviewCandidate | null {
  if (!line.aiSuggestedIsNewProposal || !line.aiSuggestedInventoryItemId || !line.aiNewItemProposal) return null;
  return {
    key: line.lineKey,
    purchaseDocumentId: "",
    lineKey: line.lineKey,
    pendingItemId: line.aiSuggestedInventoryItemId,
    vendorName,
    documentNumber,
    vendorSku: line.vendorSku,
    description: line.description,
    confidence: line.aiConfidence,
    defaults: {
      name: line.aiSuggestedInventoryItemName ?? line.description ?? "",
      disposition: line.aiNewItemProposal.disposition,
      categoryId: line.aiNewItemProposal.categoryId,
      spendCategoryId: line.aiNewItemProposal.spendCategoryId,
      baseUnitCode: line.aiNewItemProposal.baseUnitCode,
      purchaseUnitCode: line.aiProposedPurchaseUnit?.vendorPurchaseUnitCode ?? null,
      receivingBehavior: line.aiProposedPurchaseUnit?.receivingBehavior ?? null,
      fixedConversionFactor: line.aiProposedPurchaseUnit?.fixedConversionFactor ?? null,
    },
  };
}

function invoiceUnitCandidates(l: ReceivingLineDraft): string[] {
  return Array.from(new Set([l.info.baseUnitCode, l.info.purchaseUnitCode].filter((u): u is string => u !== null)));
}

function needsInvoiceUnitResolution(l: ReceivingLineDraft): boolean {
  return l.receivedUnit.trim() === "" && l.info.invoicePackageQuantity !== null && l.info.receivingBehavior !== null && l.info.receivingBehavior !== "SAME_UNIT";
}

const CONDITION_OPTIONS: { value: ReceivingLineDraft["conditionStatus"]; label: string }[] = [
  { value: "RECEIVED_AS_INVOICED", label: "As invoiced" },
  { value: "SHORT", label: "Short" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRONG_ITEM", label: "Wrong item" },
  { value: "NOT_RECEIVED", label: "Not received" },
  { value: "EXCESS", label: "Excess" },
  { value: "OTHER", label: "Other" },
];

type Filter = "all" | "needs_attention" | "ready" | "expenses";

export function ItemsAndReceivingPanel({
  purchaseDocumentId,
  vendorName,
  readOnly,
  onChange,
  onAllResolvedChange,
  onProgressChange,
  onContinue,
  onNavigateToStep1,
}: {
  purchaseDocumentId: string;
  vendorName?: string | null;
  /** Manager 2's final-review view -- item mapping/receiving is Manager
   * 1's job to have substantially completed already. */
  readOnly?: boolean;
  onChange?: () => void;
  /** Fires whenever the combined step's own completion (every line ready
   * or a correctly classified expense) changes -- the wizard's derived
   * step-2-complete signal. */
  onAllResolvedChange?: (resolved: boolean) => void;
  /** Fires after every load with the authoritative counts -- feeds the
   * Stepper's own "7 of 9 reviewed" status text, never recomputed there. */
  onProgressChange?: (progress: { readyCount: number; totalLines: number; expenseCount: number }) => void;
  onContinue?: () => void;
  /** The "Correct invoice unit" corrective action on a purchase-package
   * mismatch warning -- jumps back to Step 1. */
  onNavigateToStep1?: () => void;
}) {
  const [lines, setLines] = useState<LineClassificationRow[] | null>(null);
  const [items, setItems] = useState<InventoryItemSummary[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [spendCategories, setSpendCategories] = useState<SpendCategorySummary[]>([]);
  const [units, setUnits] = useState<UnitSummary[]>([]);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [receivingLineState, setReceivingLineState] = useState<ReceivingLineDraft[]>([]);
  const [alreadyReceived, setAlreadyReceived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runningMatch, setRunningMatch] = useState(false);
  const [bulkConfirmPending, setBulkConfirmPending] = useState(false);
  const [actionPendingLineKey, setActionPendingLineKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideFormLineKey, setOverrideFormLineKey] = useState<string | null>(null);
  const [packageReviewLineKey, setPackageReviewLineKey] = useState<string | null>(null);
  const [showNewItemModal, setShowNewItemModal] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const [priceComparisons, setPriceComparisons] = useState<Record<string, PriceComparisonResult>>({});
  const [matchingPhase, setMatchingPhase] = useState<"blocking" | "stillActive" | "failed" | "stuck" | null>(null);
  const matchingRunToken = useRef(0);
  const hasAutoAttempted = useRef(false);

  // Manager-toggled overrides against each line's DEFAULT editing-controls
  // visibility (needs_attention starts with editing controls open; ready
  // and expense start closed -- the CHECKLIST summary itself is always
  // visible regardless, only the raw controls collapse). Toggling flips a
  // card relative to its own default.
  const [toggledLineKeys, setToggledLineKeys] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [bulkLocationId, setBulkLocationId] = useState("");
  const [bulkConditionValue, setBulkConditionValue] = useState<ReceivingLineDraft["conditionStatus"]>("RECEIVED_AS_INVOICED");
  const [continuePending, setContinuePending] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [rerunConfirmOpen, setRerunConfirmOpen] = useState(false);
  // Brief "Saved" confirmation after an edit -- cleared automatically, and
  // never blocks the manager from continuing to work on the same card.
  const [savedFlashLineKey, setSavedFlashLineKey] = useState<string | null>(null);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashSaved(lineKey: string) {
    setSavedFlashLineKey(lineKey);
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = setTimeout(() => setSavedFlashLineKey(null), 2500);
  }
  useEffect(() => () => {
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
  }, []);

  // Per-line receiving correction (once a delivery receipt already
  // exists) -- a SEPARATE, append-only path (correctEffectiveReceiving)
  // from the initial batched recordReceipt below, never a second
  // competing delivery event for the same physical goods.
  const [correctingLineKey, setCorrectingLineKey] = useState<string | null>(null);
  const [correctionPending, setCorrectionPending] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState<{
    receiptLineId: string;
    receivedQuantity: string;
    receivedUnit: string;
    verifiedQuantity: string;
    locationId: string;
    conditionStatus: ReceivingLineDraft["conditionStatus"];
  } | null>(null);
  const [editSessionKey, setEditSessionKey] = useState(() => crypto.randomUUID());

  const [alreadyPostedElsewhere, setAlreadyPostedElsewhere] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [linesResult, itemsResult, categoriesResult, spendResult, unitsResult, priceComparisonsResult, receiptsResult, receivingResult, locationsResult, amendmentPostedResult] =
      await Promise.all([
        getPurchaseDocumentLineClassifications(purchaseDocumentId),
        listInventoryItems(),
        listInventoryCategories(),
        listSpendCategories(),
        listUnits(),
        getPriceComparisons(purchaseDocumentId),
        listEffectiveReceiptsForPurchaseDocument(purchaseDocumentId),
        getReceivingLinesForPurchaseDocument(purchaseDocumentId),
        listLocations(),
        getAmendmentAlreadyPosted(purchaseDocumentId),
      ]);

    let combinedResolved = false;
    if (linesResult.ok) setLines(linesResult.lines);
    else setError(linesResult.message);
    if (itemsResult.ok) setItems(itemsResult.items);
    if (categoriesResult.ok) setCategories(categoriesResult.categories);
    if (spendResult.ok) setSpendCategories(spendResult.categories);
    if (unitsResult.ok) setUnits(unitsResult.units);
    if (priceComparisonsResult.ok) setPriceComparisons(priceComparisonsResult.comparisons);
    if (receiptsResult.ok) setAlreadyReceived(receiptsResult.receipts.some((r) => r.receiptKind === "DELIVERY"));
    if (locationsResult.ok) setLocations(locationsResult.locations);
    if (amendmentPostedResult.ok) setAlreadyPostedElsewhere(amendmentPostedResult.alreadyPosted);

    let nextReceivingState: ReceivingLineDraft[] = [];
    if (receivingResult.ok) {
      const soleLocationId = locationsResult.ok && locationsResult.locations.length === 1 ? locationsResult.locations[0].id : "";
      setBulkLocationId((current) => current || soleLocationId);
      const loadedLocations = locationsResult.ok ? locationsResult.locations : [];
      setReceivingLineState((prev) => {
        nextReceivingState = mergeReceivingLineState(receivingResult.lines, loadedLocations, prev);
        return nextReceivingState;
      });
    }

    if (linesResult.ok) {
      const receivingByLineKey = new Map(nextReceivingState.map((l) => [l.lineKey, l]));
      const outcomes = linesResult.lines.map((line) => {
        const receiving = receivingByLineKey.get(line.lineKey);
        const receivingReady = line.disposition === "INVENTORY" && line.status === "CONFIRMED" ? Boolean(receiving && receivingLineIsReady(receiving)) : null;
        return classifyLineOutcome({ status: line.status, disposition: line.disposition, hasPackageMismatch: line.hasPackageMismatch, receivingReady });
      });
      const stepSummary = summarizeCombinedStep(outcomes);
      combinedResolved = stepSummary.allResolved;
      onProgressChange?.({ readyCount: stepSummary.readyCount, totalLines: stepSummary.totalLines, expenseCount: stepSummary.expenseCount });
    }
    onAllResolvedChange?.(combinedResolved);

    setLoading(false);
    onChange?.();
    // onAllResolvedChange/onProgressChange/onChange are stable callbacks
    // from the parent.
  }, [purchaseDocumentId, onChange, onAllResolvedChange, onProgressChange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const refetchCategories = useCallback(async () => {
    const [categoriesResult, spendResult] = await Promise.all([listInventoryCategories(), listSpendCategories()]);
    if (categoriesResult.ok) setCategories(categoriesResult.categories);
    if (spendResult.ok) setSpendCategories(spendResult.categories);
  }, []);

  const pollMatchingStatus = useCallback(
    async (kickOff?: () => Promise<{ ok: boolean; message?: string }>) => {
      const token = ++matchingRunToken.current;
      setMatchingPhase("blocking");
      setError(null);

      if (kickOff) {
        const kickOffResult = await kickOff();
        if (matchingRunToken.current !== token) return;
        if (!kickOffResult.ok) {
          setMatchingPhase("failed");
          if (kickOffResult.message) setError(kickOffResult.message);
          return;
        }
      }

      let lastStatus: ClassificationRunStatus | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (matchingRunToken.current !== token) return;
        const status = await getClassificationMatchingStatus(purchaseDocumentId);
        if (matchingRunToken.current !== token) return;
        lastStatus = status.ok ? { active: status.active, outcome: status.outcome } : null;
        if (!lastStatus || !lastStatus.active) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (matchingRunToken.current !== token) return;

      const outcome = decideMatchingOutcome(lastStatus);
      if (outcome === "resolved") {
        setMatchingPhase(null);
        await load();
        return;
      }
      setMatchingPhase(outcome === "stillActive" ? "stillActive" : outcome === "failed" ? "failed" : "stuck");
    },
    [purchaseDocumentId, load]
  );

  useEffect(() => {
    if (lines === null) return;
    const needsMatching = lines.some((l) => l.status === "UNCLASSIFIED" || l.status === "STALE");
    if (!needsMatching) {
      hasAutoAttempted.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMatchingPhase(null);
      return;
    }
    if (hasAutoAttempted.current) return;
    hasAutoAttempted.current = true;
    pollMatchingStatus(() => ensureItemMatchingStarted(purchaseDocumentId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  async function handleRetryUnresolvedMatching() {
    hasAutoAttempted.current = true;
    await pollMatchingStatus(() => ensureItemMatchingStarted(purchaseDocumentId));
  }

  function handleCheckAgain() {
    pollMatchingStatus();
  }

  const newItemCandidates = (lines ?? [])
    .map((l) => lineToCandidate(l, vendorName ?? null, null))
    .filter((c): c is NewItemReviewCandidate => c !== null)
    .map((c) => ({ ...c, purchaseDocumentId }));

  useEffect(() => {
    if (!readOnly && !autoOpened && newItemCandidates.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowNewItemModal(true);
      setAutoOpened(true);
    }
  }, [newItemCandidates.length, autoOpened, readOnly]);

  async function handleRunMatching() {
    setRerunConfirmOpen(false);
    setMoreActionsOpen(false);
    setRunningMatch(true);
    setError(null);
    const result = await runItemMatchingNow(purchaseDocumentId);
    setRunningMatch(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setAutoOpened(false);
    await load();
  }

  async function handleApproveExisting(lineKey: string, inventoryItemId: string, vendorPackage?: ExistingItemVendorPackageInput | null) {
    if (actionPendingLineKey) return;
    setActionPendingLineKey(lineKey);
    const result = await approveExistingItemClassification({
      purchaseDocumentId,
      lineKey,
      inventoryItemId,
      purchaseUnitCode: vendorPackage?.purchaseUnitCode ?? null,
      receivingBehavior: vendorPackage?.receivingBehavior ?? null,
      fixedConversionFactor: vendorPackage?.fixedConversionFactor ?? null,
    });
    setActionPendingLineKey(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOverrideFormLineKey(null);
    setPackageReviewLineKey(null);
    flashSaved(lineKey);
    await load();
  }

  async function handleMarkNonInventory(line: LineClassificationRow) {
    if (actionPendingLineKey) return;
    setActionPendingLineKey(line.lineKey);
    const name = line.aiSuggestedInventoryItemName ?? line.description ?? "Non-inventory line";
    const result = await markLineNonInventory(purchaseDocumentId, line.lineKey, name, line.aiSuggestedIsNewProposal ? line.aiSuggestedInventoryItemId : null);
    setActionPendingLineKey(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPackageReviewLineKey(null);
    flashSaved(line.lineKey);
    await load();
  }

  const bulkEligible = (lines ?? []).filter(
    (l) => l.classificationId && l.status === "PENDING_REVIEW" && l.resolutionSource === "AI_SUGGESTED" && l.aiSuggestedInventoryItemId && !l.aiSuggestedIsNewProposal
  );

  async function handleConfirmAllMatches() {
    if (bulkEligible.length === 0) return;
    setBulkConfirmPending(true);
    setError(null);
    const result = await bulkConfirmClassifications(bulkEligible.map((l) => l.classificationId!));
    setBulkConfirmPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await load();
  }

  // ============ Receiving draft handlers (batched submit path) ============

  function updateReceivingLine(lineKey: string, patch: Partial<ReceivingLineDraft>) {
    setReceivingLineState((prev) => prev.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)));
  }

  function updateReceivedQuantityOrUnit(lineKey: string, patch: { receivedQuantity?: string; receivedUnit?: string }) {
    setReceivingLineState((prev) =>
      prev.map((l) => {
        if (l.lineKey !== lineKey) return l;
        const next = { ...l, ...patch };
        if (l.info.receivingBehavior !== "FIXED_CONVERSION") return next;
        return { ...next, verifiedQuantity: recomputeFixedConversionVerifiedQuantity(l.info, next.receivedQuantity, next.receivedUnit) };
      })
    );
  }

  function handleInvoiceUnitChoice(lineKey: string, unit: string) {
    setReceivingLineState((prev) =>
      prev.map((l) => {
        if (l.lineKey !== lineKey) return l;
        if (unit === "") return { ...l, invoiceUnitChoice: "", receivedQuantity: "", receivedUnit: "", verifiedQuantity: "" };
        const resolved = computeReceivingPrefill({ ...l.info, invoicePackageUnit: unit, confirmedInvoiceUnitCode: null });
        return { ...l, invoiceUnitChoice: unit, receivedQuantity: resolved.receivedQuantity, receivedUnit: resolved.receivedUnit, verifiedQuantity: resolved.verifiedQuantity };
      })
    );
  }

  function handleApplyLocationToAll() {
    setReceivingLineState((prev) => applyLocationToAll(prev, bulkLocationId));
  }

  function handleApplyConditionToAll() {
    setReceivingLineState((prev) => applyConditionToAll(prev, bulkConditionValue));
  }

  async function submitReceivingIfNeeded(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (alreadyReceived) return { ok: true }; // nothing new to batch-submit -- per-line corrections handle changes after this point
    const includedLines = receivingLineState.filter((l) => l.receivedQuantity.trim() !== "");
    if (includedLines.length === 0) return { ok: true }; // no receiving lines on this document (e.g. all expense)

    for (const l of includedLines) {
      if (l.info.requiresVerifiedMeasurement && l.verifiedQuantity.trim() === "") {
        return { ok: false, message: `"${l.info.description ?? l.lineKey}" requires a verified ${l.info.baseUnitCode ?? "measurement"} -- it varies by delivery and can't be assumed from the invoice.` };
      }
    }

    const result = await recordReceipt({
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      defaultLocationId: bulkLocationId || null,
      notes: null,
      idempotencyKey: editSessionKey,
      lines: includedLines.map((l) => ({
        lineNumberSnapshot: null,
        matchedLineKey: l.lineKey,
        vendorSkuSnapshot: l.info.vendorSku,
        descriptionSnapshot: l.info.description,
        invoicePackageQuantity: l.info.invoicePackageQuantity,
        invoicePackageUnit: l.info.invoicePackageUnit,
        invoiceMeasuredQuantity: null,
        invoiceMeasuredUnit: null,
        actualReceivedPackageQuantity: Number(l.receivedQuantity),
        actualReceivedPackageUnit: l.receivedUnit || null,
        actualVerifiedBaseQuantity: l.verifiedQuantity.trim() !== "" ? Number(l.verifiedQuantity) : null,
        actualVerifiedBaseUnitId: l.verifiedQuantity.trim() !== "" ? l.info.baseUnitId : null,
        locationId: l.locationId || null,
        conditionStatus: l.conditionStatus,
      })),
      rememberLocations: includedLines
        .filter((l) => l.info.inventoryItemId !== null && l.locationId.trim() !== "")
        .map((l) => ({ inventoryItemId: l.info.inventoryItemId as string, locationId: l.locationId })),
      confirmedInvoiceUnits: includedLines
        .filter((l) => l.invoiceUnitChoice !== "")
        .map((l) => ({ lineKey: l.lineKey, unitCode: l.invoiceUnitChoice, rememberForVendor: l.rememberInvoiceUnit })),
    });
    if (!result.ok) return { ok: false, message: result.message };
    setEditSessionKey(crypto.randomUUID());
    return { ok: true };
  }

  // ============ Per-line correction (once a delivery already exists) ============

  async function handleOpenCorrection(lineKey: string) {
    setCorrectionError(null);
    setEditSessionKey(crypto.randomUUID());
    const result = await getEffectiveReceivingLinesForPurchaseDocument(purchaseDocumentId);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const effectiveLine = result.lines.find((l) => l.matchedLineKey === lineKey);
    if (!effectiveLine) return;
    setCorrectionDraft({
      receiptLineId: effectiveLine.receiptLineId,
      receivedQuantity: effectiveLine.receivedQuantity !== null ? String(effectiveLine.receivedQuantity) : "",
      receivedUnit: effectiveLine.receivedUnit ?? "",
      verifiedQuantity: effectiveLine.verifiedBaseQuantity !== null ? String(effectiveLine.verifiedBaseQuantity) : "",
      locationId: effectiveLine.locationId ?? "",
      conditionStatus: effectiveLine.conditionStatus as ReceivingLineDraft["conditionStatus"],
    });
    setCorrectingLineKey(lineKey);
  }

  async function handleSaveCorrection() {
    if (!correctionDraft || correctionPending || !correctingLineKey) return;
    setCorrectionPending(true);
    setCorrectionError(null);
    const edits: ReceivingLineEdit[] = [
      {
        receiptLineId: correctionDraft.receiptLineId,
        receivedQuantity: Number(correctionDraft.receivedQuantity),
        receivedUnit: correctionDraft.receivedUnit || null,
        verifiedBaseQuantity: correctionDraft.verifiedQuantity.trim() !== "" ? Number(correctionDraft.verifiedQuantity) : null,
        locationId: correctionDraft.locationId || null,
        conditionStatus: correctionDraft.conditionStatus,
      },
    ];
    const result = await correctEffectiveReceiving({ purchaseDocumentId, editSessionKey, edits });
    setCorrectionPending(false);
    if (!result.ok) {
      setCorrectionError(result.message);
      return;
    }
    flashSaved(correctingLineKey);
    setCorrectingLineKey(null);
    setCorrectionDraft(null);
    await load();
  }

  // ============ Continue ============

  async function handleContinue() {
    if (continuePending || !onContinue) return;
    setContinuePending(true);
    setError(null);
    const result = await submitReceivingIfNeeded();
    setContinuePending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await load();
    onContinue();
  }

  if (loading || lines === null) {
    return (
      <div aria-busy="true" className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-sm text-zinc-300">Loading…</p>
      </div>
    );
  }

  const matchingBanner =
    matchingPhase === "blocking" ? (
      <div aria-busy="true" className="rounded-2xl border border-amber-800 bg-amber-950/10 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Matching Items</p>
        <p className="mt-1 text-sm text-zinc-200">Checking vendor mappings and matching invoice lines against your item master. This will update automatically.</p>
      </div>
    ) : matchingPhase === "stillActive" || matchingPhase === "failed" || matchingPhase === "stuck" ? (
      <div className="rounded-2xl border border-amber-800 bg-amber-950/10 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
          {matchingPhase === "stillActive" ? "Item Matching Is Taking Longer Than Expected" : "Automatic Matching Unavailable"}
        </p>
        <p className="mt-1 text-sm text-zinc-200">
          {matchingPhase === "stillActive"
            ? "A classification run is still active -- we'll keep checking rather than starting a new one."
            : "Your invoice and extracted lines are safe. You can retry matching or continue reviewing manually below."}
        </p>
        {error ? <p className="mt-1 text-sm text-red-300">{error}</p> : null}
        <button
          type="button"
          onClick={matchingPhase === "stillActive" ? handleCheckAgain : handleRetryUnresolvedMatching}
          className="mt-3 rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950"
        >
          {matchingPhase === "stillActive" ? "Check Again" : "Retry Unresolved Matching"}
        </button>
      </div>
    ) : null;

  const receivingByLineKey = new Map(receivingLineState.map((l) => [l.lineKey, l]));
  const spendCategoryPathById = new Map(flattenSpendCategoryPaths(spendCategories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }))).map((p) => [p.id, p.path]));

  const combinedLines = lines.map((line) => {
    const receiving = receivingByLineKey.get(line.lineKey) ?? null;
    const receivingReady = line.disposition === "INVENTORY" && line.status === "CONFIRMED" ? Boolean(receiving && receivingLineIsReady(receiving)) : null;
    const outcome = classifyLineOutcome({ status: line.status, disposition: line.disposition, hasPackageMismatch: line.hasPackageMismatch, receivingReady });
    return { line, receiving, outcome };
  });

  const summary = summarizeCombinedStep(combinedLines.map((c) => c.outcome));
  const filtered = combinedLines.filter((c) => {
    if (filter === "all") return true;
    if (filter === "needs_attention") return c.outcome === "needs_attention";
    if (filter === "ready") return c.outcome === "ready";
    return c.outcome === "expense";
  });

  function isEditingOpen(lineKey: string, outcome: LineOutcome): boolean {
    return isCardExpanded(outcome, toggledLineKeys.has(lineKey));
  }
  function toggleEditingOpen(lineKey: string) {
    setToggledLineKeys((prev) => {
      const next = new Set(prev);
      if (next.has(lineKey)) next.delete(lineKey);
      else next.add(lineKey);
      return next;
    });
  }

  const bulkLocationSummary = summarizeBulkLocations(receivingLineState.map((l) => l.locationId || null));
  const bulkEligibleForCondition = receivingLineState.filter((l) => l.receivedQuantity.trim() !== "").length;

  return (
    <div className="mx-auto mt-4 flex max-w-4xl flex-col gap-4">
      {matchingBanner}
      {error && !matchingBanner ? <p className="rounded-xl border border-red-800 bg-red-950/20 p-3 text-sm text-red-300">{error}</p> : null}

      {alreadyPostedElsewhere ? (
        <div className="rounded-2xl border-2 border-sky-600 bg-sky-950/40 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-sky-300">Inventory already posted</p>
          <p className="mt-1 text-sm font-medium text-sky-50">Inventory was already posted from the original revision. This amendment will not post it again.</p>
        </div>
      ) : null}

      {/* ============ PAGE-LEVEL COMPLETION PANEL ============ */}
      <CompletionPanel
        summary={summary}
        onGoToFirstIssue={() =>
          scrollToFirstIssue(combinedLines.filter((c) => c.outcome === "needs_attention").map((c) => ({ id: `classification-line-${c.line.lineKey}`, reason: "" })))
        }
      />

      {/* ============ TOOLBAR ============ */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-white">Confirm Items &amp; Receiving</h2>
          {!readOnly ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreActionsOpen((v) => !v)}
                className="rounded-full border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:border-zinc-400"
              >
                More actions ▾
              </button>
              {moreActionsOpen ? (
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
                  <button
                    type="button"
                    onClick={() => setRerunConfirmOpen(true)}
                    disabled={runningMatch}
                    className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    {runningMatch ? "Matching…" : "Re-run Matching"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-zinc-300">Confirm each item match, purchase package, received quantity and destination.</p>

        {rerunConfirmOpen ? (
          <div className="mt-3 rounded-xl border border-amber-700 bg-amber-950/20 p-3">
            <p className="text-sm font-medium text-amber-100">
              Re-running matching may replace existing AI suggestions for lines you haven&apos;t confirmed yet. Already-confirmed lines are never touched.
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={handleRunMatching} className="rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950">
                Re-run matching
              </button>
              <button type="button" onClick={() => setRerunConfirmOpen(false)} className="rounded-full border border-zinc-600 px-4 py-1.5 text-xs text-zinc-200">
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {/* ============ FILTERS -- compact, secondary ============ */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {(["all", "needs_attention", "ready", "expenses"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  filter === f ? "border-amber-500 bg-amber-950/30 text-amber-200" : "border-zinc-700 text-zinc-300 hover:text-zinc-100"
                }`}
              >
                {f === "all"
                  ? `All (${summary.totalLines})`
                  : f === "needs_attention"
                    ? `Needs attention (${summary.needsAttentionCount})`
                    : f === "ready"
                      ? `Ready (${summary.readyCount})`
                      : `Expenses (${summary.expenseCount})`}
              </button>
            ))}
          </div>
          {!readOnly ? (
            <div className="flex flex-wrap gap-2">
              {newItemCandidates.length > 0 ? (
                <button type="button" onClick={() => setShowNewItemModal(true)} className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-zinc-950">
                  Review New Items ({newItemCandidates.length})
                </button>
              ) : null}
              {bulkEligible.length > 0 ? (
                <button
                  type="button"
                  onClick={handleConfirmAllMatches}
                  disabled={bulkConfirmPending}
                  className="rounded-full border border-emerald-600 px-3 py-1 text-[11px] font-semibold text-emerald-200 disabled:opacity-40"
                >
                  {bulkConfirmPending ? "Confirming…" : `Confirm All Matches (${bulkEligible.length})`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ============ BULK RECEIVING ACTIONS -- never mapping/units/conversions ============ */}
        {!readOnly ? (
          <div className="mt-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-200">Apply receiving details to multiple items</p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-zinc-300">
                Location
                <select value={bulkLocationId} onChange={(e) => setBulkLocationId(e.target.value)} className="rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1.5 text-xs text-white">
                  <option value="">{bulkLocationSummary.kind === "multiple" ? "Multiple locations" : "Select…"}</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={handleApplyLocationToAll}
                disabled={!bulkLocationId}
                title={!bulkLocationId ? "Choose a location above first" : undefined}
                className="rounded-full border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-100 disabled:opacity-40"
              >
                Apply location to all inventory items
              </button>
              <label className="flex flex-col gap-1 text-xs text-zinc-300">
                Condition
                <select
                  value={bulkConditionValue}
                  onChange={(e) => setBulkConditionValue(e.target.value as ReceivingLineDraft["conditionStatus"])}
                  className="rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1.5 text-xs text-white"
                >
                  {CONDITION_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={handleApplyConditionToAll}
                disabled={bulkEligibleForCondition === 0}
                title={bulkEligibleForCondition === 0 ? "No lines have a received quantity entered yet" : undefined}
                className="rounded-full border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-100 disabled:opacity-40"
              >
                Apply condition to all
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* ============ ONE CARD PER LINE ============ */}
      <div className="flex flex-col gap-3">
        {filtered.map(({ line, receiving, outcome }) => (
          <LineCard
            key={line.lineKey}
            id={`classification-line-${line.lineKey}`}
            outcome={outcome}
            line={line}
            receiving={receiving}
            editingOpen={isEditingOpen(line.lineKey, outcome)}
            onToggleEditing={() => toggleEditingOpen(line.lineKey)}
            readOnly={readOnly}
            items={items}
            units={units}
            locations={locations}
            spendCategoryPath={line.spendCategoryId ? spendCategoryPathById.get(line.spendCategoryId) : undefined}
            priceComparison={priceComparisons[line.lineKey]}
            overrideFormOpen={overrideFormLineKey === line.lineKey}
            reviewingPackage={packageReviewLineKey === line.lineKey}
            onToggleOverrideForm={() => {
              setOverrideFormLineKey(overrideFormLineKey === line.lineKey ? null : line.lineKey);
              setPackageReviewLineKey(null);
            }}
            onReviewPackage={() => {
              setOverrideFormLineKey(line.lineKey);
              setPackageReviewLineKey(line.lineKey);
              setToggledLineKeys((prev) => new Set(prev).add(line.lineKey));
            }}
            onNavigateToStep1={onNavigateToStep1}
            onApproveExisting={(itemId, vendorPackage) => handleApproveExisting(line.lineKey, itemId, vendorPackage)}
            onMarkNonInventory={() => handleMarkNonInventory(line)}
            onReviewNewItem={() => setShowNewItemModal(true)}
            actionPending={actionPendingLineKey === line.lineKey}
            alreadyReceived={alreadyReceived}
            correcting={correctingLineKey === line.lineKey}
            correctionDraft={correctingLineKey === line.lineKey ? correctionDraft : null}
            correctionPending={correctionPending}
            correctionError={correctingLineKey === line.lineKey ? correctionError : null}
            onOpenCorrection={() => handleOpenCorrection(line.lineKey)}
            onCancelCorrection={() => {
              setCorrectingLineKey(null);
              setCorrectionDraft(null);
              setCorrectionError(null);
            }}
            onCorrectionChange={(patch) => setCorrectionDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
            onSaveCorrection={handleSaveCorrection}
            onReceivingChange={(patch) => updateReceivingLine(line.lineKey, patch)}
            onReceivedQtyOrUnitChange={(patch) => updateReceivedQuantityOrUnit(line.lineKey, patch)}
            onInvoiceUnitChoice={(unit) => handleInvoiceUnitChoice(line.lineKey, unit)}
            savedFlash={savedFlashLineKey === line.lineKey}
          />
        ))}
        {filtered.length === 0 ? <p className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-300">No lines match this filter.</p> : null}
      </div>

      {!readOnly && showNewItemModal ? (
        <NewItemReviewModal
          candidates={newItemCandidates}
          categories={categories}
          spendCategories={spendCategories}
          units={units}
          onClose={() => setShowNewItemModal(false)}
          onResolved={() => load()}
          onCategoriesRefetch={refetchCategories}
        />
      ) : null}

      {onContinue ? (
        <WorkflowFooter
          contextLabel={summary.allResolved ? undefined : `${summary.needsAttentionCount} line${summary.needsAttentionCount === 1 ? "" : "s"} need attention`}
          contextTone="warning"
          onContextClick={
            !summary.allResolved && summary.needsAttentionCount > 0
              ? () => scrollToFirstIssue(combinedLines.filter((c) => c.outcome === "needs_attention").map((c) => ({ id: `classification-line-${c.line.lineKey}`, reason: "" })))
              : undefined
          }
          primaryLabel="Continue to Review & Post"
          onPrimary={handleContinue}
          primaryDisabled={!summary.allResolved}
          primaryPending={continuePending}
          primaryPendingLabel="Saving…"
          primaryTitle={!summary.allResolved ? "Resolve every line before continuing." : undefined}
          sticky={false}
        />
      ) : null}
    </div>
  );
}

// ============================================================
// Page-level completion panel
// ============================================================

function CompletionPanel({
  summary,
  onGoToFirstIssue,
}: {
  summary: ReturnType<typeof summarizeCombinedStep>;
  onGoToFirstIssue: () => void;
}) {
  if (summary.totalLines === 0) return null;
  const inventoryReady = summary.readyCount;

  if (summary.allResolved) {
    return (
      <div className="rounded-2xl border-2 border-emerald-600 bg-emerald-950/30 p-4">
        <p className="text-lg font-bold text-emerald-300">✓ ALL {summary.totalLines} LINES REVIEWED</p>
        <ul className="mt-2 flex flex-col gap-0.5 text-sm font-medium text-emerald-100">
          <li>
            {inventoryReady} inventory item{inventoryReady === 1 ? "" : "s"} ready
          </li>
          <li>
            {summary.expenseCount} expense{summary.expenseCount === 1 ? "" : "s"} classified
          </li>
          <li>0 issues remaining</li>
        </ul>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-amber-500 bg-amber-950/30 p-4">
      <p className="text-lg font-bold text-amber-300">
        {summary.needsAttentionCount} LINE{summary.needsAttentionCount === 1 ? "" : "S"} NEED ATTENTION
      </p>
      <p className="mt-1 text-sm font-medium text-amber-100">
        {inventoryReady} ready · {summary.expenseCount} expense{summary.expenseCount === 1 ? "" : "s"} classified · {summary.needsAttentionCount} still need
        {summary.needsAttentionCount === 1 ? "s" : ""} an item match, purchase package, or receiving detail.
      </p>
      <button type="button" onClick={onGoToFirstIssue} className="mt-3 rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950">
        Go to first issue
      </button>
    </div>
  );
}

// ============================================================
// LineCard -- the visible verification checklist per line
// ============================================================

interface CorrectionDraft {
  receiptLineId: string;
  receivedQuantity: string;
  receivedUnit: string;
  verifiedQuantity: string;
  locationId: string;
  conditionStatus: ReceivingLineDraft["conditionStatus"];
}

function AmendmentChangedBadge({ previous }: { previous: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5 rounded-full border border-sky-600 bg-sky-950/40 px-2 py-0.5 text-[11px] font-semibold text-sky-200">
      Changed in amendment
      {previous ? <span className="font-normal text-sky-300">(was {previous})</span> : null}
    </span>
  );
}

function ProvenanceLine({ provenance }: { provenance: ReturnType<typeof deriveLineProvenance> }) {
  return (
    <p className="mt-1 text-xs font-medium text-zinc-300">
      Status: <span className="font-semibold text-zinc-100">{provenance.label}</span>
      {provenance.resolvedByName ? (
        <span className="block text-[11px] font-normal text-zinc-400">
          Confirmed by {provenance.resolvedByName}
          {provenance.resolvedAt ? ` · ${new Date(provenance.resolvedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
        </span>
      ) : null}
    </p>
  );
}

function ChecklistPanel({ title, ok, warn, children }: { title: string; ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border-2 p-3 ${ok ? "border-emerald-700 bg-emerald-950/10" : warn ? "border-red-700 bg-red-950/10" : "border-amber-600 bg-amber-950/10"}`}>
      <p
        className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide ${ok ? "text-emerald-400" : warn ? "text-red-400" : "text-amber-400"}`}
      >
        <span aria-hidden>{ok ? "✓" : "!"}</span>
        {title}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function formatPurchasePackageDescription(line: LineClassificationRow): string {
  const unit = line.effectivePurchaseUnitCode ?? "—";
  if (line.effectiveReceivingBehavior === "FIXED_CONVERSION" && line.effectiveConversionFactor && line.inventoryBaseUnitCode) {
    const baseUnit = line.inventoryBaseUnitCode.toLowerCase();
    const plural = line.effectiveConversionFactor === 1 ? baseUnit : `${baseUnit}s`;
    return `${unit} — ${line.effectiveConversionFactor} ${plural} per ${unit.toLowerCase()}`;
  }
  return unit;
}

function LineCard({
  id,
  outcome,
  line,
  receiving,
  editingOpen,
  onToggleEditing,
  readOnly,
  items,
  units,
  locations,
  spendCategoryPath,
  priceComparison,
  overrideFormOpen,
  reviewingPackage,
  onToggleOverrideForm,
  onReviewPackage,
  onNavigateToStep1,
  onApproveExisting,
  onMarkNonInventory,
  onReviewNewItem,
  actionPending,
  alreadyReceived,
  correcting,
  correctionDraft,
  correctionPending,
  correctionError,
  onOpenCorrection,
  onCancelCorrection,
  onCorrectionChange,
  onSaveCorrection,
  onReceivingChange,
  onReceivedQtyOrUnitChange,
  onInvoiceUnitChoice,
  savedFlash,
}: {
  id: string;
  outcome: LineOutcome;
  line: LineClassificationRow;
  receiving: ReceivingLineDraft | null;
  editingOpen: boolean;
  onToggleEditing: () => void;
  readOnly?: boolean;
  items: InventoryItemSummary[];
  units: UnitSummary[];
  locations: LocationSummary[];
  spendCategoryPath?: string;
  priceComparison?: PriceComparisonResult;
  overrideFormOpen: boolean;
  reviewingPackage: boolean;
  onToggleOverrideForm: () => void;
  onReviewPackage: () => void;
  onNavigateToStep1?: () => void;
  onApproveExisting: (itemId: string, vendorPackage?: ExistingItemVendorPackageInput | null) => void;
  onMarkNonInventory: () => void;
  onReviewNewItem: () => void;
  actionPending?: boolean;
  alreadyReceived: boolean;
  correcting: boolean;
  correctionDraft: CorrectionDraft | null;
  correctionPending: boolean;
  correctionError: string | null;
  onOpenCorrection: () => void;
  onCancelCorrection: () => void;
  onCorrectionChange: (patch: Partial<CorrectionDraft>) => void;
  onSaveCorrection: () => void;
  onReceivingChange: (patch: Partial<ReceivingLineDraft>) => void;
  onReceivedQtyOrUnitChange: (patch: { receivedQuantity?: string; receivedUnit?: string }) => void;
  onInvoiceUnitChoice: (unit: string) => void;
  savedFlash?: boolean;
}) {
  const orderedQuantity = formatSourceQuantity(line);
  const provenance = deriveLineProvenance({ status: line.status, resolutionSource: line.resolutionSource, resolvedByName: line.resolvedByName, resolvedAt: line.resolvedAt });

  // ============ EXPENSE -- a separate, simple classification panel ============
  if (outcome === "expense") {
    return (
      <div id={id} className="rounded-2xl border-2 border-zinc-700 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-base font-semibold text-white">{line.description ?? "—"}</p>
            <p className="mt-0.5 text-sm text-zinc-300">
              {line.vendorSku ? `Vendor SKU ${line.vendorSku}` : null}
              {orderedQuantity ? ` · Invoice quantity: ${orderedQuantity}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full bg-zinc-700/60 px-3 py-1 text-xs font-semibold text-zinc-100">Expense — no stock</span>
            {!readOnly ? (
              <button type="button" onClick={onToggleEditing} className="rounded-full border border-zinc-500 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:border-zinc-300">
                {editingOpen ? "Hide details" : "Edit details"}
              </button>
            ) : null}
          </div>
        </div>
        {savedFlash ? <p className="mt-1 text-xs font-semibold text-emerald-400">✓ Saved</p> : null}
        <div className="mt-3 rounded-xl border-2 border-emerald-700 bg-emerald-950/10 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-400">
            <span aria-hidden>✓</span> Expense classified
          </p>
          <p className="mt-1 text-sm font-semibold text-white">
            {line.description ?? "This line"} → {spendCategoryPath ?? "Uncategorized expense"}
          </p>
          <p className="mt-1 text-xs font-semibold text-zinc-300">Will not add inventory</p>
          <ProvenanceLine provenance={provenance} />
        </div>
        {editingOpen && !readOnly ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-700 pt-3">
            <button type="button" disabled={actionPending} onClick={onToggleOverrideForm} className="rounded-full border border-zinc-600 px-3 py-1 text-xs text-zinc-100 disabled:opacity-40">
              Choose Different Item
            </button>
            {overrideFormOpen ? (
              <div className="w-full">
                <ExistingItemOverrideForm items={items} units={units} onCancel={onToggleOverrideForm} onConfirm={onApproveExisting} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const isComplete = outcome === "ready";
  const { itemMatchOk, packageOk, receivingReadyOk } = checklistCompletion({
    status: line.status,
    disposition: line.disposition,
    hasPackageMismatch: line.hasPackageMismatch,
    receivingReady: line.disposition === "INVENTORY" && line.status === "CONFIRMED" ? Boolean(receiving && receivingLineIsReady(receiving)) : null,
  });

  return (
    <div id={id} className={`rounded-2xl border-2 p-4 ${isComplete ? "border-emerald-700 bg-zinc-900" : "border-amber-500 bg-amber-950/10"}`}>
      {/* ============ Header ============ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-white">{line.description ?? "—"}</p>
          <p className="mt-0.5 text-sm text-zinc-300">
            {line.vendorSku ? `Vendor SKU ${line.vendorSku}` : null}
            {orderedQuantity ? ` · Invoice quantity: ${orderedQuantity}` : ""}
          </p>
          {line.changedInAmendment ? (
            <div className="mt-1.5">
              <AmendmentChangedBadge previous={line.previousOrderedSummary} />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {isComplete ? (
            <span className="rounded-full border border-emerald-600 bg-emerald-950/40 px-3 py-1 text-xs font-bold text-emerald-300">✓ All checks complete</span>
          ) : (
            <span className="rounded-full border border-amber-500 bg-amber-950/40 px-3 py-1 text-xs font-bold text-amber-300">! Needs attention</span>
          )}
          {!readOnly ? (
            <button type="button" onClick={onToggleEditing} className="rounded-full border border-zinc-500 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:border-zinc-300">
              {editingOpen ? "Hide details" : "Edit details"}
            </button>
          ) : null}
        </div>
      </div>

      {savedFlash ? <p className="mt-1 text-xs font-semibold text-emerald-400">✓ Saved</p> : null}

      {/* ============ Always-visible three-panel checklist ============ */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* A. Item Match */}
        <ChecklistPanel title="Item Match" ok={itemMatchOk}>
          {itemMatchOk ? (
            line.disposition === "INVENTORY" ? (
              <>
                <p className="text-sm font-semibold text-white">{line.inventoryItemName ?? "—"}</p>
                <p className="mt-0.5 text-xs text-zinc-300">
                  {line.inventoryItemNumber ? `${line.inventoryItemNumber} · ` : ""}
                  {line.inventoryCategoryName ?? "No category"}
                </p>
                <p className="text-xs text-zinc-300">Tracked in: {line.inventoryBaseUnitCode ?? "—"}</p>
                <ProvenanceLine provenance={provenance} />
              </>
            ) : (
              <p className="text-xs text-zinc-300">Classified as an expense -- see the panel below.</p>
            )
          ) : (
            <>
              <p className="text-sm font-semibold text-amber-200">{line.aiSuggestedIsNewProposal ? "New item needs verification" : "No item match yet"}</p>
              {line.aiSuggestedInventoryItemId && !line.aiSuggestedIsNewProposal ? (
                <p className="mt-1 text-xs text-zinc-300">
                  Suggested: {line.aiSuggestedInventoryItemName}
                  {line.aiConfidence !== null ? ` (${Math.round(line.aiConfidence * 100)}%)` : ""}
                </p>
              ) : null}
              {!readOnly ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {line.aiSuggestedIsNewProposal ? (
                    <button type="button" onClick={onReviewNewItem} className="rounded-full bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-zinc-950">
                      Review new item →
                    </button>
                  ) : (
                    <>
                      {line.aiSuggestedInventoryItemId ? (
                        <button
                          type="button"
                          disabled={actionPending}
                          onClick={() => onApproveExisting(line.aiSuggestedInventoryItemId!)}
                          className="rounded-full border border-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 disabled:opacity-40"
                        >
                          {actionPending ? "Confirming…" : "Confirm item"}
                        </button>
                      ) : null}
                      <button type="button" disabled={actionPending} onClick={onToggleOverrideForm} className="rounded-full border border-zinc-500 px-2.5 py-1 text-[11px] text-zinc-100 disabled:opacity-40">
                        Change match
                      </button>
                      <button type="button" disabled={actionPending} onClick={onMarkNonInventory} className="rounded-full border border-zinc-500 px-2.5 py-1 text-[11px] text-zinc-100 disabled:opacity-40">
                        {actionPending ? "Marking…" : "Mark as expense"}
                      </button>
                    </>
                  )}
                </div>
              ) : null}
              {overrideFormOpen ? (
                <div className="mt-2">
                  <ExistingItemOverrideForm items={items} units={units} onCancel={onToggleOverrideForm} onConfirm={onApproveExisting} />
                </div>
              ) : null}
            </>
          )}
        </ChecklistPanel>

        {/* B. Purchase Package */}
        <ChecklistPanel title="Purchase Package" ok={packageOk} warn={itemMatchOk && line.disposition === "INVENTORY" && line.hasPackageMismatch}>
          {!itemMatchOk || line.disposition !== "INVENTORY" ? (
            <p className="text-xs text-zinc-300">Waiting on item match.</p>
          ) : line.hasPackageMismatch ? (
            <>
              <p className="text-sm font-semibold text-red-200">Purchase package needs review</p>
              <p className="mt-1 text-xs text-zinc-200">
                Invoice unit: <span className="font-semibold text-white">{line.resolvedInvoiceUnitCode}</span>
              </p>
              <p className="text-xs text-zinc-200">
                Configured unit: <span className="font-semibold text-white">{formatPurchasePackageDescription(line)}</span>
              </p>
              {!readOnly ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {onNavigateToStep1 ? (
                    <button type="button" onClick={onNavigateToStep1} className="rounded-full border border-red-600 px-2.5 py-1 text-[11px] font-semibold text-red-200 hover:bg-red-900/30">
                      Correct invoice unit
                    </button>
                  ) : null}
                  <button type="button" onClick={onReviewPackage} className="rounded-full border border-red-600 px-2.5 py-1 text-[11px] font-semibold text-red-200 hover:bg-red-900/30">
                    Review purchase package
                  </button>
                  <button type="button" onClick={onToggleEditing} className="rounded-full border border-red-600 px-2.5 py-1 text-[11px] font-semibold text-red-200 hover:bg-red-900/30">
                    Return to item verification
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <PackageChecklistBody line={line} />
          )}
          {editingOpen && itemMatchOk && line.disposition === "INVENTORY" && !readOnly ? (
            <div className="mt-2 border-t border-zinc-700 pt-2">
              <button type="button" onClick={onToggleOverrideForm} className="text-[11px] font-medium text-zinc-300 underline underline-offset-2 hover:text-zinc-100">
                Review purchase package
              </button>
              {overrideFormOpen ? (
                <div className="mt-2">
                  <ExistingItemOverrideForm
                    items={items}
                    units={units}
                    onCancel={onToggleOverrideForm}
                    onConfirm={onApproveExisting}
                    defaultItemId={reviewingPackage ? (line.inventoryItemId ?? undefined) : undefined}
                    defaultRegisteringPackage={reviewingPackage}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </ChecklistPanel>

        {/* C. Receiving */}
        <ChecklistPanel title="Receiving" ok={receivingReadyOk}>
          {!itemMatchOk || line.disposition !== "INVENTORY" ? (
            <p className="text-xs text-zinc-300">Waiting on item match.</p>
          ) : receiving ? (
            <ReceivingChecklistBody receiving={receiving} locations={locations} alreadyReceived={alreadyReceived} />
          ) : null}
        </ChecklistPanel>
      </div>

      {priceComparison?.available ? (
        <p className="mt-2 text-[11px] leading-tight text-zinc-300">
          <span className="text-zinc-200">
            ${priceComparison.currentUnitCost.toFixed(2)} / {priceComparison.baseUnitCode}
          </span>
          <span className={`ml-1.5 font-medium ${priceChangeTone(priceComparison.direction).colorClass}`}>
            {priceChangeTone(priceComparison.direction).glyph} {Math.abs(priceComparison.deltaPct).toFixed(1)}%
          </span>
          <span className="ml-1 text-zinc-400">vs previous purchase</span>
        </p>
      ) : null}

      {/* ============ Editing controls -- collapsed unless editingOpen ============ */}
      {editingOpen && itemMatchOk && line.disposition === "INVENTORY" ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-zinc-700 pt-3">
          {alreadyReceived ? (
            correcting && correctionDraft ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-300">Correct receiving details</p>
                <ReceivingFields
                  requiresVerifiedMeasurement={receiving?.info.requiresVerifiedMeasurement ?? false}
                  baseUnitCode={receiving?.info.baseUnitCode ?? null}
                  receivingBehavior={receiving?.info.receivingBehavior ?? null}
                  receivedQuantity={correctionDraft.receivedQuantity}
                  receivedUnit={correctionDraft.receivedUnit}
                  verifiedQuantity={correctionDraft.verifiedQuantity}
                  locationId={correctionDraft.locationId}
                  conditionStatus={correctionDraft.conditionStatus}
                  locations={locations}
                  disabled={readOnly}
                  onChange={(patch) => onCorrectionChange(patch)}
                  onReceivedQtyOrUnitChange={(patch) => {
                    if (!receiving) return onCorrectionChange(patch);
                    const next = { ...correctionDraft, ...patch };
                    const recomputed =
                      receiving.info.receivingBehavior === "FIXED_CONVERSION" ? recomputeFixedConversionVerifiedQuantity(receiving.info, next.receivedQuantity, next.receivedUnit) : next.verifiedQuantity;
                    onCorrectionChange({ ...patch, verifiedQuantity: recomputed });
                  }}
                />
                {correctionError ? <p className="text-xs text-red-300">{correctionError}</p> : null}
                <div className="flex items-center gap-3">
                  <button type="button" onClick={onSaveCorrection} disabled={correctionPending} className="rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">
                    {correctionPending ? "Saving…" : "Save correction"}
                  </button>
                  <button type="button" onClick={onCancelCorrection} className="text-xs text-zinc-300 underline underline-offset-2">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={onOpenCorrection} className="self-start rounded-full border border-zinc-500 px-3 py-1.5 text-xs font-semibold text-zinc-100">
                Correct receiving details
              </button>
            )
          ) : receiving ? (
            <div className="flex flex-col gap-2">
              {!readOnly && needsInvoiceUnitResolution(receiving) ? (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-700 bg-amber-950/20 p-3">
                  {receiving.invoiceUnitConflict ? (
                    <p className="text-xs text-amber-200">
                      Invoice says: <span className="font-semibold">{receiving.invoiceUnitConflict.invoiceUnit}</span> · Previously remembered:{" "}
                      <span className="font-semibold">{receiving.invoiceUnitConflict.rememberedUnit}</span> · Needs review.
                    </p>
                  ) : (
                    <p className="text-xs text-amber-200">Invoice unit not stated -- resolve it once and it will be remembered.</p>
                  )}
                  <label className="flex flex-col gap-0.5 text-xs text-zinc-300">
                    Invoice unit
                    <select
                      value={receiving.invoiceUnitChoice}
                      onChange={(e) => onInvoiceUnitChoice(e.target.value)}
                      className="rounded-lg border border-amber-600 bg-zinc-950 px-2 py-1 text-xs text-white"
                    >
                      <option value="">Select…</option>
                      {invoiceUnitCandidates(receiving).map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
              <ReceivingFields
                requiresVerifiedMeasurement={receiving.info.requiresVerifiedMeasurement}
                baseUnitCode={receiving.info.baseUnitCode}
                receivingBehavior={receiving.info.receivingBehavior}
                receivedQuantity={receiving.receivedQuantity}
                receivedUnit={receiving.receivedUnit}
                verifiedQuantity={receiving.verifiedQuantity}
                locationId={receiving.locationId}
                conditionStatus={receiving.conditionStatus}
                locations={locations}
                disabled={readOnly}
                onChange={onReceivingChange}
                onReceivedQtyOrUnitChange={onReceivedQtyOrUnitChange}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PackageChecklistBody({ line }: { line: LineClassificationRow }) {
  const display = formatPackageConfirmation({
    packageQuantity: line.packageQuantity,
    resolvedInvoiceUnitCode: line.resolvedInvoiceUnitCode,
    effectivePurchaseUnitCode: line.effectivePurchaseUnitCode,
    effectiveReceivingBehavior: line.effectiveReceivingBehavior,
    effectiveConversionFactor: line.effectiveConversionFactor,
    inventoryBaseUnitCode: line.inventoryBaseUnitCode,
  });
  if (!display) {
    return <p className="text-xs text-zinc-300">Purchase package not yet confirmed.</p>;
  }
  return (
    <>
      <p className="text-sm font-semibold text-white">{display.lines[0]}</p>
      {display.lines.slice(1).map((text, index) => (
        <p key={index} className="text-xs text-zinc-300">
          {text}
        </p>
      ))}
      <p className="mt-1 text-xs font-medium text-zinc-300">
        Status: <span className="font-semibold text-emerald-300">Vendor package confirmed</span>
      </p>
    </>
  );
}

function ReceivingChecklistBody({ receiving, locations, alreadyReceived }: { receiving: ReceivingLineDraft; locations: LocationSummary[]; alreadyReceived: boolean }) {
  const ready = receivingLineIsReady(receiving);
  if (!ready) {
    return <p className="text-sm font-semibold text-amber-200">{missingReceivingReason(receiving)}</p>;
  }
  const locationName = locations.find((l) => l.id === receiving.locationId)?.name ?? "—";
  const conditionLabel = CONDITION_OPTIONS.find((c) => c.value === receiving.conditionStatus)?.label ?? receiving.conditionStatus;
  const normalized = receiving.info.receivingBehavior === "FIXED_CONVERSION" && receiving.verifiedQuantity ? `${receiving.verifiedQuantity} ${receiving.info.baseUnitCode ?? ""}` : null;
  return (
    <>
      <p className="text-sm font-semibold text-white">
        Received: {receiving.receivedQuantity} {receiving.receivedUnit}
        {normalized ? ` / ${normalized}` : ""}
      </p>
      <p className="mt-0.5 text-xs text-zinc-300">{locationName}</p>
      <p className="text-xs text-zinc-300">Condition: {conditionLabel}</p>
      <p className="mt-1 text-xs font-medium text-zinc-300">
        Status: <span className="font-semibold text-emerald-300">{alreadyReceived ? "Confirmed for this delivery" : "Ready to confirm"}</span>
      </p>
    </>
  );
}

function ReceivingFields({
  requiresVerifiedMeasurement,
  baseUnitCode,
  receivingBehavior,
  receivedQuantity,
  receivedUnit,
  verifiedQuantity,
  locationId,
  conditionStatus,
  locations,
  disabled,
  onChange,
  onReceivedQtyOrUnitChange,
}: {
  requiresVerifiedMeasurement: boolean;
  baseUnitCode: string | null;
  receivingBehavior: string | null;
  receivedQuantity: string;
  receivedUnit: string;
  verifiedQuantity: string;
  locationId: string;
  conditionStatus: ReceivingLineDraft["conditionStatus"];
  locations: LocationSummary[];
  disabled?: boolean;
  onChange: (patch: { locationId?: string; conditionStatus?: ReceivingLineDraft["conditionStatus"]; verifiedQuantity?: string }) => void;
  onReceivedQtyOrUnitChange: (patch: { receivedQuantity?: string; receivedUnit?: string }) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-0.5 text-xs font-medium text-zinc-300">
        Received
        <div className="flex gap-1">
          <input
            type="number"
            value={receivedQuantity}
            disabled={disabled}
            onChange={(e) => onReceivedQtyOrUnitChange({ receivedQuantity: e.target.value })}
            placeholder="Qty"
            className="w-20 rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1 text-xs text-white disabled:opacity-60"
          />
          <input
            type="text"
            value={receivedUnit}
            disabled={disabled}
            onChange={(e) => onReceivedQtyOrUnitChange({ receivedUnit: e.target.value })}
            placeholder="Unit"
            className="w-20 rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1 text-xs text-white disabled:opacity-60"
          />
        </div>
        {receivingBehavior === "FIXED_CONVERSION" && verifiedQuantity.trim() !== "" ? (
          <span className="text-xs font-medium text-zinc-300">
            Adds to inventory: {verifiedQuantity} {baseUnitCode}
          </span>
        ) : null}
      </label>

      {requiresVerifiedMeasurement ? (
        <label className="flex flex-col gap-0.5 text-xs font-medium text-amber-300">
          Verified {baseUnitCode} <span className="text-amber-400">REQUIRED</span>
          <input
            type="number"
            value={verifiedQuantity}
            disabled={disabled}
            onChange={(e) => onChange({ verifiedQuantity: e.target.value })}
            placeholder={baseUnitCode ?? ""}
            className="w-28 rounded-lg border border-amber-600 bg-zinc-950 px-2 py-1 text-xs text-white disabled:opacity-60"
          />
        </label>
      ) : null}

      <label className="flex flex-col gap-0.5 text-xs font-medium text-zinc-300">
        Location
        <select
          value={locationId}
          disabled={disabled}
          onChange={(e) => onChange({ locationId: e.target.value })}
          className="rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1 text-xs text-white disabled:opacity-60"
        >
          <option value="">Select…</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-0.5 text-xs font-medium text-zinc-300">
        Condition
        <select
          value={conditionStatus}
          disabled={disabled}
          onChange={(e) => onChange({ conditionStatus: e.target.value as ReceivingLineDraft["conditionStatus"] })}
          className="rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1 text-xs text-white disabled:opacity-60"
        >
          {CONDITION_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
