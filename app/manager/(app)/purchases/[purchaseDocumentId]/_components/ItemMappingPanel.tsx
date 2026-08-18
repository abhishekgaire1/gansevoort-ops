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
} from "@/app/manager/(app)/_components/ItemClassificationForms";
import { NewItemReviewModal, type NewItemReviewCandidate } from "@/app/manager/(app)/_components/NewItemReviewModal";

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
  const [showAllMappings, setShowAllMappings] = useState(false);
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
    const [linesResult, itemsResult, categoriesResult, spendResult, unitsResult] = await Promise.all([
      getPurchaseDocumentLineClassifications(purchaseDocumentId),
      listInventoryItems(),
      listInventoryCategories(),
      listSpendCategories(),
      listUnits(),
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

  async function handleRetryMatching() {
    hasAutoAttempted.current = true; // a manual retry counts as the automatic attempt too, so a subsequent still-unresolved reload doesn't silently retry again on its own
    await pollMatchingStatus(() => runItemMatchingNow(purchaseDocumentId));
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

  async function handleApproveExisting(lineKey: string, inventoryItemId: string) {
    const result = await approveExistingItemClassification({ purchaseDocumentId, lineKey, inventoryItemId });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOverrideFormLineKey(null);
    setEditingMappingLineKey(null);
    await load();
  }

  async function handleMarkNonInventory(line: LineClassificationRow) {
    const name = line.aiSuggestedInventoryItemName ?? line.description ?? "Non-inventory line";
    const result = await markLineNonInventory(purchaseDocumentId, line.lineKey, name, line.aiSuggestedIsNewProposal ? line.aiSuggestedInventoryItemId : null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEditingMappingLineKey(null);
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

  if (loading || lines === null) {
    return (
      <div aria-busy="true" className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (matchingPhase === "blocking") {
    return (
      <div aria-busy="true" className="mt-4 rounded-2xl border border-amber-800 bg-amber-950/10 p-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Matching Items</p>
        <p className="mt-2 text-sm text-zinc-300">Checking vendor mappings and matching invoice lines against your item master…</p>
        <p className="mt-1 text-xs text-zinc-500">Please wait. This will update automatically.</p>
      </div>
    );
  }

  if (matchingPhase === "stillActive" || matchingPhase === "failed" || matchingPhase === "stuck") {
    const isFailed = matchingPhase === "failed";
    const isStillActive = matchingPhase === "stillActive";
    return (
      <div className="mt-4 rounded-2xl border border-amber-800 bg-amber-950/10 p-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">{isFailed ? "Item Matching Failed" : "Item Matching Is Taking Longer Than Expected"}</p>
        <p className="mt-2 text-sm text-zinc-300">Your work is safe.</p>
        {isStillActive ? (
          <p className="mt-1 text-xs text-zinc-500">A classification run is still active -- we&apos;ll keep checking rather than starting a new one.</p>
        ) : null}
        {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        <button
          type="button"
          onClick={isStillActive ? handleCheckAgain : handleRetryMatching}
          className="mt-4 rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950"
        >
          {isStillActive ? "Check Again" : "Try Again"}
        </button>
      </div>
    );
  }

  const confirmedCount = lines.filter((l) => l.status === "CONFIRMED").length;
  const staleOrUnclassifiedCount = lines.filter((l) => l.status === "STALE" || l.status === "UNCLASSIFIED").length;
  const allResolved = lines.length > 0 && confirmedCount === lines.length;

  return (
    <div className="mt-4 flex flex-col gap-4">
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{readOnly ? "Item Mapping (Manager 1's preparation)" : "Confirm Items"}</h2>

        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {confirmedCount > 0 ? <li className="text-emerald-400">✓ {confirmedCount} item{confirmedCount === 1 ? "" : "s"} matched automatically</li> : null}
          {newItemCandidates.length > 0 ? (
            <li className="text-amber-300">○ {newItemCandidates.length} new item{newItemCandidates.length === 1 ? "" : "s"} need{newItemCandidates.length === 1 ? "s" : ""} verification</li>
          ) : null}
          {bulkEligible.length > 0 ? (
            <li className="text-amber-300">○ {bulkEligible.length} AI-suggested match{bulkEligible.length === 1 ? "" : "es"} awaiting confirmation</li>
          ) : null}
          {staleOrUnclassifiedCount > 0 ? <li className="text-amber-300">⚠ {staleOrUnclassifiedCount} line{staleOrUnclassifiedCount === 1 ? "" : "s"} need attention -- run item matching</li> : null}
          {lines.length === 0 ? <li className="text-zinc-500">No line items.</li> : null}
        </ul>

        {!readOnly ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
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
            <button type="button" onClick={handleRunMatching} disabled={runningMatch} className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-200 disabled:opacity-40">
              {runningMatch ? "Matching…" : "Re-run Matching"}
            </button>
          </div>
        ) : null}

        {allResolved ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-4">
            <p className="text-sm font-semibold text-emerald-400">✓ All current invoice lines resolved</p>
            {onContinue ? (
              <button type="button" onClick={onContinue} className="rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950">
                Continue to Receiving
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <button type="button" onClick={() => setShowAllMappings((v) => !v)} className="self-start text-xs text-zinc-400 underline">
        {showAllMappings ? "Hide" : "View"} All Item Mappings
      </button>

      {showAllMappings ? (
        <div className="flex flex-col divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {lines.map((line) => (
            <div key={line.lineKey} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* The canonical resolved name is the primary label once
                      known -- the raw vendor description/SKU is secondary
                      context, not the other way around. */}
                  <p className="truncate text-sm text-zinc-100">{line.inventoryItemName ?? line.aiSuggestedInventoryItemName ?? line.description ?? line.vendorSku ?? "—"}</p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {line.description ?? "—"}
                    {line.vendorSku ? ` · SKU ${line.vendorSku}` : ""}
                    {!line.inventoryItemName && line.aiSuggestedInventoryItemName
                      ? ` · AI suggests ${line.aiSuggestedIsNewProposal ? "new item" : "existing item"}${line.aiConfidence !== null ? ` (${Math.round(line.aiConfidence * 100)}%)` : ""}`
                      : ""}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLOR[line.status]}`}>{STATUS_LABEL[line.status]}</span>
              </div>

              {!readOnly && line.status !== "CONFIRMED" && !line.aiSuggestedIsNewProposal ? (
                <div className="flex flex-wrap items-center gap-2">
                  {line.aiSuggestedInventoryItemId ? (
                    <button
                      type="button"
                      onClick={() => handleApproveExisting(line.lineKey, line.aiSuggestedInventoryItemId!)}
                      className="rounded-full border border-emerald-700 px-3 py-1 text-xs text-emerald-300"
                    >
                      Approve “{line.aiSuggestedInventoryItemName}”
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOverrideFormLineKey(overrideFormLineKey === line.lineKey ? null : line.lineKey)}
                    className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                  >
                    Choose Different Item
                  </button>
                  <button type="button" onClick={() => handleMarkNonInventory(line)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                    Mark Non-Inventory
                  </button>
                </div>
              ) : null}

              {!readOnly && line.status === "CONFIRMED" ? (
                editingMappingLineKey === line.lineKey ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOverrideFormLineKey(overrideFormLineKey === line.lineKey ? null : line.lineKey)}
                      className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                    >
                      Choose Different Item
                    </button>
                    <button type="button" onClick={() => handleMarkNonInventory(line)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                      Mark Non-Inventory
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingMappingLineKey(null);
                        setOverrideFormLineKey(null);
                      }}
                      className="text-xs text-zinc-400 underline underline-offset-2"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingMappingLineKey(line.lineKey)}
                    className="self-start text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
                  >
                    Edit Mapping
                  </button>
                )
              ) : null}

              {overrideFormLineKey === line.lineKey ? (
                <ExistingItemOverrideForm items={items} onCancel={() => setOverrideFormLineKey(null)} onConfirm={(itemId) => handleApproveExisting(line.lineKey, itemId)} />
              ) : null}
            </div>
          ))}
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
    </div>
  );
}
