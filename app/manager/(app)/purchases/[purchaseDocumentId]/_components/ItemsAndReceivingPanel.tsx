"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  getPurchaseDocumentLineClassifications,
  runItemMatchingNow,
  ensureItemMatchingStarted,
  getClassificationMatchingStatus,
  approveExistingItemClassification,
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
import { getPriceComparisons } from "@/app/actions/priceComparison";
import type { PriceComparisonResult } from "@/app/lib/purchasing/priceComparison";
import { priceChangeTone } from "@/app/lib/purchasing/priceChangePresentation";
import { formatPackageConfirmation } from "@/app/lib/purchaseDocuments/packageUnitMismatch";
import { checklistCompletion, type LineOutcome } from "@/app/lib/purchaseDocuments/combinedLineReadiness";
import { evaluateLineReadiness, summarizeLineReadiness, issueCountLabel, type LineReadiness } from "@/app/lib/purchaseDocuments/lineReadiness";
import { readinessInputFromRow } from "@/app/lib/purchaseDocuments/readinessInputFromRow";
import { LINE_TREATMENT_LABEL, CREDIT_SUBTYPE_LABEL, signedLineAmount } from "@/app/lib/purchaseDocuments/lineTreatment";
import { formatMoney } from "@/app/lib/formatMoney";
import { ClassifyLineDrawer } from "./ClassifyLineDrawer";
import {
  receivingLineIsReady,
  missingReceivingReason,
} from "@/app/lib/purchaseDocuments/itemsAndReceivingCardState";
import { deriveLineProvenance } from "@/app/lib/purchaseDocuments/lineProvenance";
import { describeLineIssue } from "@/app/lib/purchaseDocuments/lineIssueSummary";
import { getAmendmentAlreadyPosted, getPurchaseDocumentPostingBlockers } from "@/app/actions/purchaseDocuments";
import { getPurchaseDocumentPriceReviewAction, acknowledgePriceChangeAction, type LinePriceReviewView } from "@/app/actions/priceReview";
import { priceCheckDisplay, priceReviewIsNotable, type PriceCheckDisplay } from "@/app/lib/purchasing/priceReviewPolicy";
import { PriceReviewCard } from "./PriceReviewCard";
import { LineActionDrawer } from "./LineActionDrawer";
import { DeliveryResolver } from "./DeliveryResolver";
import { PostedDeliveryConflictHandoff } from "./PostedDeliveryConflictHandoff";
import { getDeliveryResolution } from "@/app/actions/deliveryResolution";
import type { DeliveryResolutionData } from "@/app/lib/purchaseDocuments/deliveryResolution";
import { applyPatchToSelected, deriveLineActionScopes, drawerIsDirty, lineIsBulkSelectable } from "@/app/lib/purchaseDocuments/lineBulkAndDrawer";
import { deriveCompactRowView, type CompactRowView, type RowReceivingBehavior } from "@/app/lib/purchaseDocuments/lineRowPresentation";
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
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, inlineWarningClass } from "@/app/components/manager/surfaces";
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
  // Only an unmatched INVENTORY PURCHASE is ever a "new item". Expenses,
  // tax, credits, discounts and fees never enter New Items Found.
  if (line.lineTreatment !== "INVENTORY_PURCHASE") return null;
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


/** A smaller "Edit details" affordance sized for a table row -- the
 * shared secondaryButtonClass's h-9 height is right for a toolbar, but
 * too tall to sit inline in a compact ~52px row. */
const secondaryButtonClassCompact =
  "inline-flex h-7 items-center justify-center rounded-md border border-zinc-600 px-2.5 text-xs font-medium leading-none text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";

export function ItemsAndReceivingPanel({
  purchaseDocumentId,
  vendorName,
  currency = null,
  focusLineKey = null,
  readOnly,
  onChange,
  onAllResolvedChange,
  onProgressChange,
  onContinue,
  onNavigateToStep1,
}: {
  purchaseDocumentId: string;
  vendorName?: string | null;
  currency?: string | null;
  /** ?line= deep link -- opened once after the first load. */
  focusLineKey?: string | null;
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
   * mismatch warning -- jumps back to Step 1 (optionally to a line). */
  onNavigateToStep1?: (lineKey?: string) => void;
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
  // Delivery-lineage resolution (ambiguous recorded deliveries) -- fetched
  // alongside the lines; when AMBIGUOUS, the resolver is shown first in Step 2.
  const [deliveryResolution, setDeliveryResolution] = useState<DeliveryResolutionData | null>(null);
  const [deliveryResolutionReloadKey, setDeliveryResolutionReloadKey] = useState(0);
  const [priceComparisons, setPriceComparisons] = useState<Record<string, PriceComparisonResult>>({});
  const [matchingPhase, setMatchingPhase] = useState<"blocking" | "stillActive" | "failed" | "stuck" | null>(null);
  const matchingRunToken = useRef(0);
  const hasAutoAttempted = useRef(false);

  // Exactly one line editable at a time: null means every row is
  // collapsed to its compact summary; a lineKey means that ONE row shows
  // the full inline editor (Item Match / Purchase Package / Receiving),
  // never more than one simultaneously.
  const [editingLineKey, setEditingLineKey] = useState<string | null>(null);
  // Once the manager intentionally closes the auto-opened correction drawer,
  // it is not auto-reopened for the rest of the session (they can still open
  // any line by hand). Cleared the moment they open a line themselves, so
  // auto-advance to the next unresolved line resumes from there.
  const [drawerDismissed, setDrawerDismissed] = useState(false);
  // The editing line's receiving draft AT THE MOMENT the editor opened --
  // the only way "Cancel restores the persisted values" can be honest,
  // since receivingLineState itself is live/shared with every other
  // consumer (bulk actions, the compact row, Continue's own batch
  // submit) and can't just be rolled back wholesale.
  const [receivingDraftSnapshot, setReceivingDraftSnapshot] = useState<ReceivingLineDraft | null>(null);
  const [receivingSavePending, setReceivingSavePending] = useState(false);
  const [receivingSaveError, setReceivingSaveError] = useState<string | null>(null);
  // Triage-first layout, but every group stays VISIBLE and EXPANDED by
  // default so a manager can inspect the AI's decisions across the whole
  // invoice at a glance -- Ready and Non-inventory are no longer hidden just
  // because a blocker exists. The collapse controls remain for tidying up.
  const [readyOpen, setReadyOpen] = useState(true);
  const [returnsOpen, setReturnsOpen] = useState(true);
  const [creditsOpen, setCreditsOpen] = useState(true);
  const [taxesOpen, setTaxesOpen] = useState(true);
  // The shared "Classify invoice line" drawer (non-inventory treatments,
  // unresolved lines, and "Change classification" on an inventory line).
  const [classifyingLineKey, setClassifyingLineKey] = useState<string | null>(null);
  const focusConsumed = useRef(false);
  // Step 2 line filter. "all" shows the exception-first grouped view (Needs
  // attention -> Ready -> Non-inventory); a specific filter shows a flat
  // matching list. Visibility only -- never changes readiness/section state.
  type LineFilter = "all" | "needs_attention" | "price_changes" | "ready" | "expenses";
  const [lineFilter, setLineFilter] = useState<LineFilter>("all");
  const [lineFilterTouched, setLineFilterTouched] = useState(false);
  const [expensesOpen, setExpensesOpen] = useState(true);
  const [bulkLocationId, setBulkLocationId] = useState("");
  const [bulkConditionValue, setBulkConditionValue] = useState<ReceivingLineDraft["conditionStatus"]>("RECEIVED_AS_INVOICED");
  // Selection-based bulk: only eligible inventory lines may be selected, and
  // bulk only ever sets location/condition -- never matches, units, packages,
  // factors, measured quantities, prices, acknowledgments, or expenses.
  const [selectedLineKeys, setSelectedLineKeys] = useState<Set<string>>(new Set());
  const toggleLineSelected = (lineKey: string) =>
    setSelectedLineKeys((prev) => {
      const next = new Set(prev);
      if (next.has(lineKey)) next.delete(lineKey);
      else next.add(lineKey);
      return next;
    });
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
  /** lineKey -> the authoritative posting-scan reason it would be refused
   * (get_purchase_document_posting_blockers) -- the SAME check posting
   * enforces, so a line can no longer read "Ready" here and fail at post. */
  const [postingBlockersByLineKey, setPostingBlockersByLineKey] = useState<Map<string, string>>(new Map());
  // Vendor-aware price review. A REQUIRES_ACKNOWLEDGMENT line is a blocking
  // issue (folded into the same readiness the footer/stepper read); an
  // informational change is surfaced but never blocks.
  const [priceReviewByLineKey, setPriceReviewByLineKey] = useState<Map<string, LinePriceReviewView>>(new Map());
  const [priceRequiresAck, setPriceRequiresAck] = useState<Set<string>>(new Set());
  const [priceInformationalCount, setPriceInformationalCount] = useState(0);
  const [acknowledgingLineKey, setAcknowledgingLineKey] = useState<string | null>(null);

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
      postingBlockersResult,
      priceReviewResult,
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
      getPurchaseDocumentPostingBlockers(purchaseDocumentId),
      getPurchaseDocumentPriceReviewAction(purchaseDocumentId),
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
    if (postingBlockersResult.ok) setPostingBlockersByLineKey(new Map(postingBlockersResult.blockers.map((b) => [b.lineKey, b.reason])));
    if (priceReviewResult.ok) {
      setPriceReviewByLineKey(new Map(priceReviewResult.lines.map((l) => [l.lineKey, l])));
      setPriceRequiresAck(new Set(priceReviewResult.requiresAckLineKeys));
      setPriceInformationalCount(priceReviewResult.informationalCount);
    }

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

  function handleSetLocationForSelected() {
    if (!bulkLocationId || selectedLineKeys.size === 0) return;
    setReceivingLineState((prev) => applyPatchToSelected(prev, selectedLineKeys, { locationId: bulkLocationId }));
  }

  function handleSetConditionForSelected() {
    if (selectedLineKeys.size === 0) return;
    setReceivingLineState((prev) => applyPatchToSelected(prev, selectedLineKeys, { conditionStatus: bulkConditionValue }));
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
      // Deterministic per document: the PRIMARY delivery has one stable identity,
      // so re-recording it across sessions/refreshes/double-clicks converges on
      // the same receipt (record_receipt returns the existing one) instead of
      // creating a duplicate DELIVERY. A genuine additional delivery is a
      // separate, explicit action with its own fresh identity.
      idempotencyKey: `primary-delivery:${purchaseDocumentId}`,
      // receipts.delivery_event_id is a uuid (20260811100171): the document's
      // own id IS the stable identity of its primary delivery (one per
      // document; a genuine additional delivery gets a fresh uuid).
      deliveryEventId: purchaseDocumentId,
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
    // A manager opening a line by hand clears any earlier dismissal, so
    // auto-advance to the next unresolved line resumes from this point.
    setDrawerDismissed(false);
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
    // Intentional close: don't auto-reopen for the rest of the session.
    setDrawerDismissed(true);
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

  async function handleAcknowledgePrice(lineKey: string, note: string) {
    if (acknowledgingLineKey) return;
    setAcknowledgingLineKey(lineKey);
    setError(null);
    const result = await acknowledgePriceChangeAction(purchaseDocumentId, lineKey, note.trim() || null);
    setAcknowledgingLineKey(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Re-run authoritative readiness + price review immediately.
    await load();
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
  // Lines whose delivery lineage is AMBIGUOUS (deliveryResolution is non-null
  // only in that state). These can never read "Ready" -- they are delivery
  // conflicts that gate posting until resolved (GA080), and they drive the
  // "Delivery conflict" label + counts consistently across the whole step.
  const deliveryConflictKeys = new Set(deliveryResolution?.affectedLineKeys ?? []);
  const combinedLines = (lines ?? []).map((line) => {
    const receiving = receivingByLineKey.get(line.lineKey) ?? null;
    const receivingReady = line.disposition === "INVENTORY" && line.status === "CONFIRMED" ? Boolean(receiving && receivingLineIsReady(receiving)) : null;
    const postingBlockerReason = line.lineKey !== null ? (postingBlockersByLineKey.get(line.lineKey) ?? null) : null;
    const hasDeliveryConflict = line.lineKey !== null && deliveryConflictKeys.has(line.lineKey);
    // THE authoritative per-line readiness (lineReadiness.ts) -- the same
    // evaluation Step 1, Step 3 and the wizard read; an unacknowledged
    // significant price change is folded in here so the footer, stepper
    // and Step 3 gate can never disagree.
    const readiness: LineReadiness = evaluateLineReadiness(
      readinessInputFromRow(line, {
        receivingReady,
        hasPostingBlocker: postingBlockerReason !== null,
        hasDeliveryConflict,
        priceRequiresAck: priceRequiresAck.has(line.lineKey),
        inventoryIncrease: receiving
          ? {
              quantity: receiving.verifiedQuantity.trim() !== "" ? Number(receiving.verifiedQuantity) : receiving.info.receivingBehavior === "SAME_UNIT" && receiving.receivedQuantity.trim() !== "" ? Number(receiving.receivedQuantity) : null,
              unitCode: receiving.info.baseUnitCode,
            }
          : null,
      })
    );
    const outcome: LineOutcome = !readiness.ready ? "needs_attention" : readiness.treatment === "INVENTORY_PURCHASE" ? "ready" : "expense";
    return { line, receiving, outcome, readiness, postingBlockerReason, hasDeliveryConflict };
  });
  const readinessSummary = summarizeLineReadiness(combinedLines.map((c) => c.readiness));
  const summary = {
    totalLines: readinessSummary.totalLines,
    readyCount: combinedLines.filter((c) => c.outcome === "ready").length,
    needsAttentionCount: readinessSummary.needsAttentionCount,
    expenseCount: combinedLines.filter((c) => c.outcome === "expense").length,
    allResolved: readinessSummary.allReady,
  };
  const stepNeedsAttentionCount = summary.needsAttentionCount;
  const stepResolved = summary.allResolved;

  useEffect(() => {
    if (lines === null) return; // nothing loaded yet -- never report a premature "0 of 0"
    onProgressChange?.({ readyCount: summary.readyCount, totalLines: summary.totalLines, expenseCount: summary.expenseCount, needsAttentionCount: stepNeedsAttentionCount });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines === null, summary.readyCount, summary.totalLines, summary.expenseCount, stepNeedsAttentionCount, onProgressChange]);

  useEffect(() => {
    if (lines === null) return;
    onAllResolvedChange?.(stepResolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines === null, stepResolved, onAllResolvedChange]);

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

  // PROBLEM 1: take the manager straight to the first thing that needs fixing.
  // When Step 2 loads (or after a line is resolved) with an unresolved
  // operational line and nothing already open, auto-open that line's
  // correction drawer and scroll it into view -- no "Go to first issue" /
  // "View details" / "Resolve issue" click required. New-item proposals keep
  // their dedicated review modal, so we defer to it when present. An intentional
  // close (drawerDismissed) suppresses re-opening; because the effect no-ops
  // whenever a line is already open, ordinary rerenders never cause a focus loop
  // or unexpected scroll. (Placed before the loading early-return so it is never
  // conditionally called.)
  const firstUnresolvedKey = combinedLines.find((c) => c.outcome === "needs_attention")?.line.lineKey ?? null;
  useEffect(() => {
    if (readOnly || drawerDismissed) return;
    if (editingLineKey !== null || classifyingLineKey !== null || showNewItemModal || newItemCandidates.length > 0) return;
    // A ?line= deep link wins over the first-issue default, once.
    if (focusLineKey && !focusConsumed.current && lines !== null) {
      focusConsumed.current = true;
      const target = combinedLines.find((c) => c.line.lineKey === focusLineKey);
      if (target) {
        // Deliberate open-on-deep-link: this effect is the one place the
        // ?line= parameter turns into an open editor, once.
        if (target.line.lineTreatment === "INVENTORY_PURCHASE" && target.readiness.status !== "needs_classification") {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          void handleEditLine(focusLineKey);
        } else {
          setClassifyingLineKey(focusLineKey);
        }
        requestAnimationFrame(() => document.getElementById(`classification-line-${focusLineKey}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
        return;
      }
    }
    if (firstUnresolvedKey === null) return;
    const firstUnresolved = combinedLines.find((c) => c.line.lineKey === firstUnresolvedKey);
    if (firstUnresolved && (firstUnresolved.line.lineTreatment !== "INVENTORY_PURCHASE" || firstUnresolved.readiness.status === "needs_classification")) {
      // Non-inventory / unclassified: the classification drawer is the
      // resolving control -- open it and focus it, no discovery click.
      setClassifyingLineKey(firstUnresolvedKey);
      requestAnimationFrame(() => document.getElementById(`classification-line-${firstUnresolvedKey}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
      return;
    }
    void handleEditLine(firstUnresolvedKey);
    requestAnimationFrame(() => document.getElementById(`classification-line-${firstUnresolvedKey}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    // handleEditLine is a stable-enough closure; re-running only when the gate
    // conditions change is exactly what we want (open once, then no-op).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, drawerDismissed, editingLineKey, classifyingLineKey, showNewItemModal, newItemCandidates.length, firstUnresolvedKey, focusLineKey, lines === null]);

  // Fetch the delivery-lineage resolution state whenever the lines (re)load or a
  // resolution is saved. Only the AMBIGUOUS state surfaces the resolver.
  useEffect(() => {
    if (lines === null) return;
    let cancelled = false;
    getDeliveryResolution(purchaseDocumentId).then((r) => {
      if (cancelled) return;
      setDeliveryResolution(r.ok && r.data.status === "AMBIGUOUS" ? r.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, [purchaseDocumentId, lines, deliveryResolutionReloadKey]);

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

  // Exception-first groups (lineReadiness.ts's READINESS_GROUP_ORDER):
  // Needs attention -> Ready inventory -> Inventory returns -> Expenses ->
  // Credits & adjustments -> Taxes & charges. An unacknowledged significant
  // price change is a needs-attention line rendered as its own review card.
  const attentionLines = combinedLines.filter((c) => c.outcome === "needs_attention" && !(c.line.lineKey && priceRequiresAck.has(c.line.lineKey)));
  const readyLines = combinedLines.filter((c) => c.readiness.ready && c.readiness.group === "inventory");
  const returnLines = combinedLines.filter((c) => c.readiness.ready && c.readiness.group === "inventory_return");
  const expenseLines = combinedLines.filter((c) => c.readiness.ready && c.readiness.group === "expense");
  const creditLines = combinedLines.filter((c) => c.readiness.ready && c.readiness.group === "credit_adjustment");
  const taxLines = combinedLines.filter((c) => c.readiness.ready && c.readiness.group === "tax_charge");
  const nonInventoryLines = [...returnLines, ...expenseLines, ...creditLines, ...taxLines];
  const priceAckLines = combinedLines
    .filter((c) => c.line.lineKey && priceRequiresAck.has(c.line.lineKey))
    .map((c) => ({ line: c.line, review: priceReviewByLineKey.get(c.line.lineKey!) ?? null }))
    .filter((x): x is { line: (typeof combinedLines)[number]["line"]; review: LinePriceReviewView } => x.review !== null);

  // The single blocking-issue count and completion verdict the footer,
  // stepper and Step 3 gate all read: operational needs-attention lines
  // PLUS unacknowledged significant price changes.
  const blockingIssueCount = summary.needsAttentionCount;
  const stepAllResolved = summary.allResolved;
  // How many of the needs-attention lines are delivery conflicts (a subset of
  // needsAttentionCount, never added on top of it -- keeps counts consistent).
  const deliveryConflictCount = combinedLines.filter((c) => c.hasDeliveryConflict).length;

  // The ordered list of unresolved operational lines the correction drawer
  // navigates with Previous/Next. (Unacknowledged price changes are handled by
  // their own PriceReviewCard, not this drawer.)
  const unresolvedLineKeys = attentionLines.map((c) => c.line.lineKey).filter((k): k is string => k !== null);
  const currentIssueIndex = editingLineKey ? unresolvedLineKeys.indexOf(editingLineKey) : -1;
  const navigateIssue = (dir: "prev" | "next") => {
    if (unresolvedLineKeys.length === 0) return;
    const from = currentIssueIndex === -1 ? 0 : currentIssueIndex;
    const next = dir === "next" ? Math.min(from + 1, unresolvedLineKeys.length - 1) : Math.max(from - 1, 0);
    const key = unresolvedLineKeys[next];
    if (key && key !== editingLineKey) {
      void handleEditLine(key);
      requestAnimationFrame(() => document.getElementById(`classification-line-${key}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    }
  };


  // "Price changes" filter membership: any comparable, notable change
  // (informational OR significant, acknowledged or not). Excludes
  // no-material-change, expenses, not-applicable, and no-comparable-history.
  const isPriceChangeLine = (lineKey: string | null): boolean => {
    if (lineKey === null) return false;
    const review = priceReviewByLineKey.get(lineKey);
    return review ? priceReviewIsNotable(review.state) : false;
  };
  const priceChangeLines = combinedLines.filter((c) => isPriceChangeLine(c.line.lineKey));
  // Default is ALWAYS the grouped "All" view so every group (Needs attention,
  // Ready, Non-inventory) stays visible even when a blocker exists -- the
  // manager can still inspect the AI's decisions across the whole invoice.
  // Auto-open (below) brings the first blocker's drawer up without hiding the
  // rest. A filter the manager picks sticks and only changes visibility.
  const effectiveFilter = lineFilterTouched ? lineFilter : "all";
  const filterCounts = {
    all: combinedLines.length,
    needs_attention: blockingIssueCount,
    price_changes: priceChangeLines.length,
    ready: readyLines.length,
    expenses: nonInventoryLines.length,
  };
  const filteredLines =
    effectiveFilter === "needs_attention"
      ? [...attentionLines, ...priceAckLines.map((p) => combinedLines.find((c) => c.line.lineKey === p.line.lineKey)!)]
      : effectiveFilter === "price_changes"
        ? priceChangeLines
        : effectiveFilter === "ready"
          ? readyLines
          : effectiveFilter === "expenses"
            ? nonInventoryLines
            : combinedLines;

  const priceCheckFor = (lineKey: string | null): PriceCheckDisplay | null => {
    if (lineKey === null) return null;
    const review = priceReviewByLineKey.get(lineKey);
    if (!review) return null;
    const c = review.comparison;
    return priceCheckDisplay(review.state, c ? { direction: c.direction, deltaPct: c.deltaPct, vendorName: c.previous.vendorName } : null);
  };

  const renderLine = ({ line, receiving, outcome, readiness, postingBlockerReason, hasDeliveryConflict }: (typeof combinedLines)[number]) => (
    <LineCard
      key={line.lineKey}
      id={`classification-line-${line.lineKey}`}
      outcome={outcome}
      readiness={readiness}
      currency={currency}
      onClassify={() => {
        if (editingLineKey) handleCloseEditor(editingLineKey);
        setDrawerDismissed(false);
        setClassifyingLineKey(line.lineKey);
      }}
      deliveryConflict={hasDeliveryConflict}
      line={line}
      receiving={receiving}
      priceCheck={priceCheckFor(line.lineKey)}
      selectable={lineIsBulkSelectable(line, readOnly)}
      selected={line.lineKey !== null && selectedLineKeys.has(line.lineKey)}
      onToggleSelected={() => line.lineKey && toggleLineSelected(line.lineKey)}
      postingBlockerReason={postingBlockerReason}
      editingOpen={editingLineKey === line.lineKey}
      onEditLine={() => handleEditLine(line.lineKey)}
      onCloseEditor={() => handleCloseEditor(line.lineKey)}
      onNavigateIssue={navigateIssue}
      issuePosition={
        line.lineKey && unresolvedLineKeys.includes(line.lineKey)
          ? { index: unresolvedLineKeys.indexOf(line.lineKey), total: unresolvedLineKeys.length }
          : null
      }
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
  );

  return (
    <div className="mt-3 flex flex-col gap-3">
      {matchingBanner}
      {error && !matchingBanner ? <p className="rounded-lg border border-red-800 bg-red-950/20 p-3 text-sm text-red-300">{error}</p> : null}

      {/* Ambiguous delivery lineage: resolve first (shown above the groups; the
          Ready/Non-inventory sections stay visible below). */}
      {!readOnly && deliveryResolution ? (
        <DeliveryResolver
          purchaseDocumentId={purchaseDocumentId}
          data={deliveryResolution}
          onResolved={() => {
            setDeliveryResolution(null);
            setDeliveryResolutionReloadKey((k) => k + 1);
            void load();
          }}
        />
      ) : null}

      {/* §4: an ambiguous document already posted its duplicate inventory --
          cannot be resolved by exclusion; hand off to the audited correction. */}
      <PostedDeliveryConflictHandoff
        purchaseDocumentId={purchaseDocumentId}
        onCorrected={() => { setDeliveryResolutionReloadKey((k) => k + 1); void load(); }}
      />

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
            <span className="text-xs text-zinc-500">{summary.totalLines} line{summary.totalLines === 1 ? "" : "s"}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* "Go to first issue" removed: Step 2 now auto-opens the first
                unresolved line's correction drawer and scrolls to it, so no
                jump control is needed. */}
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

        {/* ============ PROGRESS METER -- one glance replaces a repeated
            per-row Status column: how much of the document is done and
            what's left, colored by meaning. ============ */}
        {summary.totalLines > 0 ? (
          <div className="mt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-200 tabular-nums">
                  {summary.totalLines} line{summary.totalLines === 1 ? "" : "s"} · {summary.needsAttentionCount} needs attention · {summary.readyCount} ready inventory
                  {returnLines.length > 0 ? ` · ${returnLines.length} return${returnLines.length === 1 ? "" : "s"}` : ""} · {expenseLines.length} expense{expenseLines.length === 1 ? "" : "s"}
                  {creditLines.length > 0 ? ` · ${creditLines.length} credit${creditLines.length === 1 ? "" : "s"}/adjustment${creditLines.length === 1 ? "" : "s"}` : ""}
                  {taxLines.length > 0 ? ` · ${taxLines.length} tax/charge${taxLines.length === 1 ? "" : "s"}` : ""}
                </p>
                {deliveryConflictCount > 0 ? (
                  <p className="mt-0.5 text-xs font-semibold text-red-300 tabular-nums">
                    {deliveryConflictCount} delivery conflict{deliveryConflictCount === 1 ? "" : "s"} — resolve the recorded deliveries before these lines can post
                  </p>
                ) : null}
                {blockingIssueCount > 0 ? (
                  <p className="mt-0.5 text-xs font-medium text-amber-300 tabular-nums">
                    {blockingIssueCount} issue{blockingIssueCount === 1 ? "" : "s"} must be resolved before Review &amp; Post
                  </p>
                ) : stepAllResolved ? (
                  <p className="mt-0.5 text-xs font-medium text-emerald-300 tabular-nums">
                    ✓ {summary.totalLines} lines complete · {summary.readyCount} inventory · {summary.expenseCount} non-inventory · Ready for Review &amp; Post
                  </p>
                ) : null}
              </div>
              {!readOnly && (newItemCandidates.length > 0 || bulkEligible.length > 0) ? (
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
            <div className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full bg-zinc-800" role="img" aria-label={`${summary.needsAttentionCount} need attention, ${summary.readyCount} ready, ${summary.expenseCount} expenses`}>
              <span className="h-full bg-emerald-400 transition-[width] duration-500" style={{ width: `${(summary.readyCount / summary.totalLines) * 100}%` }} />
              <span className="h-full bg-amber-400 transition-[width] duration-500" style={{ width: `${(summary.needsAttentionCount / summary.totalLines) * 100}%` }} />
              <span className="h-full bg-zinc-600 transition-[width] duration-500" style={{ width: `${(summary.expenseCount / summary.totalLines) * 100}%` }} />
            </div>
          </div>
        ) : null}

        {/* Selection-based bulk lives in its own toolbar below (shown only
            once eligible inventory rows are selected) -- no always-on
            "apply to all" inputs here. */}
        </div>
      </div>

      {/* ============ SELECTION BULK TOOLBAR -- appears only when eligible
          inventory rows are selected; sets location/condition on exactly
          those rows, never any protected field, never expenses, never a
          price acknowledgment. ============ */}
      {!readOnly && selectedLineKeys.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-700/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
          <span className="font-semibold">{selectedLineKeys.size} inventory line{selectedLineKeys.size === 1 ? "" : "s"} selected</span>
          <span className="mx-1 text-amber-700">·</span>
          <select value={bulkLocationId} onChange={(e) => setBulkLocationId(e.target.value)} aria-label="Bulk location" className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white">
            <option value="">Location…</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleSetLocationForSelected} disabled={!bulkLocationId} title={!bulkLocationId ? "Choose a location first" : `Apply to ${selectedLineKeys.size} selected line${selectedLineKeys.size === 1 ? "" : "s"}`} className={secondaryButtonClassCompact}>
            Set location
          </button>
          <select value={bulkConditionValue} onChange={(e) => setBulkConditionValue(e.target.value as ReceivingLineDraft["conditionStatus"])} aria-label="Bulk condition" className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white">
            {CONDITION_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleSetConditionForSelected} title={`Apply to ${selectedLineKeys.size} selected line${selectedLineKeys.size === 1 ? "" : "s"}`} className={secondaryButtonClassCompact}>
            Set condition
          </button>
          <button type="button" onClick={() => setSelectedLineKeys(new Set())} className="ml-auto text-amber-300 underline underline-offset-2">
            Clear selection
          </button>
        </div>
      ) : null}

      {/* ============ FILTERS -- visibility only; never change readiness,
          acknowledgment, or price-review state. "All" keeps the
          exception-first grouped view; any other filter shows a flat list.
          "Price changes" = every comparable notable change (informational
          + significant, acknowledged or not). ============ */}
      {summary.totalLines > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {(["all", "needs_attention", "price_changes", "ready", "expenses"] as LineFilter[]).map((f) => {
            const label = f === "all" ? "All" : f === "needs_attention" ? "Needs attention" : f === "price_changes" ? "Price changes" : f === "ready" ? "Ready inventory" : "Expenses & adjustments";
            return (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setLineFilter(f);
                  setLineFilterTouched(true);
                }}
                aria-pressed={effectiveFilter === f}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium ${effectiveFilter === f ? "border-amber-500 bg-amber-950/30 text-amber-200" : "border-zinc-700 text-zinc-300 hover:text-zinc-100"}`}
              >
                {label} ({filterCounts[f]})
              </button>
            );
          })}
        </div>
      ) : null}

      {effectiveFilter !== "all" ? (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-zinc-300">
              {effectiveFilter === "needs_attention" ? "Needs attention" : effectiveFilter === "price_changes" ? "Price changes" : effectiveFilter === "ready" ? "Ready inventory" : "Expenses & adjustments"}
            </h3>
            <span className="text-xs text-zinc-500">{filteredLines.length} line{filteredLines.length === 1 ? "" : "s"}</span>
          </div>
          {effectiveFilter === "price_changes" && priceAckLines.length > 0 ? (
            <div className="mb-3 flex flex-col gap-3">
              {priceAckLines.map(({ line, review }) => (
                <PriceReviewCard
                  key={line.lineKey}
                  id={`price-review-${line.lineKey}`}
                  invoiceDescription={line.description}
                  review={review}
                  pending={acknowledgingLineKey === line.lineKey}
                  onAcknowledge={(note) => handleAcknowledgePrice(line.lineKey, note)}
                  priceHistoryHref={line.inventoryItemId ? `/manager/inventory/items/${line.inventoryItemId}?tab=price-history` : null}
                />
              ))}
            </div>
          ) : null}
          {filteredLines.length > 0 ? (
            <div className={panelClass}>{filteredLines.map(renderLine)}</div>
          ) : (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-6 text-center text-sm text-zinc-500">No lines match this filter.</p>
          )}
        </section>
      ) : (
      <>
      {/* ============ NEEDS YOU -- the point of the screen: the lines that
          can't post yet, always shown, amber, at the top. ============ */}
      {blockingIssueCount > 0 ? (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden className="h-2 w-2 rounded-full bg-amber-400" />
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-amber-300">Needs you</h3>
            <span className="text-xs text-zinc-500">
              {blockingIssueCount} issue{blockingIssueCount === 1 ? "" : "s"} must be resolved before Review &amp; Post
            </span>
          </div>
          {attentionLines.length > 0 ? <div className={`${panelClass} border-l-2 border-l-amber-500`}>{attentionLines.map(renderLine)}</div> : null}
          {priceAckLines.length > 0 ? (
            <div className="mt-3 flex flex-col gap-3">
              {priceAckLines.map(({ line, review }) => (
                <PriceReviewCard
                  key={line.lineKey}
                  id={`price-review-${line.lineKey}`}
                  invoiceDescription={line.description}
                  review={review}
                  pending={acknowledgingLineKey === line.lineKey}
                  onAcknowledge={(note) => handleAcknowledgePrice(line.lineKey, note)}
                  priceHistoryHref={line.inventoryItemId ? `/manager/inventory/items/${line.inventoryItemId}?tab=price-history` : null}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : summary.totalLines > 0 ? (
        <section>
          <div className="flex items-center gap-2 rounded-xl border border-emerald-800/60 bg-emerald-950/20 px-4 py-3">
            <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
            <p className="text-sm font-medium text-emerald-200">
              All {summary.totalLines} lines confirmed — ready to continue.
              {priceInformationalCount > 0 ? ` · ${priceInformationalCount} price change${priceInformationalCount === 1 ? "" : "s"} noted` : ""}
            </p>
          </div>
        </section>
      ) : null}

      {/* ============ READY INVENTORY ============ */}
      <LineGroupSection
        title="Ready inventory"
        count={readyLines.length}
        noun="inventory line"
        tone="success"
        open={readyOpen}
        onToggle={() => setReadyOpen((v) => !v)}
        blurb="These lines will add stock when the invoice is posted."
      >
        {readyLines.map(renderLine)}
      </LineGroupSection>

      {/* ============ INVENTORY RETURNS ============ */}
      <LineGroupSection
        title="Inventory returns"
        count={returnLines.length}
        noun="return"
        tone="info"
        open={returnsOpen}
        onToggle={() => setReturnsOpen((v) => !v)}
        blurb="Tracked merchandise that physically left the store. Posting records an audited inventory decrease."
      >
        {returnLines.map(renderLine)}
      </LineGroupSection>

      {/* ============ EXPENSES ============ */}
      <LineGroupSection
        title="Expenses"
        count={expenseLines.length}
        noun="line"
        tone="neutral"
        open={expensesOpen}
        onToggle={() => setExpensesOpen((v) => !v)}
        blurb="These lines are classified as expenses or freight/fees and will not add inventory."
      >
        {expenseLines.map(renderLine)}
      </LineGroupSection>

      {/* ============ CREDITS & ADJUSTMENTS ============ */}
      <LineGroupSection
        title="Credits & adjustments"
        count={creditLines.length}
        noun="line"
        tone="info"
        open={creditsOpen}
        onToggle={() => setCreditsOpen((v) => !v)}
        blurb="Credits and discounts reduce the invoice total. They do not affect inventory unless physical stock leaves the store."
      >
        {creditLines.map(renderLine)}
      </LineGroupSection>

      {/* ============ TAXES & CHARGES ============ */}
      <LineGroupSection
        title="Taxes & charges"
        count={taxLines.length}
        noun="line"
        tone="neutral"
        open={taxesOpen}
        onToggle={() => setTaxesOpen((v) => !v)}
        blurb="Document-level tax. Not an item, no expense category, no inventory effect."
      >
        {taxLines.map(renderLine)}
      </LineGroupSection>
      </>
      )}

      {!readOnly ? (
        <ClassifyLineDrawer
          open={classifyingLineKey !== null}
          line={classifyingLineKey ? (lines.find((l) => l.lineKey === classifyingLineKey) ?? null) : null}
          purchaseDocumentId={purchaseDocumentId}
          currency={currency}
          spendCategories={spendCategories}
          items={items}
          units={units}
          locations={locations}
          documentLines={lines.map((l) => ({ lineKey: l.lineKey, description: l.description }))}
          onSaved={async (lineKey) => {
            flashSaved(lineKey);
            setClassifyingLineKey(null);
            await load();
            focusRow(lineKey);
          }}
          onRequestClose={() => {
            setDrawerDismissed(true);
            setClassifyingLineKey(null);
          }}
          onChangeItemMatch={(lineKey) => {
            setClassifyingLineKey(null);
            void handleEditLine(lineKey);
            setOverrideFormLineKey(lineKey);
          }}
          onPrev={(() => {
            const idx = classifyingLineKey ? unresolvedLineKeys.indexOf(classifyingLineKey) : -1;
            return idx > 0 ? () => setClassifyingLineKey(unresolvedLineKeys[idx - 1]) : undefined;
          })()}
          onNext={(() => {
            const idx = classifyingLineKey ? unresolvedLineKeys.indexOf(classifyingLineKey) : -1;
            return idx >= 0 && idx < unresolvedLineKeys.length - 1 ? () => setClassifyingLineKey(unresolvedLineKeys[idx + 1]) : undefined;
          })()}
          navLabel={(() => {
            const idx = classifyingLineKey ? unresolvedLineKeys.indexOf(classifyingLineKey) : -1;
            return idx >= 0 && unresolvedLineKeys.length > 1 ? `Issue ${idx + 1} of ${unresolvedLineKeys.length}` : undefined;
          })()}
        />
      ) : null}

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
          contextLabel={
            stepAllResolved
              ? `${summary.totalLines} line${summary.totalLines === 1 ? "" : "s"} complete · ${summary.readyCount} inventory · ${summary.expenseCount} non-inventory`
              : issueCountLabel(blockingIssueCount)
          }
          contextTone={stepAllResolved ? "neutral" : "warning"}
          primaryLabel="Continue to Review & Post"
          onPrimary={handleContinue}
          primaryDisabled={!stepAllResolved}
          primaryPending={continuePending}
          primaryPendingLabel="Saving…"
          primaryTitle={!stepAllResolved ? `Resolve the blocking issue${blockingIssueCount === 1 ? "" : "s"} to continue` : undefined}
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

/** The Price Check badge -- vendor-aware, base-unit-normalized. Meaning
 * never rests on color alone: a directional arrow + an explicit
 * increase/decrease word accompany every change, plus an accessible label. */
function PriceCheckBadge({ priceCheck }: { priceCheck: PriceCheckDisplay }) {
  const toneClass =
    priceCheck.tone === "warning"
      ? "border-amber-700 bg-amber-950/30 text-amber-200"
      : priceCheck.tone === "success"
        ? "border-emerald-800 bg-emerald-950/30 text-emerald-200"
        : priceCheck.tone === "info"
          ? "border-sky-800 bg-sky-950/30 text-sky-200"
          : "border-zinc-700 bg-zinc-900 text-zinc-400";
  const arrow = priceCheck.direction === "increase" ? "↑" : priceCheck.direction === "decrease" ? "↓" : null;
  const arrowLabel = priceCheck.direction === "increase" ? "price increased" : priceCheck.direction === "decrease" ? "price decreased" : null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${toneClass}`} title="Price Check">
      <span className="text-[10px] uppercase tracking-wide opacity-70">Price</span>
      {arrow ? (
        <span aria-hidden>{arrow}</span>
      ) : null}
      <span>{priceCheck.text}</span>
      {arrowLabel ? <span className="sr-only">{arrowLabel}</span> : null}
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

// 8-column compact inventory row (Invoice line | Matched item | Purchase
// package | Inventory increase | Destination | Price | Status | Action).
// Distinct, self-describing columns -- never "84 PIECE -> 84 PIECE".
const INVENTORY_ROW_GRID =
  "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_84px_84px]";

function PriceCell({ price, toneClass }: { price: CompactRowView["price"]; toneClass: string }) {
  if (!price) return <span className="text-zinc-500">—</span>;
  return (
    <div className="min-w-0 leading-tight">
      {price.invoiceUnit ? <p className="truncate text-xs text-zinc-300">{price.invoiceUnit}</p> : null}
      {price.normalized ? <p className="truncate text-xs text-zinc-300">{price.normalized}</p> : null}
      {price.unit ? <p className="truncate text-sm text-zinc-200">{price.unit}</p> : null}
      {price.lineTotal ? <p className="truncate text-xs text-zinc-500">{price.lineTotal}</p> : null}
      {price.change ? <p className={`truncate text-xs ${toneClass}`}>{price.change}</p> : null}
    </div>
  );
}

function CompactInventoryRow({
  id,
  rowView,
  attention,
  statusLabel,
  issueText,
  priceToneClass,
  selectable,
  selected,
  onToggleSelected,
  onEditLine,
  toggleLabel,
  savedFlash,
  amendmentBadge,
}: {
  id: string;
  rowView: CompactRowView;
  attention: boolean;
  statusLabel: string;
  issueText?: string | null;
  priceToneClass: string;
  selectable: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onEditLine: () => void;
  toggleLabel: string;
  savedFlash?: boolean;
  amendmentBadge?: ReactNode;
}) {
  return (
    <div
      id={id}
      tabIndex={-1}
      className={`grid grid-cols-1 gap-1.5 border-b border-zinc-800 px-3 py-2.5 last:border-0 focus:outline-none sm:items-start sm:gap-3 ${INVENTORY_ROW_GRID} ${
        attention ? "border-l-2 border-l-amber-500 bg-amber-950/5 hover:bg-amber-950/10" : "hover:bg-zinc-800/20"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          {selectable ? (
            <input type="checkbox" checked={selected} onChange={onToggleSelected} className="mt-0.5 shrink-0" aria-label={`Select ${rowView.invoice.description} for bulk actions`} />
          ) : null}
          <p className="truncate text-sm font-medium text-zinc-100">{rowView.invoice.description}</p>
        </div>
        {rowView.invoice.meta ? <p className="truncate text-xs text-zinc-500">{rowView.invoice.meta}</p> : null}
        {issueText ? <p className="mt-1 text-xs font-medium text-amber-300">{issueText}</p> : null}
        {amendmentBadge ? <div className="mt-1">{amendmentBadge}</div> : null}
      </div>
      <p className="truncate text-sm text-zinc-200">
        <span className="text-zinc-500 sm:hidden">Item: </span>
        {rowView.matchedItem}
      </p>
      <p className="truncate text-sm text-zinc-300">
        <span className="text-zinc-500 sm:hidden">Package: </span>
        {rowView.purchasePackage}
      </p>
      <p className="truncate text-sm font-medium text-emerald-300">
        <span className="font-normal text-zinc-500 sm:hidden">Adds to inventory: </span>
        {rowView.inventoryIncrease ?? "—"}
      </p>
      <div className="min-w-0 text-sm text-zinc-300">
        <span className="text-zinc-500 sm:hidden">Destination: </span>
        {rowView.destination ? (
          <>
            <p className="truncate">{rowView.destination.location}</p>
            {rowView.destination.condition ? <p className="truncate text-xs text-zinc-500">{rowView.destination.condition}</p> : null}
          </>
        ) : (
          "—"
        )}
      </div>
      <div className="min-w-0 text-sm">
        <span className="text-zinc-500 sm:hidden">Price: </span>
        <PriceCell price={rowView.price} toneClass={priceToneClass} />
      </div>
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${attention ? "text-amber-400" : "text-emerald-400"}`}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${attention ? "bg-amber-500" : "bg-emerald-400"}`} />
        {statusLabel}
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

// Non-inventory row (Invoice line | Treatment | Amount | Invoice effect |
// Inventory effect | Status | Action) -- what the invoice says, what the
// AI selected, what the manager can change, and both effects, in one
// scannable row. The only editor is the shared classification drawer.
const NON_INVENTORY_ROW_GRID = "sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1fr)_120px_120px]";

function NonInventoryRow({
  id,
  line,
  readiness,
  currency,
  spendCategoryPath,
  readOnly,
  onClassify,
  savedFlash,
}: {
  id: string;
  line: LineClassificationRow;
  readiness: LineReadiness;
  currency: string | null;
  spendCategoryPath?: string;
  readOnly?: boolean;
  onClassify: () => void;
  savedFlash?: boolean;
}) {
  const attention = !readiness.ready;
  const treatment = line.lineTreatment;
  const treatmentLabel = treatment === "UNRESOLVED" ? "Needs classification" : LINE_TREATMENT_LABEL[treatment];
  const detail =
    treatment === "EXPENSE" || treatment === "FREIGHT_FEE"
      ? (spendCategoryPath ?? line.spendCategoryName ?? "No category")
      : treatment === "CREDIT_RETURN"
        ? line.creditSubtype
          ? line.creditSubtype === "INVENTORY_RETURN"
            ? `${CREDIT_SUBTYPE_LABEL[line.creditSubtype]} · ${line.inventoryItemName ?? "item not chosen"}`
            : CREDIT_SUBTYPE_LABEL[line.creditSubtype]
          : "Credit type not chosen"
        : treatment === "DISCOUNT"
          ? line.discountScope === "LINE" ? "Line discount" : line.discountScope === "DOCUMENT" ? "Document discount" : "Scope not chosen"
          : treatment === "TAX"
            ? "Sales tax · document level"
            : line.aiProposedTreatment && line.aiProposedTreatment !== "UNRESOLVED"
              ? `AI guess: ${LINE_TREATMENT_LABEL[line.aiProposedTreatment]} (${line.aiConfidence !== null ? Math.round(line.aiConfidence * 100) : "?"}%)`
              : "Unclear line — choose a treatment";
  const signed = signedLineAmount(treatment, line.lineTotal);
  const invoiceEffect =
    treatment === "CREDIT_RETURN" || treatment === "DISCOUNT"
      ? signed !== null ? `Invoice total decreases by ${formatMoney(Math.abs(signed), currency)}` : "—"
      : treatment === "TAX"
        ? "Document tax"
        : treatment === "UNRESOLVED"
          ? "—"
          : "Adds to invoice total";
  const inventoryEffect =
    readiness.inventoryEffect.kind === "decrease"
      ? `Decrease ${readiness.inventoryEffect.quantity ?? "?"} ${readiness.inventoryEffect.unitCode ?? ""}${line.returnLocationName ? ` from ${line.returnLocationName}` : ""}`
      : "None";
  const actionLabel =
    treatment === "UNRESOLVED"
      ? "Resolve issue"
      : attention
        ? readiness.status === "review_recommended" ? "Confirm" : "Resolve issue"
        : treatment === "EXPENSE" || treatment === "FREIGHT_FEE"
          ? "Edit classification"
          : "Change treatment";
  return (
    <div
      id={id}
      tabIndex={-1}
      className={`grid grid-cols-1 gap-1.5 border-b border-zinc-800 px-3 py-2.5 last:border-0 focus:outline-none sm:items-start sm:gap-3 ${NON_INVENTORY_ROW_GRID} ${
        attention ? "border-l-2 border-l-amber-500 bg-amber-950/5 hover:bg-amber-950/10" : "bg-zinc-950/30 hover:bg-zinc-800/10"
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-100">{line.description ?? "—"}</p>
        <p className="truncate text-xs text-zinc-500">{line.vendorSku ? `SKU ${line.vendorSku}` : ""}{line.vendorSku && formatSourceQuantity(line) ? " · " : ""}{formatSourceQuantity(line) ?? ""}</p>
        {readiness.primaryIssue ? <p className="mt-1 text-xs font-medium text-amber-300">{readiness.primaryIssue}</p> : null}
      </div>
      <div className="min-w-0">
        <p className={`text-sm ${treatment === "UNRESOLVED" ? "text-amber-200" : "text-zinc-100"}`}>
          <span className="text-zinc-500 sm:hidden">Treatment: </span>
          {treatmentLabel}
        </p>
        <p className="truncate text-xs text-zinc-400">{detail}</p>
        {readiness.aiLabel ? <p className="text-[11px] text-zinc-500">{readiness.aiLabel}{line.aiConfidence !== null ? ` · ${Math.round(line.aiConfidence * 100)}%` : ""}</p> : null}
      </div>
      <p className={`text-sm tabular-nums ${signed !== null && signed < 0 ? "text-sky-300" : "text-zinc-300"}`}>
        <span className="text-zinc-500 sm:hidden">Amount: </span>
        {signed !== null ? formatMoney(signed, currency) : "—"}
      </p>
      <p className="text-xs text-zinc-400">
        <span className="text-zinc-500 sm:hidden">Invoice: </span>
        {invoiceEffect}
      </p>
      <p className={`text-xs ${readiness.inventoryEffect.kind === "decrease" ? "font-medium text-sky-300" : "text-zinc-500"}`}>
        <span className="text-zinc-500 sm:hidden">Inventory: </span>
        {inventoryEffect}
      </p>
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${attention ? "text-amber-400" : "text-emerald-400"}`}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${attention ? "bg-amber-500" : "bg-emerald-400"}`} />
        {attention ? readiness.statusLabel : "Ready"}
      </span>
      <div className="flex items-center gap-2">
        {savedFlash ? <span className="text-[11px] font-medium text-emerald-400">Saved</span> : null}
        {!readOnly ? (
          <button type="button" onClick={onClassify} className={secondaryButtonClassCompact}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LineGroupSection({
  title,
  count,
  noun,
  tone,
  open,
  onToggle,
  blurb,
  children,
}: {
  title: string;
  count: number;
  noun: string;
  tone: "success" | "info" | "neutral";
  open: boolean;
  onToggle: () => void;
  blurb: string;
  children: ReactNode;
}) {
  if (count === 0) return null;
  const dot = tone === "success" ? "bg-emerald-400" : tone === "info" ? "bg-sky-400" : "bg-zinc-500";
  return (
    <section className={panelClass}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-zinc-800/40">
        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
        <span className="text-sm font-semibold text-zinc-100">{title}</span>
        <span className="text-[13px] text-zinc-400">
          · {count} {noun}
          {count === 1 ? "" : "s"}
        </span>
        <span className={`ml-auto text-xs text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
      </button>
      {open ? (
        <div className="border-t border-zinc-800">
          <p className="px-4 pt-3 text-xs text-zinc-400">{blurb}</p>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function buildCompactRowView(
  line: LineClassificationRow,
  receiving: ReceivingLineDraft | null,
  priceComparison: PriceComparisonResult | undefined,
  priceCheck: PriceCheckDisplay | null,
  locations: LocationSummary[],
): CompactRowView {
  return deriveCompactRowView({
    description: line.description,
    vendorSku: line.vendorSku,
    orderedQuantityText: formatSourceQuantity(line),
    disposition: line.disposition,
    matchedItemName: line.inventoryItemName,
    receivingBehavior: (line.effectiveReceivingBehavior ?? receiving?.info.receivingBehavior ?? null) as RowReceivingBehavior | null,
    purchaseUnitCode: line.effectivePurchaseUnitCode,
    baseUnitCode: line.inventoryBaseUnitCode ?? receiving?.info.baseUnitCode ?? null,
    conversionFactor: line.effectiveConversionFactor,
    resolvedInvoiceUnitCode: line.resolvedInvoiceUnitCode,
    verifiedBaseQuantity: receiving?.verifiedQuantity ?? null,
    receivedQuantity: receiving?.receivedQuantity ?? null,
    receivedUnit: receiving?.receivedUnit ?? null,
    locationName: receiving ? (locations.find((l) => l.id === receiving.locationId)?.name ?? null) : null,
    conditionLabel: receiving ? (CONDITION_OPTIONS.find((c) => c.value === receiving.conditionStatus)?.label ?? receiving.conditionStatus) : null,
    conditionIsAsInvoiced: receiving?.conditionStatus === "RECEIVED_AS_INVOICED",
    lineTotal: line.lineTotal,
    priceComparison: priceComparison
      ? priceComparison.available
        ? {
            available: true,
            currentUnitCost: priceComparison.currentUnitCost,
            baseUnitCode: priceComparison.baseUnitCode,
            previousVendorName: priceComparison.previous.vendorName,
          }
        : { available: false }
      : null,
    priceChangeText: priceCheck?.text ?? null,
  });
}

function priceCheckToneClass(priceCheck: PriceCheckDisplay | null): string {
  switch (priceCheck?.tone) {
    case "warning":
      return "text-amber-300";
    case "info":
      return "text-sky-300";
    case "success":
      return "text-emerald-400";
    default:
      return "text-zinc-400";
  }
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
  readiness,
  currency,
  onClassify,
  deliveryConflict,
  line,
  receiving,
  postingBlockerReason,
  priceCheck,
  selectable,
  selected,
  onToggleSelected,
  editingOpen,
  onEditLine,
  onCloseEditor,
  onNavigateIssue,
  issuePosition,
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
  /** THE shared readiness result for this line. */
  readiness: LineReadiness;
  currency: string | null;
  /** Opens the shared "Classify invoice line" drawer. */
  onClassify: () => void;
  /** True when this line is part of an AMBIGUOUS delivery lineage -- shown as
   * a distinct "Delivery conflict" reason, and the reason it is not Ready. */
  deliveryConflict?: boolean;
  line: LineClassificationRow;
  receiving: ReceivingLineDraft | null;
  /** The authoritative posting-scan reason this line would be refused at
   * post time, or null -- surfaced in the package column so a mismatch is
   * caught here, not only when the manager tries to post. */
  postingBlockerReason: string | null;
  /** Vendor-aware Price Check for this line (null when not applicable). */
  priceCheck: PriceCheckDisplay | null;
  /** Selection-based bulk: an eligible inventory row shows a checkbox. */
  selectable: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  editingOpen: boolean;
  onEditLine: () => void;
  onCloseEditor: () => void;
  /** Move the correction drawer to the previous/next unresolved line. */
  onNavigateIssue?: (dir: "prev" | "next") => void;
  /** This line's position among unresolved lines (for the drawer's nav). */
  issuePosition?: { index: number; total: number } | null;
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
  onNavigateToStep1?: (lineKey?: string) => void;
  onApproveExisting: (itemId: string, vendorPackage?: ExistingItemVendorPackageInput | null) => void;
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
  // Authorized (editable) managers always get "Edit" -- Ready status means the
  // line is currently valid, not locked. Only a genuinely read-only viewer
  // (not authorized, or a non-DRAFT document) sees "View details".
  const toggleLabel = readOnly ? (editingOpen ? "Hide details" : "View details") : editingOpen ? "Close" : "Edit";

  // ============ NON-INVENTORY TREATMENTS (expense / freight / tax /
  // discount / credit / inventory return) and UNCLASSIFIED lines: one
  // treatment-aware row whose only editor is the shared classification
  // drawer -- never the inventory checklist. ============
  if (line.lineTreatment !== "INVENTORY_PURCHASE" || readiness.status === "needs_classification") {
    return (
      <NonInventoryRow
        id={id}
        line={line}
        readiness={readiness}
        currency={currency}
        spendCategoryPath={spendCategoryPath}
        readOnly={readOnly}
        onClassify={onClassify}
        savedFlash={savedFlash}
      />
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
    return (
      <CompactInventoryRow
        id={id}
        rowView={buildCompactRowView(line, receiving, priceComparison, priceCheck, locations)}
        attention={false}
        statusLabel="Ready"
        priceToneClass={priceCheckToneClass(priceCheck)}
        selectable={selectable}
        selected={selected}
        onToggleSelected={onToggleSelected}
        onEditLine={onEditLine}
        toggleLabel={toggleLabel}
        savedFlash={savedFlash}
        amendmentBadge={line.changedInAmendment ? <AmendmentChangedBadge previous={line.previousOrderedSummary} /> : null}
      />
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
    // A short problem cue lives on the row; the FULL, untruncated error text
    // is shown beside the field in the auto-opened drawer. A delivery conflict
    // is the overriding reason -- it must be resolved before anything else on
    // the line matters, so it is labeled distinctly (GA080).
    const issueText = deliveryConflict
      ? "Recorded more than once — resolve the deliveries before this line can post"
      : (issue?.text ?? postingBlockerReason ?? "Needs attention");
    return (
      <CompactInventoryRow
        id={id}
        rowView={buildCompactRowView(line, receiving, priceComparison, priceCheck, locations)}
        attention
        statusLabel={deliveryConflict ? "Delivery conflict" : "Needs attention"}
        issueText={issueText}
        priceToneClass={priceCheckToneClass(priceCheck)}
        selectable={selectable}
        selected={selected}
        onToggleSelected={onToggleSelected}
        onEditLine={onEditLine}
        toggleLabel={toggleLabel}
        amendmentBadge={line.changedInAmendment ? <AmendmentChangedBadge previous={line.previousOrderedSummary} /> : null}
      />
    );
  }

  const showPackageAndReceiving = itemMatchOk && line.disposition === "INVENTORY";
  const canEditReceivingHere = !readOnly && line.disposition === "INVENTORY";

  // Which of the four correction scopes this line involves -- drives the
  // drawer's scope legend. B/A (package + receiving) once the item is matched;
  // C (price) only when there is a notable change; D (registered item) whenever
  // the line is editable.
  const drawerScopes = deriveLineActionScopes({
    readOnly,
    showPackageAndReceiving,
    priceCheckTone: priceCheck?.tone ?? null,
  });
  // Only locally-held forms lose input on close; lifted receiving drafts don't.
  const drawerDirty = drawerIsDirty({ overrideFormOpen, correcting });

  // The FULL, untruncated issue text(s) for this line, shown at the top of the
  // drawer. Package mismatches get the complete "invoice says X, configured as
  // Y" sentence rather than the row's short cue.
  const drawerIssue = describeLineIssue({
    status: line.status,
    disposition: line.disposition,
    isNewItemProposal: line.aiSuggestedIsNewProposal,
    hasPackageMismatch: line.hasPackageMismatch,
    receiving,
  });
  const drawerIssues: string[] = [];
  if (drawerIssue) {
    if (drawerIssue.section === "package" && line.hasPackageMismatch) {
      drawerIssues.push(
        `The invoice says ${line.resolvedInvoiceUnitCode ?? "this unit"}, but this vendor/SKU is configured as ${formatPurchasePackageDescription(line)}.`,
      );
    } else {
      drawerIssues.push(drawerIssue.text);
    }
  }
  if (postingBlockerReason && !drawerIssues.includes(postingBlockerReason)) drawerIssues.push(postingBlockerReason);
  const hasIssueNav = issuePosition !== null && issuePosition !== undefined && issuePosition.total > 1;

  return (
    <>
      {/* In-list anchor: the row stays put while the drawer overlays. */}
      <div
        id={id}
        tabIndex={-1}
        className={`flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-3.5 py-3 last:border-0 focus:outline-none ${isComplete ? "" : "border-l-2 border-l-amber-500 bg-amber-950/5"}`}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">{line.description ?? "—"}</p>
          <p className="truncate text-xs text-zinc-500">Editing in panel →</p>
        </div>
        <button type="button" onClick={onCloseEditor} className={secondaryButtonClassCompact}>
          {toggleLabel}
        </button>
      </div>
      <LineActionDrawer
        open
        title={line.description ?? "Edit line"}
        subtitle={line.vendorSku ? `Vendor SKU ${line.vendorSku}` : undefined}
        scopes={drawerScopes}
        issues={drawerIssues}
        onPrev={hasIssueNav ? () => onNavigateIssue?.("prev") : undefined}
        onNext={hasIssueNav ? () => onNavigateIssue?.("next") : undefined}
        navLabel={hasIssueNav && issuePosition ? `Issue ${issuePosition.index + 1} of ${issuePosition.total}` : undefined}
        dirty={drawerDirty}
        onRequestClose={onCloseEditor}
      >
    <div tabIndex={-1} className="focus:outline-none">
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
          {priceCheck ? (
            <div className="mt-1.5">
              <PriceCheckBadge priceCheck={priceCheck} />
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
                  <button type="button" disabled={actionPending} onClick={onClassify} className="rounded-md border border-zinc-500 px-2.5 py-1 text-[11px] text-zinc-100 disabled:opacity-40">
                    Change classification
                  </button>
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
                <button type="button" onClick={() => onNavigateToStep1(line.lineKey)} className="self-start text-[11px] font-medium text-red-300 underline underline-offset-2 hover:text-red-200">
                  Correct invoice value
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
      </LineActionDrawer>
    </>
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
