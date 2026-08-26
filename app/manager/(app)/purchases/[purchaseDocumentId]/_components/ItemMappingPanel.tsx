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
import {
  CLASSIFICATION_STATUS_LABEL as STATUS_LABEL,
  CLASSIFICATION_STATUS_COLOR as STATUS_COLOR,
  ExistingItemOverrideForm,
  type ExistingItemVendorPackageInput,
} from "@/app/manager/(app)/_components/ItemClassificationForms";
import { NewItemReviewModal, type NewItemReviewCandidate } from "@/app/manager/(app)/_components/NewItemReviewModal";
import { flattenSpendCategoryPaths } from "@/app/lib/itemMaster/spendCategoryPaths";
import { matchSourceLabel, formatSourceQuantity } from "@/app/lib/purchaseDocuments/matchSourcePresentation";
import { WorkflowFooter } from "@/app/components/receiving/WorkflowFooter";
import { blockingIssueSummaryLabel, scrollToFirstIssue } from "@/app/components/receiving/blockingIssues";
import { getPriceComparisons, getPriceHistory } from "@/app/actions/priceComparison";
import type { PriceComparisonResult, PriceHistoryPoint } from "@/app/lib/purchasing/priceComparison";
import { priceChangeTone } from "@/app/lib/purchasing/priceChangePresentation";

/**
 * Step 2 (Confirm Items) -- summary-first, not a per-line operational task
 * list. The normal manager path is two clicks: "Review New Items" (the
 * existing blocking NewItemReviewModal, one VERIFY ITEM per item) and
 * "Confirm All Matches" (one click for every high-confidence AI-suggested
 * existing-item match at once, via the same bulkConfirmClassifications RPC
 * this always used -- just defaulting to select-all instead of requiring a
 * manual checkbox pass first). The full per-line list remains available via
 * "View All Item Mappings" for transparency/debugging, never the primary
 * workflow.
 *
 * Shared with the /manager/items/review cross-document recovery queue (see
 * ItemClassificationForms.tsx/NewItemReviewModal.tsx) -- both surfaces call
 * the exact same authoritative approve RPCs, never a parallel
 * implementation.
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

export function ItemMappingPanel({
  purchaseDocumentId,
  vendorName,
  readOnly,
  onChange,
  onAllResolvedChange,
  onContinue,
}: {
  purchaseDocumentId: string;
  vendorName?: string | null;
  /** Manager 2's final-review view -- item mapping is Manager 1's job to
   * have substantially completed already; the reviewer sees exactly what
   * was resolved, never new-item setup or approve actions of their own. */
  readOnly?: boolean;
  /** Fires after every successful data load (including the initial one) --
   * lets the page-level Send for Final Review gate know it should re-check
   * readiness, without this panel needing to know anything about that
   * gate itself. */
  onChange?: () => void;
  /** Fires whenever "every current line is CONFIRMED" changes -- the
   * wizard's own derived step-2-complete signal (never a separate stored
   * flag). */
  onAllResolvedChange?: (resolved: boolean) => void;
  /** Renders "Continue to Receiving" once every line is resolved -- only
   * passed by the Step 2 wizard wrapper, never in read-only/standalone
   * use. */
  onContinue?: () => void;
}) {
  const [lines, setLines] = useState<LineClassificationRow[] | null>(null);
  const [items, setItems] = useState<InventoryItemSummary[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [spendCategories, setSpendCategories] = useState<SpendCategorySummary[]>([]);
  const [units, setUnits] = useState<UnitSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningMatch, setRunningMatch] = useState(false);
  const [bulkConfirmPending, setBulkConfirmPending] = useState(false);
  // Guards handleApproveExisting/handleMarkNonInventory against a double
  // tap/click firing the same line's approve-or-reject action twice
  // before the first request's `load()` re-render can disable it --
  // scoped to one lineKey at a time since different lines are
  // independent actions.
  const [actionPendingLineKey, setActionPendingLineKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideFormLineKey, setOverrideFormLineKey] = useState<string | null>(null);
  // A CONFIRMED line stays clean by default; while the document is still
  // DRAFT, Manager 1 can deliberately reopen it via [Edit Mapping] to
  // correct the canonical item/disposition before Send for Final Review.
  // Re-approval goes through the exact same audited approve RPCs (which
  // upsert the line's classification, preserve vendor-memory rules, and
  // are preparer-gated + status-locked server-side), so nothing here
  // weakens the freeze: after submission these controls are read-only AND
  // the RPCs reject the write regardless.
  const [editingMappingLineKey, setEditingMappingLineKey] = useState<string | null>(null);
  const [showNewItemModal, setShowNewItemModal] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  // Purchase Price Change Intelligence (V1) -- keyed by lineKey, one
  // batched fetch alongside everything else in load(), never one call per
  // row. Absent from the map (rather than an explicit "unavailable" entry)
  // is treated the same as "no comparison to show" -- quiet by default.
  const [priceComparisons, setPriceComparisons] = useState<Record<string, PriceComparisonResult>>({});
  // The on-demand price-history drill-down (Section 21) -- fetched lazily,
  // only for the one line a manager expands, never eagerly for every row.
  const [expandedPriceHistoryLineKey, setExpandedPriceHistoryLineKey] = useState<string | null>(null);
  const [priceHistoryByLineKey, setPriceHistoryByLineKey] = useState<Record<string, PriceHistoryPoint[]>>({});
  const [priceHistoryLoading, setPriceHistoryLoading] = useState(false);
  // "blocking": actively polling. "stillActive"/"failed"/"stuck": the poll
  // cap was reached (or the run failed) -- an explicit recovery state, not
  // an indefinite spinner. null: not blocking at all.
  const [matchingPhase, setMatchingPhase] = useState<"blocking" | "stillActive" | "failed" | "stuck" | null>(null);
  const matchingRunToken = useRef(0);
  // Guards the AUTOMATIC (effect-triggered) path against retrying forever
  // on its own when a run completes but leaves lines genuinely unresolved
  // (e.g. AI had nothing actionable for a line) -- one automatic attempt
  // per "matching is needed" state, then an explicit manager click is
  // required. Manual retries always bypass this guard.
  const hasAutoAttempted = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [linesResult, itemsResult, categoriesResult, spendResult, unitsResult, priceComparisonsResult] = await Promise.all([
      getPurchaseDocumentLineClassifications(purchaseDocumentId),
      listInventoryItems(),
      listInventoryCategories(),
      listSpendCategories(),
      listUnits(),
      getPriceComparisons(purchaseDocumentId),
    ]);
    if (linesResult.ok) {
      setLines(linesResult.lines);
      onAllResolvedChange?.(linesResult.lines.length > 0 && linesResult.lines.every((l) => l.status === "CONFIRMED"));
    } else {
      setError(linesResult.message);
    }
    if (itemsResult.ok) setItems(itemsResult.items);
    if (categoriesResult.ok) setCategories(categoriesResult.categories);
    if (spendResult.ok) setSpendCategories(spendResult.categories);
    if (unitsResult.ok) setUnits(unitsResult.units);
    // Quiet purchasing intelligence, never a blocker -- an auth/read
    // failure here just means no indicators render this load, same as
    // "no comparison available" for every line. Never surfaces its own
    // error banner.
    if (priceComparisonsResult.ok) setPriceComparisons(priceComparisonsResult.comparisons);
    setExpandedPriceHistoryLineKey(null);
    setPriceHistoryByLineKey({});
    setLoading(false);
    onChange?.();
    // onAllResolvedChange/onChange are stable callbacks from the parent
    // (useCallback there); omitting them from deps here would be wrong if
    // they weren't, so they're intentionally included via the eslint rule
    // rather than suppressed.
  }, [purchaseDocumentId, onChange, onAllResolvedChange]);

  const refetchCategories = useCallback(async () => {
    const [categoriesResult, spendResult] = await Promise.all([listInventoryCategories(), listSpendCategories()]);
    if (categoriesResult.ok) setCategories(categoriesResult.categories);
    if (spendResult.ok) setSpendCategories(spendResult.categories);
  }, []);

  useEffect(() => {
    // Deliberate fetch-on-mount, same pattern as NotificationBell's own
    // fetch-on-mount effect -- there's no props/state this could be
    // derived from during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // The one shared polling core, callable both automatically (mount/reload)
  // and from an explicit manager retry click. `kickOff`, when provided, is
  // called ONCE before polling starts (the automatic path's
  // ensureItemMatchingStarted, or a manual retry's runItemMatchingNow) --
  // omitted for a plain "keep checking" resume, which must never start a
  // second run while one is already genuinely active.
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
        if (matchingRunToken.current !== token) return; // superseded by a newer poll
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
      // stillActive / failed / unknown -- an explicit recovery state, never
      // an indefinite spinner and never a silent automatic retry loop.
      setMatchingPhase(outcome === "stillActive" ? "stillActive" : outcome === "failed" ? "failed" : "stuck");
    },
    [purchaseDocumentId, load]
  );

  // The manager must never be shown an empty/incomplete item screen while
  // AI matching is still working out what a line resolves to (a real,
  // common race: the after()-scheduled classification run from the save
  // that navigated here may not have started yet, or may still be
  // in-flight). Blocks Step 2 entirely -- no approve/verify controls
  // render -- until every current line has left UNCLASSIFIED/STALE,
  // polling the one REAL signal this system has (is a run currently
  // claimed-but-unfinished), never a fabricated multi-phase progress
  // display this table has no data to back. Only ONE automatic attempt per
  // "matching is needed" state -- if that attempt doesn't resolve
  // everything (timeout, failure, or a run that completed but genuinely
  // couldn't classify every line), an explicit recovery state is shown
  // rather than silently retrying forever in the background.
  useEffect(() => {
    if (lines === null) return;
    const needsMatching = lines.some((l) => l.status === "UNCLASSIFIED" || l.status === "STALE");
    if (!needsMatching) {
      hasAutoAttempted.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMatchingPhase(null);
      return;
    }
    if (hasAutoAttempted.current) return; // already tried automatically once; wait for an explicit retry
    hasAutoAttempted.current = true;
    pollMatchingStatus(() => ensureItemMatchingStarted(purchaseDocumentId));
    // Deliberately keyed on `lines` itself (re-evaluates after every fresh
    // load, including the one a resolved poll triggers) -- pollMatchingStatus
    // is a stable useCallback across a given mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  /** The failure/stuck banner's own retry action -- deliberately narrower
   * than handleRetryMatching/handleRunMatching's full re-run
   * (includeUnconfirmedAiProposals: true, which also re-resolves every
   * already-PENDING_REVIEW AI-suggested line). A failure here most often
   * means only SOME lines never got a result; re-running the whole batch
   * would re-spend AI cost on lines that already resolved fine and risks
   * re-surfacing the exact same transient failure. ensureItemMatchingStarted
   * only ever touches lines that are genuinely UNCLASSIFIED/STALE, so a
   * manager-approved or already-suggested line is never touched by this
   * button -- the explicit, de-emphasized "Re-run Matching" control below
   * remains the one path for a deliberate full refresh. */
  async function handleRetryUnresolvedMatching() {
    hasAutoAttempted.current = true;
    await pollMatchingStatus(() => ensureItemMatchingStarted(purchaseDocumentId));
  }

  function handleCheckAgain() {
    // A run is genuinely still active -- resume checking, never start a
    // second, conflicting one.
    pollMatchingStatus();
  }

  const newItemCandidates = (lines ?? [])
    .map((l) => lineToCandidate(l, vendorName ?? null, null))
    .filter((c): c is NewItemReviewCandidate => c !== null)
    .map((c) => ({ ...c, purchaseDocumentId }));

  useEffect(() => {
    // Auto-opens the blocking review exactly once per successful data load
    // (autoOpened resets to false whenever matching re-runs) -- deliberate
    // derived-state synchronization, same NotificationBell-style exception
    // as the fetch-on-mount effect above. Never for the read-only
    // (Manager 2) view -- new-item setup is Manager 1's job.
    if (!readOnly && !autoOpened && newItemCandidates.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowNewItemModal(true);
      setAutoOpened(true);
    }
  }, [newItemCandidates.length, autoOpened, readOnly]);

  async function handleRunMatching() {
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
    setEditingMappingLineKey(null);
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
    setEditingMappingLineKey(null);
    await load();
  }

  async function handleTogglePriceHistory(lineKey: string, inventoryItemId: string) {
    if (expandedPriceHistoryLineKey === lineKey) {
      setExpandedPriceHistoryLineKey(null);
      return;
    }
    setExpandedPriceHistoryLineKey(lineKey);
    if (priceHistoryByLineKey[lineKey]) return; // already fetched this load
    setPriceHistoryLoading(true);
    const result = await getPriceHistory(purchaseDocumentId, inventoryItemId);
    setPriceHistoryLoading(false);
    if (result.ok) {
      setPriceHistoryByLineKey((prev) => ({ ...prev, [lineKey]: result.history }));
    }
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

  if (loading || lines === null) {
    return (
      <div aria-busy="true" className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  // Matching-phase banners (Item Matching Robustness fix): item matching is
  // assistance, never a single point of failure that hides an otherwise-
  // successfully-extracted invoice. Every one of these states used to be an
  // early `return` that replaced the ENTIRE Step 2 screen -- the summary
  // card, every resolved/needs-review line, and the WorkflowFooter -- with
  // one small card. That meant a run that resolved 54 of 62 lines and hit a
  // recoverable problem on a handful of others looked identical to a total
  // page failure, and a manager had no way to reach the 54 lines (or the
  // manual "Search Existing Item"/"Create New Item"/"Mark Non-Inventory"
  // fallback already built into NeedsReviewLineRow below) while matching was
  // degraded. These now render as compact banners ABOVE the same content
  // that always renders once `lines` has loaded, never in place of it.
  const matchingBanner =
    matchingPhase === "blocking" ? (
      <div aria-busy="true" className="rounded-2xl border border-amber-800 bg-amber-950/10 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Matching Items</p>
        <p className="mt-1 text-sm text-zinc-300">Checking vendor mappings and matching invoice lines against your item master. This will update automatically.</p>
      </div>
    ) : matchingPhase === "stillActive" || matchingPhase === "failed" || matchingPhase === "stuck" ? (
      <div className="rounded-2xl border border-amber-800 bg-amber-950/10 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
          {matchingPhase === "stillActive" ? "Item Matching Is Taking Longer Than Expected" : "Automatic Matching Unavailable"}
        </p>
        <p className="mt-1 text-sm text-zinc-300">
          {matchingPhase === "stillActive"
            ? "A classification run is still active -- we'll keep checking rather than starting a new one."
            : "Your invoice and extracted lines are safe. You can retry matching or continue reviewing manually below."}
        </p>
        {error ? <p className="mt-1 text-sm text-red-400">{error}</p> : null}
        <button
          type="button"
          onClick={matchingPhase === "stillActive" ? handleCheckAgain : handleRetryUnresolvedMatching}
          className="mt-3 rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950"
        >
          {matchingPhase === "stillActive" ? "Check Again" : "Retry Unresolved Matching"}
        </button>
      </div>
    ) : null;

  const confirmedCount = lines.filter((l) => l.status === "CONFIRMED").length;
  const staleOrUnclassifiedCount = lines.filter((l) => l.status === "STALE" || l.status === "UNCLASSIFIED").length;
  const allResolved = lines.length > 0 && confirmedCount === lines.length;
  const needsReviewLines = lines.filter((l) => l.status !== "CONFIRMED");
  const resolvedLines = lines.filter((l) => l.status === "CONFIRMED");
  const resolvedInventoryLines = resolvedLines.filter((l) => l.disposition === "INVENTORY");
  const resolvedNonInventoryLines = resolvedLines.filter((l) => l.disposition === "NON_INVENTORY");
  const spendCategoryPathById = new Map(flattenSpendCategoryPaths(spendCategories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }))).map((p) => [p.id, p.path]));

  return (
    <div className="mt-4 flex flex-col gap-4">
      {matchingBanner}
      {error && !matchingBanner ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">{readOnly ? "Item Mapping (Manager 1's preparation)" : "Confirm Items"}</h2>
          <p className="text-xs text-zinc-500">
            {lines.length === 0 ? "No line items." : allResolved ? `${lines.length} of ${lines.length} lines resolved` : `${confirmedCount} of ${lines.length} lines resolved`}
          </p>
        </div>

        {allResolved ? (
          <p className="mt-2 text-sm text-emerald-400">✓ All invoice lines are ready for review.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {newItemCandidates.length > 0 ? (
              <li className="text-amber-300">○ {newItemCandidates.length} new item{newItemCandidates.length === 1 ? "" : "s"} need{newItemCandidates.length === 1 ? "s" : ""} verification</li>
            ) : null}
            {bulkEligible.length > 0 ? (
              <li className="text-amber-300">○ {bulkEligible.length} AI-suggested match{bulkEligible.length === 1 ? "" : "es"} awaiting confirmation</li>
            ) : null}
            {staleOrUnclassifiedCount > 0 ? <li className="text-amber-300">⚠ {staleOrUnclassifiedCount} line{staleOrUnclassifiedCount === 1 ? "" : "s"} need attention</li> : null}
          </ul>
        )}

        {!readOnly ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {newItemCandidates.length > 0 ? (
              <button type="button" onClick={() => setShowNewItemModal(true)} className="rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-zinc-950">
                Review New Items ({newItemCandidates.length})
              </button>
            ) : null}
            {bulkEligible.length > 0 ? (
              <button
                type="button"
                onClick={handleConfirmAllMatches}
                disabled={bulkConfirmPending}
                className="rounded-full border border-emerald-700 px-4 py-1.5 text-xs font-semibold text-emerald-300 disabled:opacity-40"
              >
                {bulkConfirmPending ? "Confirming…" : `Confirm All Matches (${bulkEligible.length})`}
              </button>
            ) : null}
            {/* De-emphasized once everything is resolved (Part 19) -- most
                managers never need to rerun matching against an already-
                resolved document, and doing so must never be encouraged as
                a routine action or risk destabilizing approved mappings
                (Re-run Matching itself is unchanged: it only ever touches
                lines still eligible for re-classification). */}
            <button
              type="button"
              onClick={handleRunMatching}
              disabled={runningMatch}
              className={allResolved ? "text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300" : "rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-200 disabled:opacity-40"}
            >
              {runningMatch ? "Matching…" : "Re-run Matching"}
            </button>
          </div>
        ) : null}

      </div>

      {/* ============ NEEDS REVIEW -- problems first (Part 20) ============ */}
      {needsReviewLines.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Needs Review · {needsReviewLines.length}</p>
          <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-amber-900/60 bg-amber-950/10">
            {needsReviewLines.map((line) => (
              <NeedsReviewLineRow
                key={line.lineKey}
                id={`classification-line-${line.lineKey}`}
                line={line}
                readOnly={readOnly}
                items={items}
                units={units}
                overrideFormOpen={overrideFormLineKey === line.lineKey}
                onToggleOverrideForm={() => setOverrideFormLineKey(overrideFormLineKey === line.lineKey ? null : line.lineKey)}
                onApproveExisting={(itemId, vendorPackage) => handleApproveExisting(line.lineKey, itemId, vendorPackage)}
                onMarkNonInventory={() => handleMarkNonInventory(line)}
                onReviewNewItem={() => setShowNewItemModal(true)}
                actionPending={actionPendingLineKey === line.lineKey}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* ============ RESOLVED -- visible directly, no second page (Part 12/16) ============ */}
      {resolvedInventoryLines.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Inventory Items · {resolvedInventoryLines.length}</p>
          <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
            {resolvedInventoryLines.map((line) => (
              <ResolvedLineRow
                key={line.lineKey}
                line={line}
                readOnly={readOnly}
                items={items}
                units={units}
                editing={editingMappingLineKey === line.lineKey}
                overrideFormOpen={overrideFormLineKey === line.lineKey}
                onToggleEdit={() => {
                  setEditingMappingLineKey(editingMappingLineKey === line.lineKey ? null : line.lineKey);
                  setOverrideFormLineKey(null);
                }}
                onToggleOverrideForm={() => setOverrideFormLineKey(overrideFormLineKey === line.lineKey ? null : line.lineKey)}
                onApproveExisting={(itemId, vendorPackage) => handleApproveExisting(line.lineKey, itemId, vendorPackage)}
                onMarkNonInventory={() => handleMarkNonInventory(line)}
                actionPending={actionPendingLineKey === line.lineKey}
                priceComparison={priceComparisons[line.lineKey]}
                priceHistoryExpanded={expandedPriceHistoryLineKey === line.lineKey}
                priceHistory={priceHistoryByLineKey[line.lineKey]}
                priceHistoryLoading={priceHistoryLoading && expandedPriceHistoryLineKey === line.lineKey}
                onTogglePriceHistory={line.inventoryItemId ? () => handleTogglePriceHistory(line.lineKey, line.inventoryItemId!) : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}

      {resolvedNonInventoryLines.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Non-Inventory · {resolvedNonInventoryLines.length}</p>
          <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
            {resolvedNonInventoryLines.map((line) => (
              <ResolvedLineRow
                key={line.lineKey}
                line={line}
                readOnly={readOnly}
                items={items}
                units={units}
                editing={editingMappingLineKey === line.lineKey}
                overrideFormOpen={overrideFormLineKey === line.lineKey}
                spendCategoryPath={line.spendCategoryId ? spendCategoryPathById.get(line.spendCategoryId) : undefined}
                onToggleEdit={() => {
                  setEditingMappingLineKey(editingMappingLineKey === line.lineKey ? null : line.lineKey);
                  setOverrideFormLineKey(null);
                }}
                onToggleOverrideForm={() => setOverrideFormLineKey(overrideFormLineKey === line.lineKey ? null : line.lineKey)}
                onApproveExisting={(itemId, vendorPackage) => handleApproveExisting(line.lineKey, itemId, vendorPackage)}
                onMarkNonInventory={() => handleMarkNonInventory(line)}
                actionPending={actionPendingLineKey === line.lineKey}
              />
            ))}
          </div>
        </div>
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
        // Same consistent footer location as every other step -- always
        // visible (disabled while blocked), never appearing only once
        // resolved, so the manager always knows where Continue lives.
        <WorkflowFooter
          contextLabel={allResolved ? undefined : blockingIssueSummaryLabel(needsReviewLines.length, "line")}
          contextTone="warning"
          onContextClick={
            !allResolved && needsReviewLines.length > 0
              ? () => scrollToFirstIssue(needsReviewLines.map((l) => ({ id: `classification-line-${l.lineKey}`, reason: "" })))
              : undefined
          }
          primaryLabel="Continue to Confirm Receiving"
          onPrimary={onContinue}
          primaryDisabled={!allResolved}
          primaryTitle={!allResolved ? "Resolve every line before continuing." : undefined}
          sticky={false}
        />
      ) : null}
    </div>
  );
}

function SourceSide({ line }: { line: LineClassificationRow }) {
  const quantity = formatSourceQuantity(line);
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium text-zinc-100">{line.description ?? "—"}</p>
      <p className="mt-0.5 truncate text-xs text-zinc-500">
        {line.vendorSku ? `Vendor SKU ${line.vendorSku}` : null}
        {line.vendorSku && quantity ? " · " : null}
        {quantity}
      </p>
    </div>
  );
}

function ResolvedLineRow({
  line,
  readOnly,
  items,
  units,
  editing,
  overrideFormOpen,
  spendCategoryPath,
  onToggleEdit,
  onToggleOverrideForm,
  onApproveExisting,
  onMarkNonInventory,
  actionPending,
  priceComparison,
  priceHistoryExpanded,
  priceHistory,
  priceHistoryLoading,
  onTogglePriceHistory,
}: {
  line: LineClassificationRow;
  readOnly?: boolean;
  items: InventoryItemSummary[];
  units: UnitSummary[];
  editing: boolean;
  overrideFormOpen: boolean;
  spendCategoryPath?: string;
  onToggleEdit: () => void;
  onToggleOverrideForm: () => void;
  onApproveExisting: (itemId: string, vendorPackage?: ExistingItemVendorPackageInput | null) => void;
  onMarkNonInventory: () => void;
  /** True while THIS line's approve/mark-non-inventory request is in
   * flight -- disables its own buttons so a fast double-tap can't fire
   * the same mutation twice before the panel reloads. */
  actionPending?: boolean;
  /** Purchase Price Change Intelligence (V1) -- only ever meaningful for
   * an INVENTORY line; omitted entirely on the Non-Inventory render path. */
  priceComparison?: PriceComparisonResult;
  priceHistoryExpanded?: boolean;
  priceHistory?: PriceHistoryPoint[];
  priceHistoryLoading?: boolean;
  onTogglePriceHistory?: () => void;
}) {
  const source = matchSourceLabel(line);
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <SourceSide line={line} />
      <div className="flex shrink-0 flex-col gap-2 sm:w-64 sm:items-end sm:text-right">
        {line.disposition === "INVENTORY" ? (
          <div>
            {line.inventoryItemNumber ? <p className="font-mono text-[11px] text-zinc-500">{line.inventoryItemNumber}</p> : null}
            <p className="text-sm font-medium text-zinc-100">{line.inventoryItemName ?? "—"}</p>
            <p className="text-xs text-zinc-500">
              {line.inventoryCategoryName ?? "No category"}
              {line.inventoryBaseUnitCode ? ` · ${line.inventoryBaseUnitCode}` : ""}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Non-Inventory</p>
            <p className="text-sm text-zinc-100">{spendCategoryPath ?? "Uncategorized expense"}</p>
          </div>
        )}
        <p className="text-[11px] text-zinc-500">
          {source.label}
          {source.sublabel ? ` · ${source.sublabel}` : ""}
        </p>
        {line.disposition === "INVENTORY" ? (
          <PriceChangeIndicator comparison={priceComparison} onToggleHistory={onTogglePriceHistory} historyExpanded={Boolean(priceHistoryExpanded)} />
        ) : null}
        {!readOnly ? (
          <button type="button" onClick={onToggleEdit} className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
            {editing ? "Cancel" : "Change Match"}
          </button>
        ) : null}
      </div>

      {priceHistoryExpanded ? (
        <div className="w-full border-t border-zinc-800 pt-3 sm:col-span-2">
          <PriceHistoryDrilldown loading={Boolean(priceHistoryLoading)} history={priceHistory} />
        </div>
      ) : null}

      {editing ? (
        <div className="flex w-full flex-col gap-2 border-t border-zinc-800 pt-3 sm:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={actionPending} onClick={onToggleOverrideForm} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40">
              Choose Different Item
            </button>
            {line.disposition !== "NON_INVENTORY" ? (
              <button type="button" disabled={actionPending} onClick={onMarkNonInventory} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40">
                {actionPending ? "Marking…" : "Mark Non-Inventory"}
              </button>
            ) : null}
          </div>
          {overrideFormOpen ? <ExistingItemOverrideForm items={items} units={units} onCancel={onToggleOverrideForm} onConfirm={onApproveExisting} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatShortDate(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Quiet purchasing intelligence (Section 14/18/19) -- never a blocker,
 * never a loud trading-style red/green background block (color is
 * confined to the change indicator text alone, never the whole row).
 * Absent comparison or an "unavailable" reason other than FIRST_PURCHASE
 * renders nothing at all, exactly per Section 20/22 ("do not show
 * 0%/N/A in a way that looks like a comparison actually occurred").
 *
 * Color directly encodes purchasing direction (increase = cost went up =
 * red; decrease = cost went down = green; Section 10), with the arrow/≈
 * glyph always present alongside color so the signal never depends on
 * color alone (Section 11). "Unchanged" is comparePrices' own
 * tolerance-widened classification (mirrors the existing money-
 * reconciliation tolerance, not a UI-only rounding decision) -- never
 * colored red or green. */
function PriceChangeIndicator({
  comparison,
  onToggleHistory,
  historyExpanded,
}: {
  comparison: PriceComparisonResult | undefined;
  onToggleHistory?: () => void;
  historyExpanded: boolean;
}) {
  if (!comparison) return null;

  if (!comparison.available) {
    if (comparison.reason === "FIRST_PURCHASE") {
      return <p className="text-[11px] text-zinc-600">First recorded purchase</p>;
    }
    return null;
  }

  const pct = Math.abs(comparison.deltaPct);
  const tone = priceChangeTone(comparison.direction);

  const content = (
    <>
      <span className="text-zinc-300">
        ${comparison.currentUnitCost.toFixed(2)} / {comparison.baseUnitCode}
      </span>
      <span className={`ml-1.5 font-medium ${tone.colorClass}`}>
        {tone.glyph} {pct.toFixed(1)}%
      </span>
      <span className="block text-zinc-600">
        vs ${comparison.previous.unitCost.toFixed(2)} previous
        {comparison.previous.documentDate ? ` · ${formatShortDate(comparison.previous.documentDate)}` : ""}
      </span>
    </>
  );

  if (!onToggleHistory) {
    return <p className="text-[11px] leading-tight">{content}</p>;
  }

  return (
    <button type="button" onClick={onToggleHistory} className="text-[11px] leading-tight hover:underline underline-offset-2" aria-expanded={historyExpanded}>
      {content}
    </button>
  );
}

/** The lightweight, on-demand price-history drill-down (Section 21) --
 * deliberately just a short list, never a chart; a deeper report belongs
 * in Reports, not Receiving. */
function PriceHistoryDrilldown({ loading, history }: { loading: boolean; history: PriceHistoryPoint[] | undefined }) {
  if (loading) {
    return <p className="text-xs text-zinc-500">Loading price history…</p>;
  }
  if (!history || history.length === 0) {
    return <p className="text-xs text-zinc-500">No price history available.</p>;
  }
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Price History</p>
      <div className="mt-2 flex flex-col gap-1">
        {history.map((point) => (
          <div key={point.purchaseDocumentId} className="flex items-baseline justify-between text-xs">
            <span className="text-zinc-500">{formatShortDate(point.documentDate)}</span>
            <span className="text-zinc-300">${point.unitCost.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NeedsReviewLineRow({
  id,
  line,
  readOnly,
  items,
  units,
  overrideFormOpen,
  onToggleOverrideForm,
  onApproveExisting,
  onMarkNonInventory,
  onReviewNewItem,
  actionPending,
}: {
  id?: string;
  line: LineClassificationRow;
  readOnly?: boolean;
  items: InventoryItemSummary[];
  units: UnitSummary[];
  overrideFormOpen: boolean;
  onToggleOverrideForm: () => void;
  onApproveExisting: (itemId: string, vendorPackage?: ExistingItemVendorPackageInput | null) => void;
  onMarkNonInventory: () => void;
  onReviewNewItem: () => void;
  /** True while THIS line's approve/mark-non-inventory request is in
   * flight -- disables its own buttons so a fast double-tap can't fire
   * the same mutation twice before the panel reloads. */
  actionPending?: boolean;
}) {
  return (
    <div id={id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <SourceSide line={line} />
      <div className="flex shrink-0 flex-col gap-2 sm:w-72 sm:items-end sm:text-right">
        <span className={`inline-block self-end rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[line.status]}`}>{STATUS_LABEL[line.status]}</span>

        {!readOnly && line.aiSuggestedIsNewProposal ? (
          <>
            <p className="text-xs text-zinc-400">New item proposed: {line.aiSuggestedInventoryItemName}</p>
            <button type="button" onClick={onReviewNewItem} className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-zinc-950">
              Review →
            </button>
          </>
        ) : !readOnly ? (
          <>
            {line.aiSuggestedInventoryItemId ? (
              <p className="text-xs text-zinc-400">
                Suggested: {line.aiSuggestedInventoryItemName}
                {line.aiConfidence !== null ? ` (${Math.round(line.aiConfidence * 100)}%)` : ""}
              </p>
            ) : (
              <p className="text-xs text-zinc-500">Not yet classified.</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {line.aiSuggestedInventoryItemId ? (
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={() => onApproveExisting(line.aiSuggestedInventoryItemId!)}
                  className="rounded-full border border-emerald-700 px-3 py-1 text-xs text-emerald-300 disabled:opacity-40"
                >
                  {actionPending ? "Approving…" : "Approve"}
                </button>
              ) : null}
              <button type="button" disabled={actionPending} onClick={onToggleOverrideForm} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40">
                Choose Item
              </button>
              <button type="button" disabled={actionPending} onClick={onMarkNonInventory} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40">
                {actionPending ? "Marking…" : "Non-Inventory"}
              </button>
            </div>
          </>
        ) : null}
      </div>

      {overrideFormOpen ? (
        <div className="w-full border-t border-zinc-800 pt-3 sm:col-span-2">
          <ExistingItemOverrideForm items={items} units={units} onCancel={onToggleOverrideForm} onConfirm={onApproveExisting} />
        </div>
      ) : null}
    </div>
  );
}
