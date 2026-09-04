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
  receivingLineIsReady,
  applyLocationToAll,
  applyConditionToAll,
  summarizeBulkLocations,
  missingReceivingReason,
} from "@/app/lib/purchaseDocuments/itemsAndReceivingCardState";
import { deriveLineProvenance } from "@/app/lib/purchaseDocuments/lineProvenance";
import { describeLineIssue } from "@/app/lib/purchaseDocuments/lineIssueSummary";
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
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, inlineWarningClass, inlineNeutralClass } from "@/app/components/manager/surfaces";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

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

/** A smaller "Edit details" affordance sized for a table row -- the
 * shared secondaryButtonClass's h-9 height is right for a toolbar, but
 * too tall to sit inline in a compact ~52px row. */
const secondaryButtonClassCompact =
  "inline-flex h-7 items-center justify-center rounded-md border border-zinc-600 px-2.5 text-xs font-medium leading-none text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";

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
  onProgressChange?: (progress: { readyCount: number; totalLines: number; expenseCount: number; needsAttentionCount: number }) => void;
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

  // Exactly one line editable at a time: null means every row is
  // collapsed to its compact summary; a lineKey means that ONE row shows
  // the full inline editor (Item Match / Purchase Package / Receiving),
  // never more than one simultaneously.
  const [editingLineKey, setEditingLineKey] = useState<string | null>(null);
  // The editing line's receiving draft AT THE MOMENT the editor opened --
  // the only way "Cancel restores the persisted values" can be honest,
  // since receivingLineState itself is live/shared with every other
  // consumer (bulk actions, the compact row, Continue's own batch
  // submit) and can't just be rolled back wholesale.
  const [receivingDraftSnapshot, setReceivingDraftSnapshot] = useState<ReceivingLineDraft | null>(null);
  const [receivingSavePending, setReceivingSavePending] = useState(false);
  const [receivingSaveError, setReceivingSaveError] = useState<string | null>(null);
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
    receiptLineIds: string[];
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
    const [
      linesResult,
      itemsResult,
      categoriesResult,
      spendResult,
      unitsResult,
      priceComparisonsResult,
      receiptsResult,
      receivingResult,
      locationsResult,
      amendmentPostedResult,
      effectiveReceivingResult,
    ] = await Promise.all([
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
      getEffectiveReceivingLinesForPurchaseDocument(purchaseDocumentId),
    ]);

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

    if (receivingResult.ok) {
      const soleLocationId = locationsResult.ok && locationsResult.locations.length === 1 ? locationsResult.locations[0].id : "";
      setBulkLocationId((current) => current || soleLocationId);
      const loadedLocations = locationsResult.ok ? locationsResult.locations : [];
      // getReceivingLinesForPurchaseDocument's own prefill (mergeReceivingLineState)
      // is correction-BLIND -- it exists for the pre-first-receipt draft
      // workflow and never revisits a line once a delivery receipt exists.
      // Once corrections start (correctEffectiveReceiving), the row/editor
      // display for an already-received line must instead reflect the
      // SAME authoritative "effective" (latest-correction-aware) state the
      // correction editor itself already trusts -- never a second,
      // independently stale copy that silently un-shows a saved correction.
      const effectiveByLineKey = new Map(
        effectiveReceivingResult.ok ? effectiveReceivingResult.lines.map((l) => [l.matchedLineKey, l] as const) : []
      );
      setReceivingLineState((prev) =>
        mergeReceivingLineState(receivingResult.lines, loadedLocations, prev).map((draft) => {
          const effective = effectiveByLineKey.get(draft.lineKey);
          if (!effective) return draft;
          return {
            ...draft,
            receivedQuantity: effective.receivedQuantity !== null ? String(effective.receivedQuantity) : draft.receivedQuantity,
            receivedUnit: effective.receivedUnit ?? draft.receivedUnit,
            verifiedQuantity: effective.verifiedBaseQuantity !== null ? String(effective.verifiedBaseQuantity) : draft.verifiedQuantity,
            locationId: effective.locationId ?? draft.locationId,
            conditionStatus: effective.conditionStatus as ReceivingLineDraft["conditionStatus"],
          };
        })
      );
    }

    setLoading(false);
    onChange?.();
    // onChange is a stable callback from the parent. Progress/resolved
    // reporting to the parent (onProgressChange/onAllResolvedChange) is
    // handled by the effect below, from the SAME live summary the render
    // itself uses -- never recomputed here from this load's own snapshot,
    // which is exactly what let the parent's reported progress go stale
    // the instant a manager edited a field without triggering another
    // load() (the "2 of 9 reviewed" vs "ALL 9 LINES REVIEWED" defect).
  }, [purchaseDocumentId, onChange]);

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
    const line = (lines ?? []).find((l) => l.lineKey === lineKey);
    const itemChanged = Boolean(line && line.inventoryItemId !== inventoryItemId);
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
    if (itemChanged) {
      // Immediate revalidation: a received quantity/unit entered against
      // the PREVIOUS item's purchase package is never safe to keep for a
      // DIFFERENT item (it may not even sell in the same unit) -- clearing
      // it here, before load() re-merges below, is what lets the new
      // item's own package config re-prefill fresh instead of a stale
      // value surviving the match change.
      updateReceivingLine(lineKey, { receivedQuantity: "", receivedUnit: "", verifiedQuantity: "" });
      // Once a delivery already exists for this document, Receiving here
      // renders the CORRECTION editor instead (fed by correctionDraft, not
      // receivingLineState) -- the clear above is invisible to it, so the
      // already-recorded quantity/unit from the PREVIOUS item would
      // otherwise keep showing as if it were still valid for the new one.
      if (correctingLineKey === lineKey) {
        setCorrectionDraft((prev) => (prev ? { ...prev, receivedQuantity: "", receivedUnit: "", verifiedQuantity: "" } : prev));
      }
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
    // Normally exactly one receipt line is effective per matched line key --
    // but the data model doesn't forbid two independently-effective lines
    // existing at once (e.g. a stray duplicate delivery submission never
    // corrected against the first). Reconciling ALL of them into the same
    // new values on save (below) is what makes a correction self-healing
    // instead of leaving the other one silently still "effective" and
    // fighting the display for which value is true. getEffectiveReceivingLines
    // already returns lines ordered oldest-effective-receipt-first, so the
    // LAST match is the best-guess "current" value to prefill from.
    const effectiveLines = result.lines.filter((l) => l.matchedLineKey === lineKey);
    if (effectiveLines.length === 0) return;
    const latest = effectiveLines[effectiveLines.length - 1];
    setCorrectionDraft({
      receiptLineIds: effectiveLines.map((l) => l.receiptLineId),
      receivedQuantity: latest.receivedQuantity !== null ? String(latest.receivedQuantity) : "",
      receivedUnit: latest.receivedUnit ?? "",
      verifiedQuantity: latest.verifiedBaseQuantity !== null ? String(latest.verifiedBaseQuantity) : "",
      locationId: latest.locationId ?? "",
      conditionStatus: latest.conditionStatus as ReceivingLineDraft["conditionStatus"],
    });
    setCorrectingLineKey(lineKey);
  }

  async function handleSaveCorrection() {
    if (!correctionDraft || correctionPending || !correctingLineKey) return;
    setCorrectionPending(true);
    setCorrectionError(null);
    const edits: ReceivingLineEdit[] = correctionDraft.receiptLineIds.map((receiptLineId) => ({
      receiptLineId,
      receivedQuantity: Number(correctionDraft.receivedQuantity),
      receivedUnit: correctionDraft.receivedUnit || null,
      verifiedBaseQuantity: correctionDraft.verifiedQuantity.trim() !== "" ? Number(correctionDraft.verifiedQuantity) : null,
      locationId: correctionDraft.locationId || null,
      conditionStatus: correctionDraft.conditionStatus,
    }));
    const result = await correctEffectiveReceiving({ purchaseDocumentId, editSessionKey, edits });
    setCorrectionPending(false);
    if (!result.ok) {
      setCorrectionError(result.message);
      return;
    }
    const savedLineKey = correctingLineKey;
    flashSaved(savedLineKey);
    setCorrectingLineKey(null);
    setCorrectionDraft(null);
    setEditingLineKey(null);
    setReceivingDraftSnapshot(null);
    await load();
    focusRow(savedLineKey);
  }

  // ============ Single line-editor open/close/save (Edit line) ============

  function focusRow(lineKey: string) {
    window.setTimeout(() => document.getElementById(`classification-line-${lineKey}`)?.focus(), 0);
  }

  /** True only for the currently-editing line, and only once its
   * receiving draft has actually diverged from the snapshot captured the
   * moment the editor opened -- the one fact "warn before discarding"
   * needs, since Item Match / Purchase Package changes below already
   * save immediately (their own Confirm button), leaving Receiving as
   * the only genuinely deferred edit. */
  function isReceivingDirty(lineKey: string): boolean {
    if (editingLineKey !== lineKey || !receivingDraftSnapshot) return false;
    const current = receivingLineState.find((l) => l.lineKey === lineKey);
    if (!current) return false;
    return (
      current.receivedQuantity !== receivingDraftSnapshot.receivedQuantity ||
      current.receivedUnit !== receivingDraftSnapshot.receivedUnit ||
      current.verifiedQuantity !== receivingDraftSnapshot.verifiedQuantity ||
      current.locationId !== receivingDraftSnapshot.locationId ||
      current.conditionStatus !== receivingDraftSnapshot.conditionStatus
    );
  }

  function restoreReceivingSnapshot(lineKey: string) {
    if (receivingDraftSnapshot) updateReceivingLine(lineKey, receivingDraftSnapshot);
  }

  async function handleEditLine(lineKey: string) {
    if (editingLineKey === lineKey) {
      handleCloseEditor(lineKey);
      return;
    }
    if (editingLineKey && isReceivingDirty(editingLineKey)) {
      if (!window.confirm("Discard unsaved receiving changes on the line you're currently editing?")) return;
      restoreReceivingSnapshot(editingLineKey);
    }
    setOverrideFormLineKey(null);
    setPackageReviewLineKey(null);
    setCorrectingLineKey(null);
    setCorrectionDraft(null);
    setCorrectionError(null);
    setReceivingSaveError(null);
    setEditingLineKey(lineKey);
    setReceivingDraftSnapshot(receivingLineState.find((l) => l.lineKey === lineKey) ?? null);
    if (alreadyReceived) await handleOpenCorrection(lineKey);
  }

  function handleCloseEditor(lineKey: string) {
    if (isReceivingDirty(lineKey) && !window.confirm("Discard unsaved receiving changes?")) return;
    restoreReceivingSnapshot(lineKey);
    setEditingLineKey(null);
    setReceivingDraftSnapshot(null);
    setOverrideFormLineKey(null);
    setPackageReviewLineKey(null);
    setCorrectingLineKey(null);
    setCorrectionDraft(null);
    setCorrectionError(null);
    setReceivingSaveError(null);
    focusRow(lineKey);
  }

  function handleCancelReceivingDraft(lineKey: string) {
    restoreReceivingSnapshot(lineKey);
    setReceivingSaveError(null);
    setEditingLineKey(null);
    setReceivingDraftSnapshot(null);
    focusRow(lineKey);
  }

  /** Saves the not-yet-received (draft) path -- reuses submitReceivingIfNeeded
   * unchanged (the SAME batch action Continue already calls), just
   * triggered earlier by one line's own Save button rather than only at
   * the bottom of the step. Any OTHER line's already-filled-in draft is
   * committed too, exactly as it would be if the manager clicked
   * Continue right now -- never a second, differently-scoped RPC. */
  async function handleSaveReceivingDraft(lineKey: string) {
    if (receivingSavePending) return;
    setReceivingSavePending(true);
    setReceivingSaveError(null);
    const result = await submitReceivingIfNeeded();
    setReceivingSavePending(false);
    if (!result.ok) {
      setReceivingSaveError(result.message);
      return;
    }
    flashSaved(lineKey);
    setEditingLineKey(null);
    setReceivingDraftSnapshot(null);
    await load();
    focusRow(lineKey);
  }

  // ============ Continue ============

  async function handleContinue() {
    if (continuePending || !onContinue) return;
    if (editingLineKey && isReceivingDirty(editingLineKey)) {
      if (!window.confirm("You have unsaved receiving changes on this line. Continue anyway and discard them?")) return;
      restoreReceivingSnapshot(editingLineKey);
    }
    setEditingLineKey(null);
    setReceivingDraftSnapshot(null);
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

  // ============ THE authoritative per-line/step readiness model ============
  // Computed unconditionally, every render, from CURRENT lines/receiving
  // state (never a stale snapshot from the last load()) -- the single
  // source every consumer of Step 2 completion reads from: this render's
  // own JSX below, AND the parent (via the effect immediately after) for
  // the Stepper's sublabel and the step's own completion gate. Two
  // separately-updated copies of this exact computation (one live here,
  // one refreshed only on load()) is what previously let the Stepper show
  // "2 of 9 reviewed" while this same panel's own completion banner said
  // "ALL 9 LINES REVIEWED" -- there is now exactly one.
  const receivingByLineKey = new Map(receivingLineState.map((l) => [l.lineKey, l]));
  const combinedLines = (lines ?? []).map((line) => {
    const receiving = receivingByLineKey.get(line.lineKey) ?? null;
    const receivingReady = line.disposition === "INVENTORY" && line.status === "CONFIRMED" ? Boolean(receiving && receivingLineIsReady(receiving)) : null;
    const outcome = classifyLineOutcome({ status: line.status, disposition: line.disposition, hasPackageMismatch: line.hasPackageMismatch, receivingReady });
    return { line, receiving, outcome };
  });
  const summary = summarizeCombinedStep(combinedLines.map((c) => c.outcome));

  useEffect(() => {
    if (lines === null) return; // nothing loaded yet -- never report a premature "0 of 0"
    onProgressChange?.({ readyCount: summary.readyCount, totalLines: summary.totalLines, expenseCount: summary.expenseCount, needsAttentionCount: summary.needsAttentionCount });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines === null, summary.readyCount, summary.totalLines, summary.expenseCount, summary.needsAttentionCount, onProgressChange]);

  useEffect(() => {
    if (lines === null) return;
    onAllResolvedChange?.(summary.allResolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines === null, summary.allResolved, onAllResolvedChange]);

  const hasUnsavedReceivingDraft = editingLineKey !== null && isReceivingDirty(editingLineKey);
  useEffect(() => {
    if (!hasUnsavedReceivingDraft) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedReceivingDraft]);

  if (loading || lines === null) {
    return (
      <div aria-busy="true" className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-sm text-zinc-300">Loading…</p>
      </div>
    );
  }

  const matchingBanner =
    matchingPhase === "blocking" ? (
      <div aria-busy="true" className="rounded-lg border border-amber-800 bg-amber-950/10 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Matching Items</p>
        <p className="mt-1 text-sm text-zinc-200">Checking vendor mappings and matching invoice lines against your item master. This will update automatically.</p>
      </div>
    ) : matchingPhase === "stillActive" || matchingPhase === "failed" || matchingPhase === "stuck" ? (
      <div className="rounded-lg border border-amber-800 bg-amber-950/10 p-4">
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
          className="mt-3 rounded-md bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950"
        >
          {matchingPhase === "stillActive" ? "Check Again" : "Retry Unresolved Matching"}
        </button>
      </div>
    ) : null;

  const spendCategoryPathById = new Map(flattenSpendCategoryPaths(spendCategories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }))).map((p) => [p.id, p.path]));

  const filtered = combinedLines.filter((c) => {
    if (filter === "all") return true;
    if (filter === "needs_attention") return c.outcome === "needs_attention";
    if (filter === "ready") return c.outcome === "ready";
    return c.outcome === "expense";
  });

  const bulkLocationSummary = summarizeBulkLocations(receivingLineState.map((l) => l.locationId || null));
  const bulkEligibleForCondition = receivingLineState.filter((l) => l.receivedQuantity.trim() !== "").length;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {matchingBanner}
      {error && !matchingBanner ? <p className="rounded-lg border border-red-800 bg-red-950/20 p-3 text-sm text-red-300">{error}</p> : null}

      {alreadyPostedElsewhere ? (
        <div className="rounded-lg border border-sky-700 bg-sky-950/30 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-sky-300">Inventory already posted</p>
          <p className="mt-1 text-sm font-medium text-sky-50">Inventory was already posted from the original revision. This amendment will not post it again.</p>
        </div>
      ) : null}

      {/* ============ TOOLBAR -- the compact readiness summary lives
          right beside the title, never a second, redundant full-width
          banner repeating the same counts. ============ */}
      <div className={panelClass}>
        <div className={`${panelHeaderClass} flex-wrap`}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className={panelTitleClass}>Confirm Items &amp; Receiving</h2>
            {summary.totalLines > 0 ? (
              <span className={`text-xs font-medium ${summary.allResolved ? "text-emerald-400" : "text-amber-300"}`}>
                {summary.allResolved ? "✓ " : ""}
                {summary.totalLines} line{summary.totalLines === 1 ? "" : "s"} · {summary.readyCount} ready · {summary.expenseCount} expense
                {summary.expenseCount === 1 ? "" : "s"} · {summary.allResolved ? "0 issues" : `${summary.needsAttentionCount} issue${summary.needsAttentionCount === 1 ? "" : "s"}`}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!summary.allResolved && summary.needsAttentionCount > 0 ? (
              <button
                type="button"
                onClick={() => scrollToFirstIssue(combinedLines.filter((c) => c.outcome === "needs_attention").map((c) => ({ id: `classification-line-${c.line.lineKey}`, reason: "" })))}
                className={secondaryButtonClassCompact}
              >
                Go to first issue
              </button>
            ) : null}
            {!readOnly ? (
              <div className="relative">
                <button type="button" onClick={() => setMoreActionsOpen((v) => !v)} className={secondaryButtonClass}>
                  More actions ▾
                </button>
                {moreActionsOpen ? (
                  <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
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
        </div>
        <div className={panelBodyClass}>
        <p className="text-sm text-zinc-400">Confirm each item match, purchase package, received quantity and destination.</p>

        {rerunConfirmOpen ? (
          <div className={`mt-3 ${inlineWarningClass}`}>
            <p className="font-medium text-amber-100">
              Re-running matching may replace existing AI suggestions for lines you haven&apos;t confirmed yet. Already-confirmed lines are never touched.
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={handleRunMatching} className="rounded-md bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950">
                Re-run matching
              </button>
              <button type="button" onClick={() => setRerunConfirmOpen(false)} className="rounded-md border border-zinc-600 px-4 py-1.5 text-xs text-zinc-200">
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
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium ${
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
                <button type="button" onClick={() => setShowNewItemModal(true)} className="rounded-md bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-zinc-950">
                  Review New Items ({newItemCandidates.length})
                </button>
              ) : null}
              {bulkEligible.length > 0 ? (
                <button
                  type="button"
                  onClick={handleConfirmAllMatches}
                  disabled={bulkConfirmPending}
                  className="rounded-md border border-emerald-600 px-3 py-1 text-[11px] font-semibold text-emerald-200 disabled:opacity-40"
                >
                  {bulkConfirmPending ? "Confirming…" : `Confirm All Matches (${bulkEligible.length})`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ============ BULK RECEIVING ACTIONS -- a compact toolbar row,
            never a large nested box -- still never touches mapping/
            units/conversions. ============ */}
        {!readOnly ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
            <span className="font-medium text-zinc-500">Apply to multiple:</span>
            <select value={bulkLocationId} onChange={(e) => setBulkLocationId(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white">
              <option value="">{bulkLocationSummary.kind === "multiple" ? "Multiple locations" : "Location…"}</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleApplyLocationToAll}
              disabled={!bulkLocationId}
              title={!bulkLocationId ? "Choose a location above first" : undefined}
              className={secondaryButtonClassCompact}
            >
              Apply location
            </button>
            <select
              value={bulkConditionValue}
              onChange={(e) => setBulkConditionValue(e.target.value as ReceivingLineDraft["conditionStatus"])}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white"
            >
              {CONDITION_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleApplyConditionToAll}
              disabled={bulkEligibleForCondition === 0}
              title={bulkEligibleForCondition === 0 ? "No lines have a received quantity entered yet" : undefined}
              className={secondaryButtonClassCompact}
            >
              Apply condition
            </button>
          </div>
        ) : null}
        </div>
      </div>

      {/* ============ Work-queue table -- one aligned row per line ============ */}
      <div className={panelClass}>
        {filtered.length > 0 ? (
          <div className="hidden border-b border-zinc-800 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 sm:grid sm:grid-cols-[1.5fr_1.1fr_1.1fr_1.4fr_84px_112px] sm:gap-3">
            <span>Invoice line</span>
            <span>Item match</span>
            <span>Purchase package</span>
            <span>Receiving</span>
            <span>Status</span>
            <span>Action</span>
          </div>
        ) : null}
        {filtered.map(({ line, receiving, outcome }) => (
          <LineCard
            key={line.lineKey}
            id={`classification-line-${line.lineKey}`}
            outcome={outcome}
            line={line}
            receiving={receiving}
            editingOpen={editingLineKey === line.lineKey}
            onEditLine={() => handleEditLine(line.lineKey)}
            onCloseEditor={() => handleCloseEditor(line.lineKey)}
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
            onCancelCorrection={() => {
              setCorrectingLineKey(null);
              setCorrectionDraft(null);
              setCorrectionError(null);
              setEditingLineKey(null);
              setReceivingDraftSnapshot(null);
              focusRow(line.lineKey);
            }}
            onCorrectionChange={(patch) => setCorrectionDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
            onSaveCorrection={handleSaveCorrection}
            onReceivingChange={(patch) => updateReceivingLine(line.lineKey, patch)}
            onReceivedQtyOrUnitChange={(patch) => updateReceivedQuantityOrUnit(line.lineKey, patch)}
            onInvoiceUnitChoice={(unit) => handleInvoiceUnitChoice(line.lineKey, unit)}
            receivingSavePending={receivingSavePending}
            receivingSaveError={editingLineKey === line.lineKey ? receivingSaveError : null}
            onSaveReceivingDraft={() => handleSaveReceivingDraft(line.lineKey)}
            onCancelReceivingDraft={() => handleCancelReceivingDraft(line.lineKey)}
            savedFlash={savedFlashLineKey === line.lineKey}
          />
        ))}
        {filtered.length === 0 ? <p className="px-4 py-6 text-center text-sm text-zinc-400">No lines match this filter.</p> : null}
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
// LineCard -- the visible verification checklist per line
// ============================================================

interface CorrectionDraft {
  receiptLineIds: string[];
  receivedQuantity: string;
  receivedUnit: string;
  verifiedQuantity: string;
  locationId: string;
  conditionStatus: ReceivingLineDraft["conditionStatus"];
}

function AmendmentChangedBadge({ previous }: { previous: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5 rounded-md border border-sky-600 bg-sky-950/40 px-2 py-0.5 text-[11px] font-semibold text-sky-200">
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

function SectionStatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span aria-hidden className={`text-[11px] font-medium ${ok ? "text-emerald-400" : warn ? "text-red-400" : "text-zinc-600"}`}>{ok ? "✓" : warn ? "!" : ""}</span>;
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
  onEditLine,
  onCloseEditor,
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
  onCancelCorrection,
  onCorrectionChange,
  onSaveCorrection,
  onReceivingChange,
  onReceivedQtyOrUnitChange,
  onInvoiceUnitChoice,
  receivingSavePending,
  receivingSaveError,
  onSaveReceivingDraft,
  onCancelReceivingDraft,
  savedFlash,
}: {
  id: string;
  outcome: LineOutcome;
  line: LineClassificationRow;
  receiving: ReceivingLineDraft | null;
  editingOpen: boolean;
  onEditLine: () => void;
  onCloseEditor: () => void;
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
  onCancelCorrection: () => void;
  onCorrectionChange: (patch: Partial<CorrectionDraft>) => void;
  onSaveCorrection: () => void;
  onReceivingChange: (patch: Partial<ReceivingLineDraft>) => void;
  onReceivedQtyOrUnitChange: (patch: { receivedQuantity?: string; receivedUnit?: string }) => void;
  onInvoiceUnitChoice: (unit: string) => void;
  receivingSavePending: boolean;
  receivingSaveError: string | null;
  onSaveReceivingDraft: () => void;
  onCancelReceivingDraft: () => void;
  savedFlash?: boolean;
}) {
  const orderedQuantity = formatSourceQuantity(line);
  const provenance = deriveLineProvenance({ status: line.status, resolutionSource: line.resolutionSource, resolvedByName: line.resolvedByName, resolvedAt: line.resolvedAt });
  const toggleLabel = readOnly ? (editingOpen ? "Hide details" : "View details") : editingOpen ? "Hide line" : "Edit line";

  // ============ EXPENSE -- a quiet, clearly-labeled row, never styled
  // like an incomplete inventory line ============
  if (outcome === "expense" && !editingOpen) {
    return (
      <div id={id} className="grid grid-cols-1 gap-1.5 border-b border-zinc-800 bg-zinc-950/30 px-3 py-2.5 last:border-0 hover:bg-zinc-800/10 sm:grid-cols-[1.5fr_1.1fr_1.1fr_1.3fr_84px_112px] sm:items-center sm:gap-3">
        <p className="truncate text-sm text-zinc-300">{line.description ?? "—"}</p>
        <p className="truncate text-xs text-zinc-500 sm:col-span-2">{spendCategoryPath ?? "Uncategorized expense"}</p>
        <p className="text-xs text-zinc-500">{formatSourceQuantity(line) ?? "—"} · will not add inventory</p>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
          Expense
        </span>
        <button type="button" onClick={onEditLine} className={secondaryButtonClassCompact}>
          {toggleLabel}
        </button>
      </div>
    );
  }
  if (outcome === "expense") {
    return (
      <div id={id} className="border-b border-zinc-800 bg-zinc-950/30 p-3.5 last:border-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">{line.description ?? "—"}</p>
            <p className="mt-0.5 text-xs text-zinc-400">
              {line.vendorSku ? `Vendor SKU ${line.vendorSku}` : null}
              {orderedQuantity ? ` · Invoice quantity: ${orderedQuantity}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
              Expense — no stock
            </span>
            <button type="button" onClick={onCloseEditor} className={secondaryButtonClassCompact}>
              {toggleLabel}
            </button>
          </div>
        </div>
        {savedFlash ? <p className="mt-1 text-xs font-semibold text-emerald-400">✓ Saved</p> : null}
        <div className={`mt-3 ${inlineNeutralClass}`}>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
            <span aria-hidden>✓</span> Expense classified
          </p>
          <p className="mt-1 text-sm font-medium text-zinc-200">
            {line.description ?? "This line"} → {spendCategoryPath ?? "Uncategorized expense"}
          </p>
          <p className="mt-1 text-xs font-semibold text-zinc-300">Will not add inventory</p>
          <ProvenanceLine provenance={provenance} />
        </div>
        {!readOnly ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
            <button type="button" disabled={actionPending} onClick={onToggleOverrideForm} className={secondaryButtonClassCompact}>
              Change item match
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

  // ============ Compact table row -- the common case ============
  // A ready line, not expanded, is ONE scannable row: never three
  // repeated "complete/confirmed/ready" panels. Package/receiving
  // one-liners reuse the SAME formatters the expanded detail below uses
  // -- never a second, independently-worded summary.
  if (isComplete && !editingOpen) {
    const packageSummary = formatPackageConfirmation({
      packageQuantity: line.packageQuantity,
      resolvedInvoiceUnitCode: line.resolvedInvoiceUnitCode,
      effectivePurchaseUnitCode: line.effectivePurchaseUnitCode,
      effectiveReceivingBehavior: line.effectiveReceivingBehavior,
      effectiveConversionFactor: line.effectiveConversionFactor,
      inventoryBaseUnitCode: line.inventoryBaseUnitCode,
    });
    // FIXED_CONVERSION's block form is 3 lines (Invoice/Conversion/Inventory
    // received) meant for the expanded checklist -- the compact row instead
    // collapses it to the same "X UNIT → Y UNIT" shape as the inline
    // (SAME_UNIT) case, e.g. "2 PACK → 20 LB", so this column always reads
    // as a package conversion rather than duplicating the Receiving column.
    const packageLine = packageSummary
      ? packageSummary.mode === "inline"
        ? packageSummary.lines[0]
        : line.effectiveReceivingBehavior === "FIXED_CONVERSION" &&
            line.packageQuantity !== null &&
            line.effectiveConversionFactor &&
            line.inventoryBaseUnitCode
          ? `${line.packageQuantity} ${line.effectivePurchaseUnitCode} → ${line.packageQuantity * line.effectiveConversionFactor} ${line.inventoryBaseUnitCode}`
          : (packageSummary.lines[packageSummary.lines.length - 1] ?? packageSummary.lines[0])
      : "—";
    const locationName = receiving ? (locations.find((l) => l.id === receiving.locationId)?.name ?? "—") : "—";
    const conditionLabel = receiving ? (CONDITION_OPTIONS.find((c) => c.value === receiving.conditionStatus)?.label ?? receiving.conditionStatus) : "—";
    // FIXED_CONVERSION lines are entered in the purchase-package unit (e.g.
    // "2 PACK") but this column reports what actually lands in inventory --
    // the same converted `verifiedQuantity`/`baseUnitCode` already shown as
    // "Adds to inventory: X" in the expanded checklist below, never a
    // second, independently recomputed conversion.
    const receivedQuantityDisplay =
      receiving && receiving.info.receivingBehavior === "FIXED_CONVERSION" && receiving.verifiedQuantity.trim() !== ""
        ? `${receiving.verifiedQuantity} ${receiving.info.baseUnitCode ?? ""}`
        : receiving
          ? `${receiving.receivedQuantity} ${receiving.receivedUnit}`
          : null;

    return (
      <div id={id} tabIndex={-1} className="grid grid-cols-1 gap-1.5 border-b border-zinc-800 px-3 py-2.5 last:border-0 hover:bg-zinc-800/20 focus:outline-none sm:grid-cols-[1.5fr_1.1fr_1.1fr_1.4fr_84px_112px] sm:items-start sm:gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">{line.description ?? "—"}</p>
          <p className="truncate text-xs text-zinc-500">{line.vendorSku ? `SKU ${line.vendorSku}` : "—"}{orderedQuantity ? ` · ${orderedQuantity}` : ""}</p>
          {line.changedInAmendment ? (
            <div className="mt-1">
              <AmendmentChangedBadge previous={line.previousOrderedSummary} />
            </div>
          ) : null}
        </div>
        <p className="truncate text-sm text-zinc-300 sm:text-xs sm:uppercase sm:tracking-wide sm:text-zinc-500">
          <span className="sm:hidden">Match: </span>
          <span className="sm:normal-case sm:tracking-normal sm:text-sm sm:text-zinc-200">{line.inventoryItemName ?? "—"}</span>
        </p>
        <p className="truncate text-sm text-zinc-300">
          <span className="sm:hidden">Package: </span>
          {packageLine}
        </p>
        <div className="min-w-0 text-sm text-zinc-300">
          <span className="sm:hidden">Receiving: </span>
          {receivedQuantityDisplay ? (
            <>
              <p className="truncate">
                {receivedQuantityDisplay} · {conditionLabel}
              </p>
              <p className="truncate text-xs text-zinc-500">{locationName}</p>
            </>
          ) : (
            "—"
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Ready
        </span>
        <div className="flex items-center gap-2">
          {savedFlash ? <span className="text-[11px] font-medium text-emerald-400">Saved</span> : null}
          <button type="button" onClick={onEditLine} className={secondaryButtonClassCompact}>
            {toggleLabel}
          </button>
        </div>
      </div>
    );
  }

  // ============ Needs-attention compact row -- the specific blocking
  // check surfaces inline (never a generic "needs attention" banner and
  // never all three panels auto-expanded, which used to let more than
  // one line sit in "edit mode" at a time). ============
  if (outcome === "needs_attention" && !editingOpen) {
    const issue = describeLineIssue({
      status: line.status,
      disposition: line.disposition,
      isNewItemProposal: line.aiSuggestedIsNewProposal,
      hasPackageMismatch: line.hasPackageMismatch,
      receiving,
    });
    return (
      <div
        id={id}
        tabIndex={-1}
        className="grid grid-cols-1 gap-1.5 border-b border-l-2 border-zinc-800 border-l-amber-500 bg-amber-950/5 px-3 py-2.5 last:border-b-0 hover:bg-amber-950/10 focus:outline-none sm:grid-cols-[1.5fr_1.1fr_1.1fr_1.4fr_84px_112px] sm:items-start sm:gap-3"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">{line.description ?? "—"}</p>
          <p className="truncate text-xs text-zinc-500">{line.vendorSku ? `SKU ${line.vendorSku}` : "—"}{orderedQuantity ? ` · ${orderedQuantity}` : ""}</p>
          {line.changedInAmendment ? (
            <div className="mt-1">
              <AmendmentChangedBadge previous={line.previousOrderedSummary} />
            </div>
          ) : null}
        </div>
        <p className={`truncate text-sm ${issue?.section === "item_match" ? "font-medium text-amber-300" : "text-zinc-500"}`}>
          <span className="sm:hidden">Match: </span>
          {issue?.section === "item_match" ? issue.text : (line.inventoryItemName ?? "—")}
        </p>
        <p className={`truncate text-sm ${issue?.section === "package" ? "font-medium text-amber-300" : "text-zinc-500"}`}>
          <span className="sm:hidden">Package: </span>
          {issue?.section === "package" ? issue.text : "—"}
        </p>
        <p className={`truncate text-sm ${issue?.section === "receiving" ? "font-medium text-amber-300" : "text-zinc-500"}`}>
          <span className="sm:hidden">Receiving: </span>
          {issue?.section === "receiving" ? issue.text : "—"}
        </p>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Needs attention
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onEditLine} className={secondaryButtonClassCompact}>
            {toggleLabel}
          </button>
        </div>
      </div>
    );
  }

  const showPackageAndReceiving = itemMatchOk && line.disposition === "INVENTORY";
  const canEditReceivingHere = !readOnly && line.disposition === "INVENTORY";

  return (
    <div id={id} tabIndex={-1} className={`border-b border-zinc-800 last:border-0 focus:outline-none ${isComplete ? "" : "border-l-2 border-l-amber-500 bg-amber-950/5"}`}>
      {/* ============ Row header -- stays visible in edit mode too ============ */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-3.5 pt-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-100">{line.description ?? "—"}</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            {line.vendorSku ? `Vendor SKU ${line.vendorSku}` : null}
            {orderedQuantity ? ` · Invoice quantity: ${orderedQuantity}` : ""}
          </p>
          {line.changedInAmendment ? (
            <div className="mt-1.5">
              <AmendmentChangedBadge previous={line.previousOrderedSummary} />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isComplete ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Ready
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Needs attention
            </span>
          )}
          <button type="button" onClick={onCloseEditor} className={secondaryButtonClassCompact}>
            {toggleLabel}
          </button>
        </div>
      </div>

      {savedFlash ? <p className="px-3.5 pt-1 text-xs font-semibold text-emerald-400">✓ Saved</p> : null}

      {/* ============ ONE neutral work surface, three sections divided
          by subtle dividers -- never large colored cards. ============ */}
      <div className="mx-3.5 my-3 grid grid-cols-1 divide-y divide-zinc-800 rounded-lg border border-zinc-700 bg-zinc-950/40 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {/* A. Item match */}
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Item match</p>
            <SectionStatusDot ok={itemMatchOk} />
          </div>
          {itemMatchOk ? (
            line.disposition === "INVENTORY" ? (
              <>
                <p className="text-sm font-semibold text-zinc-100">{line.inventoryItemName ?? "—"}</p>
                <p className="text-xs text-zinc-400">
                  {line.inventoryItemNumber ? `${line.inventoryItemNumber} · ` : ""}
                  {line.inventoryCategoryName ?? "No category"}
                </p>
                <p className="text-xs text-zinc-400">Base inventory unit: {line.inventoryBaseUnitCode ?? "—"}</p>
                <ProvenanceLine provenance={provenance} />
              </>
            ) : (
              <p className="text-xs text-zinc-400">Classified as an expense.</p>
            )
          ) : (
            <>
              <p className="text-sm font-semibold text-amber-200">{line.aiSuggestedIsNewProposal ? "New item needs verification" : "No item match yet"}</p>
              {line.aiSuggestedInventoryItemId && !line.aiSuggestedIsNewProposal ? (
                <p className="text-xs text-zinc-400">
                  Suggested: {line.aiSuggestedInventoryItemName}
                  {line.aiConfidence !== null ? ` (${Math.round(line.aiConfidence * 100)}%)` : ""}
                </p>
              ) : null}
            </>
          )}
          {!readOnly ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {!itemMatchOk && line.aiSuggestedIsNewProposal ? (
                <button type="button" onClick={onReviewNewItem} className="rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-zinc-950">
                  Review new item →
                </button>
              ) : (
                <>
                  {!itemMatchOk && line.aiSuggestedInventoryItemId ? (
                    <button
                      type="button"
                      disabled={actionPending}
                      onClick={() => onApproveExisting(line.aiSuggestedInventoryItemId!)}
                      className="rounded-md border border-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 disabled:opacity-40"
                    >
                      {actionPending ? "Confirming…" : "Confirm item"}
                    </button>
                  ) : null}
                  <button type="button" disabled={actionPending} onClick={onToggleOverrideForm} className="rounded-md border border-zinc-500 px-2.5 py-1 text-[11px] text-zinc-100 disabled:opacity-40">
                    Change item match
                  </button>
                  {line.disposition === "INVENTORY" ? (
                    <button type="button" disabled={actionPending} onClick={onMarkNonInventory} className="rounded-md border border-zinc-500 px-2.5 py-1 text-[11px] text-zinc-100 disabled:opacity-40">
                      {actionPending ? "Marking…" : "Mark as expense"}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
          {overrideFormOpen && !reviewingPackage ? (
            <div className="mt-1">
              <ExistingItemOverrideForm items={items} units={units} onCancel={onToggleOverrideForm} onConfirm={onApproveExisting} />
            </div>
          ) : null}
        </div>

        {/* B. Purchase package */}
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Purchase package</p>
            <SectionStatusDot ok={packageOk} warn={itemMatchOk && line.disposition === "INVENTORY" && line.hasPackageMismatch} />
          </div>
          {!itemMatchOk || line.disposition !== "INVENTORY" ? (
            <p className="text-xs text-zinc-400">Waiting on item match.</p>
          ) : line.hasPackageMismatch ? (
            <>
              <p className="text-sm font-semibold text-red-300">Purchase package needs review</p>
              <p className="text-xs text-zinc-300">
                Invoice unit: <span className="font-semibold text-white">{line.resolvedInvoiceUnitCode}</span>
              </p>
              <p className="text-xs text-zinc-300">
                Configured unit: <span className="font-semibold text-white">{formatPurchasePackageDescription(line)}</span>
              </p>
              {!readOnly && onNavigateToStep1 ? (
                <button type="button" onClick={onNavigateToStep1} className="self-start text-[11px] font-medium text-red-300 underline underline-offset-2 hover:text-red-200">
                  Correct invoice unit
                </button>
              ) : null}
            </>
          ) : (
            <PackageChecklistBody line={line} />
          )}
          {!readOnly && showPackageAndReceiving ? (
            <button type="button" onClick={onReviewPackage} className="mt-1 self-start text-[11px] font-medium text-zinc-300 underline underline-offset-2 hover:text-zinc-100">
              Edit purchase package
            </button>
          ) : null}
          {overrideFormOpen && reviewingPackage ? (
            <div className="mt-1">
              <ExistingItemOverrideForm
                items={items}
                units={units}
                onCancel={onToggleOverrideForm}
                onConfirm={onApproveExisting}
                defaultItemId={line.inventoryItemId ?? undefined}
                defaultRegisteringPackage
              />
            </div>
          ) : null}
        </div>

        {/* C. Receiving */}
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Receiving</p>
            <SectionStatusDot ok={receivingReadyOk} />
          </div>
          {!showPackageAndReceiving ? (
            <p className="text-xs text-zinc-400">Waiting on item match.</p>
          ) : !canEditReceivingHere ? (
            receiving ? <ReceivingChecklistBody receiving={receiving} locations={locations} alreadyReceived={alreadyReceived} /> : <p className="text-xs text-zinc-400">Not yet received.</p>
          ) : alreadyReceived ? (
            correcting && correctionDraft ? (
              <>
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
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" onClick={onCancelCorrection} disabled={correctionPending} className="rounded-md border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 disabled:opacity-40">
                    Cancel
                  </button>
                  <button type="button" onClick={onSaveCorrection} disabled={correctionPending} className="rounded-md bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">
                    {correctionPending ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs text-zinc-400">Loading…</p>
            )
          ) : receiving ? (
            <>
              {needsInvoiceUnitResolution(receiving) ? (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-700 bg-amber-950/20 p-2.5">
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
                onChange={onReceivingChange}
                onReceivedQtyOrUnitChange={onReceivedQtyOrUnitChange}
              />
              {receivingSaveError ? <p className="text-xs text-red-300">{receivingSaveError}</p> : null}
              <div className="mt-1 flex items-center gap-2">
                <button type="button" onClick={onCancelReceivingDraft} disabled={receivingSavePending} className="rounded-md border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 disabled:opacity-40">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onSaveReceivingDraft}
                  disabled={receivingSavePending || receiving.receivedQuantity.trim() === ""}
                  title={receiving.receivedQuantity.trim() === "" ? "Enter a received quantity to save" : undefined}
                  className="rounded-md bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40"
                >
                  {receivingSavePending ? "Saving…" : "Save changes"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {priceComparison?.available ? (
        <p className="px-3.5 pb-3.5 text-[11px] leading-tight text-zinc-400">
          <span className="text-zinc-300">
            ${priceComparison.currentUnitCost.toFixed(2)} / {priceComparison.baseUnitCode}
          </span>
          <span className={`ml-1.5 font-medium ${priceChangeTone(priceComparison.direction).colorClass}`}>
            {priceChangeTone(priceComparison.direction).glyph} {Math.abs(priceComparison.deltaPct).toFixed(1)}%
          </span>
          <span className="ml-1 text-zinc-500">vs previous purchase</span>
        </p>
      ) : (
        <div className="pb-3.5" />
      )}
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
