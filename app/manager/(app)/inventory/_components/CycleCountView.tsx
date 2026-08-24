"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  listStorageEligibleLocationsForOrganization,
  listCycleCountDraftStatus,
  startOrResumeCycleCountAction,
  getCycleCountDetailAction,
  listCycleCountLinesAction,
  listActiveInventoryItemsForCycleCountAction,
  addCycleCountLineAction,
  recordCycleCountLineObservationAction,
  completeCycleCountAction,
  cancelCycleCountAction,
  markCycleCountLineKnownWasteAction,
  recordCycleCountLineWasteAction,
} from "@/app/actions/cycleCounts";
import { listInventoryBalancesForOrganization } from "@/app/actions/inventory";
import type {
  StorageEligibleLocation,
  CycleCountDraftStatus,
  CycleCountDetail,
  CycleCountLineDetail,
  CycleCountSearchableItem,
} from "@/app/lib/inventory/cycleCounts";
import type { StaleCycleCountLine } from "@/app/lib/inventory/errors";
import { WASTE_REASON_CODES, WASTE_REASON_LABELS, type WasteReasonCode } from "@/app/lib/inventory/wasteReasons";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { EmptyState } from "@/app/components/manager/EmptyState";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import {
  buildCycleCountDisplayItems,
  groupDisplayItemsByCategory,
  filterSuggestedItems,
  type InventoryBalanceRowLike,
  type CycleCountDisplayItem as DisplayItem,
} from "../_lib/cycleCountDisplayItems";

type Step = "pick_location" | "counting" | "review" | "done" | "blocked" | "historical_detail";

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function CycleCountView({ initialCountId }: { initialCountId?: string }) {
  const [step, setStep] = useState<Step>("pick_location");
  const [locations, setLocations] = useState<StorageEligibleLocation[] | null>(null);
  const [drafts, setDrafts] = useState<CycleCountDraftStatus[] | null>(null);
  const [stockedLocationIds, setStockedLocationIds] = useState<Set<string>>(new Set());
  /** Every item/location balance row for the org -- one already-batched
   * listInventoryBalancesForOrganization call, never a per-item request
   * (Part "PERFORMANCE"); buildCycleCountDisplayItems filters this down to
   * the selected location's positive balances. */
  const [balanceRows, setBalanceRows] = useState<InventoryBalanceRowLike[]>([]);

  const [cycleCountId, setCycleCountId] = useState<string | null>(null);
  const [cycleCountVersion, setCycleCountVersion] = useState<number>(1);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [locationName, setLocationName] = useState("");
  const [lines, setLines] = useState<CycleCountLineDetail[] | null>(null);
  const [searchableItems, setSearchableItems] = useState<CycleCountSearchableItem[] | null>(null);
  const [itemSearch, setItemSearch] = useState("");

  const [staleItemIds, setStaleItemIds] = useState<Set<string>>(new Set());
  const [staleBanner, setStaleBanner] = useState<StaleCycleCountLine[] | null>(null);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);

  const [completedSummary, setCompletedSummary] = useState<{ countedLineCount: number; varianceLineCount: number } | null>(null);
  const [blockedStartedByName, setBlockedStartedByName] = useState("");
  const [historicalDetail, setHistoricalDetail] = useState<CycleCountDetail | null>(null);
  const [historicalLines, setHistoricalLines] = useState<CycleCountLineDetail[] | null>(null);
  const [completionNote, setCompletionNote] = useState("");
  const [completionNoteError, setCompletionNoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadLocationPicker = useCallback(async () => {
    const [locationsResult, draftsResult, balancesResult] = await Promise.all([
      listStorageEligibleLocationsForOrganization(),
      listCycleCountDraftStatus(),
      listInventoryBalancesForOrganization(),
    ]);
    if (locationsResult.ok) setLocations(locationsResult.locations);
    if (draftsResult.ok) setDrafts(draftsResult.drafts);
    if (balancesResult.ok) {
      setStockedLocationIds(new Set(balancesResult.rows.filter((r) => r.balance > 0).map((r) => r.locationId)));
    }
  }, []);

  const draftByLocationId = useMemo(() => {
    const map = new Map<string, CycleCountDraftStatus>();
    for (const draft of drafts ?? []) map.set(draft.locationId, draft);
    return map;
  }, [drafts]);

  // Direct-URL protection (Part "DIRECT URL PROTECTION"): a countId in the
  // URL never trusts the location picker to have gated access -- the
  // detail/lines fetch below re-derives ownership server-side on every
  // load, exactly like every other entry into the counting screen.
  const loadCountingScreen = useCallback(async (id: string) => {
    const detailResult = await getCycleCountDetailAction(id);
    if (!detailResult.ok) {
      setError(detailResult.message);
      setStep("pick_location");
      await loadLocationPicker();
      return;
    }
    if (!detailResult.detail) {
      setError("This cycle count was not found.");
      setStep("pick_location");
      await loadLocationPicker();
      return;
    }

    // COMPLETED/CANCELLED counts are historical -- read-only, viewable by
    // any same-org manager regardless of who performed them (Part
    // "HISTORY ACCESS / ORGANIZATION ISOLATION"), checked BEFORE ownership
    // since ownership only ever gates an active DRAFT.
    if (detailResult.detail.status !== "DRAFT") {
      const linesResult = await listCycleCountLinesAction(id);
      setHistoricalDetail(detailResult.detail);
      setHistoricalLines(linesResult.ok ? linesResult.lines : []);
      setStep("historical_detail");
      return;
    }

    if (!detailResult.detail.isOwnedByCurrentManager) {
      setLocationName(detailResult.detail.locationName);
      setBlockedStartedByName(detailResult.detail.startedByName);
      setStep("blocked");
      return;
    }

    const [linesResult, itemsResult, balancesResult] = await Promise.all([
      listCycleCountLinesAction(id),
      listActiveInventoryItemsForCycleCountAction(),
      listInventoryBalancesForOrganization(),
    ]);

    if (!linesResult.ok) {
      // Belt-and-suspenders: detail said "owned by me" but the lines
      // fetch's own independent ownership check disagreed (should never
      // happen outside a race with a concurrent ownership change) --
      // still never render editable line data in that case.
      setBlockedStartedByName(detailResult.detail.startedByName);
      setStep("blocked");
      return;
    }

    setCycleCountId(detailResult.detail.id);
    setCycleCountVersion(detailResult.detail.version);
    setLocationId(detailResult.detail.locationId);
    setLocationName(detailResult.detail.locationName);
    if (balancesResult.ok) setBalanceRows(balancesResult.rows);
    setLines(linesResult.lines);
    if (itemsResult.ok) setSearchableItems(itemsResult.items);
    setStep("counting");
  }, [loadLocationPicker]);

  useEffect(() => {
    if (initialCountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadCountingScreen(initialCountId);
    } else {
      loadLocationPicker();
    }
    // Deliberately runs once on mount only -- initialCountId is a one-time
    // deep link, not something that re-triggers this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSelectLocation(locationId: string) {
    setError(null);
    setBusy(true);
    const result = await startOrResumeCycleCountAction(locationId);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await loadCountingScreen(result.result.cycleCountId);
  }

  // AUTO-POPULATED CURRENT INVENTORY (Part "WHAT SHOULD AUTO-POPULATE" /
  // "COUNT SNAPSHOT SEMANTICS") -- see app/manager/(app)/inventory/_lib/
  // cycleCountDisplayItems.ts for the full contract. Displaying a row here
  // NEVER creates a cycle_count_line by itself -- that only happens the
  // moment the manager actually saves a physical count for it
  // (handleSavePhysicalCount below), which is also the moment its
  // expected-quantity/watermark snapshot gets captured.
  const displayItems = useMemo<DisplayItem[]>(() => {
    if (!lines || !searchableItems || !locationId) return [];
    return buildCycleCountDisplayItems(locationId, balanceRows, searchableItems, lines);
  }, [locationId, balanceRows, searchableItems, lines]);

  const groupedDisplayItems = useMemo(() => groupDisplayItemsByCategory(displayItems), [displayItems]);

  // Search's purpose is finding an item NOT already shown above (Part
  // "SEARCH REMAINS IMPORTANT") -- everything already displayed (whether a
  // real line or a live positive-balance row) is excluded, so a search
  // result can never duplicate a row already on screen.
  const displayedItemIds = useMemo(() => new Set(displayItems.map((item) => item.inventoryItemId)), [displayItems]);

  const suggestedItems = useMemo(() => {
    if (!searchableItems) return [];
    return filterSuggestedItems(searchableItems, displayedItemIds, itemSearch);
  }, [searchableItems, itemSearch, displayedItemIds]);

  function upsertLine(line: CycleCountLineDetail) {
    setLines((current) => {
      const existing = current ?? [];
      const idx = existing.findIndex((l) => l.inventoryItemId === line.inventoryItemId);
      if (idx === -1) return [...existing, line];
      const next = [...existing];
      next[idx] = line;
      return next;
    });
  }

  /** Explicit "Add" from search -- creates the line immediately (blank
   * physical count), since choosing to add a zero-stock item IS itself a
   * deliberate manager action, unlike a merely-displayed positive-balance
   * row (Part "SEARCH REMAINS IMPORTANT" example: Mozzarella at 0 PIECE). */
  async function handleAddItem(itemId: string) {
    if (!cycleCountId) return;
    const result = await addCycleCountLineAction(cycleCountId, itemId);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    const item = searchableItems?.find((i) => i.id === itemId);
    upsertLine({
      id: result.result.lineId,
      inventoryItemId: itemId,
      itemName: item?.name ?? "",
      categoryName: item?.categoryName ?? "",
      baseUnitCode: item?.baseUnitCode ?? "",
      expectedQuantityAtSnapshot: result.result.expectedQuantityAtSnapshot,
      physicalCountQuantity: result.result.physicalCountQuantity,
      identifiedWasteQuantity: null,
      wasteEventId: null,
      wasteResolvedAt: null,
      wasteReasonCode: null,
      wasteNote: null,
    });
    setItemSearch("");
  }

  /** The ONLY place a virtual (auto-displayed) row becomes a real
   * cycle_count_line -- exactly when the manager saves an actual physical
   * observation for it, which is also exactly when its expected-quantity
   * snapshot and ledger watermark get captured (Part "COUNT SNAPSHOT
   * SEMANTICS": "manager enters physical count for item: create/add
   * cycle-count line and capture authoritative expected quantity +
   * watermark at that point"). */
  async function handleSavePhysicalCount(item: DisplayItem, rawValue: string) {
    if (!cycleCountId) return;
    const trimmed = rawValue.trim();
    const nextValue = trimmed === "" ? null : trimmed;

    // Nothing to do: still blank, and there's nothing recorded yet either
    // way (no line at all, or a line whose observation is already blank).
    if (nextValue === null && item.physicalCountQuantity === null) return;
    // Unchanged value re-saved (e.g. blur without edits) -- skip the round trip.
    if (nextValue !== null && item.physicalCountQuantity !== null && Number(nextValue) === Number(item.physicalCountQuantity)) return;

    let lineId = item.lineId;
    if (lineId === null) {
      const addResult = await addCycleCountLineAction(cycleCountId, item.inventoryItemId);
      if (!addResult.ok) {
        setError(addResult.message);
        return;
      }
      lineId = addResult.result.lineId;
    }

    const wasStale = staleItemIds.has(item.inventoryItemId);
    const result = await recordCycleCountLineObservationAction(cycleCountId, item.inventoryItemId, nextValue, wasStale);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    if (wasStale) {
      setStaleItemIds((current) => {
        const next = new Set(current);
        next.delete(item.inventoryItemId);
        return next;
      });
    }
    upsertLine({
      id: lineId,
      inventoryItemId: item.inventoryItemId,
      itemName: item.itemName,
      categoryName: item.categoryName,
      baseUnitCode: item.baseUnitCode,
      expectedQuantityAtSnapshot: result.result.expectedQuantityAtSnapshot,
      physicalCountQuantity: result.result.physicalCountQuantity,
      identifiedWasteQuantity: item.identifiedWasteQuantity,
      wasteEventId: item.wasteEventId,
      wasteResolvedAt: null,
      wasteReasonCode: item.wasteReasonCode as WasteReasonCode | null,
      wasteNote: null,
    });
  }

  /** Provisional "waste found during count" marker (Part 22/23) -- never
   * touches the ledger. The manager can flag/unflag/adjust freely while
   * still DRAFT; nothing posts until Review explicitly records it. */
  async function handleMarkKnownWaste(item: DisplayItem, quantity: string | null) {
    if (!cycleCountId) return;
    const result = await markCycleCountLineKnownWasteAction(cycleCountId, item.inventoryItemId, quantity);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setLines((existing) => {
      if (!existing) return existing;
      return existing.map((line) =>
        line.inventoryItemId === item.inventoryItemId ? { ...line, identifiedWasteQuantity: result.result.identifiedWasteQuantity } : line
      );
    });
  }

  const countedLines = useMemo(() => (lines ?? []).filter((l) => l.physicalCountQuantity !== null), [lines]);
  const unresolvedKnownWasteLines = useMemo(
    () => (lines ?? []).filter((l) => l.identifiedWasteQuantity !== null && l.wasteEventId === null),
    [lines]
  );
  const varianceLines = useMemo(
    () => countedLines.filter((l) => Number(l.physicalCountQuantity) !== Number(l.expectedQuantityAtSnapshot)),
    [countedLines]
  );

  async function handleComplete() {
    if (!cycleCountId) return;
    if (completionNote.trim() === "") {
      setCompletionNoteError("A completion note is required.");
      return;
    }
    setCompletionNoteError(null);
    setBusy(true);
    setError(null);
    const result = await completeCycleCountAction(cycleCountId, cycleCountVersion, completionNote);
    setBusy(false);
    if (!result.ok) {
      if (result.reason === "stale") {
        setStaleItemIds(new Set(result.staleLines.map((l) => l.inventoryItemId)));
        setStaleBanner(result.staleLines);
        setStep("counting");
        // The DRAFT was never completed -- the manager's typed note is
        // deliberately kept in local state (Part "SERVER COMPLETION
        // CONTRACT": "the DRAFT may retain the textarea locally in UI
        // state") so they don't have to retype it after recounting.
        return;
      }
      if (result.reason === "missing_note") {
        setCompletionNoteError(result.message);
        return;
      }
      setError(result.message);
      return;
    }
    setCompletedSummary({ countedLineCount: result.result.countedLineCount, varianceLineCount: result.result.varianceLineCount });
    setStep("done");
  }

  async function handleCancel() {
    if (!cycleCountId) return;
    if (cancelReason.trim() === "") {
      setCancelError("A reason is required.");
      return;
    }
    setCancelPending(true);
    const result = await cancelCycleCountAction(cycleCountId, cycleCountVersion, cancelReason);
    setCancelPending(false);
    if (!result.ok) {
      setCancelError(result.message);
      return;
    }
    setShowCancelModal(false);
    setCancelReason("");
    setCancelError(null);
    setCycleCountId(null);
    setLines(null);
    setStaleItemIds(new Set());
    setStaleBanner(null);
    setCompletionNote("");
    setCompletionNoteError(null);
    setStep("pick_location");
    await loadLocationPicker();
  }

  // ============================================================
  // pick_location
  // ============================================================
  if (step === "pick_location") {
    return (
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <Link href="/manager/inventory/cycle-count" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
            ← Cycle Count
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">Cycle Count</h1>
          <p className="mt-1 text-sm text-zinc-500">Select a storage location to physically count.</p>
        </div>
        {error ? <p className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p> : null}
        {locations === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : locations.length === 0 ? (
          <EmptyState message="No storage-eligible locations found." />
        ) : (
          <div className="flex flex-col gap-2">
            {locations.map((location) => {
              const draft = draftByLocationId.get(location.id);
              if (draft) {
                // Own draft: same "Resume" affordance as before. Someone
                // else's draft: deliberately NOT a disabled "Resume" button
                // (Part "UI" -- "must clearly look unavailable, not
                // broken") -- a differently-styled, differently-labeled
                // status pill that explains WHY, with who/when.
                return (
                  <div key={location.id} className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                    <div>
                      <p className="text-sm font-semibold text-zinc-100">{location.name}</p>
                      <p className="text-xs text-amber-400">In progress</p>
                      <p className="text-xs text-zinc-500">
                        Started by {draft.isOwnedByCurrentManager ? "you" : draft.startedByName} · {formatTime(draft.startedAt)}
                      </p>
                    </div>
                    {draft.canResume ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleSelectLocation(location.id)}
                        className={primaryButtonClass}
                      >
                        Resume
                      </button>
                    ) : (
                      <span
                        className="rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-500"
                        title={`Started by ${draft.startedByName} -- only they can resume this count.`}
                      >
                        In Progress
                      </span>
                    )}
                  </div>
                );
              }
              return (
                <div key={location.id} className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">{location.name}</p>
                    {stockedLocationIds.has(location.id) ? null : <p className="text-xs text-zinc-600">No stock recorded here yet</p>}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSelectLocation(location.id)}
                    className={primaryButtonClass}
                  >
                    Start Count
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ============================================================
  // blocked -- direct-URL / stale-picker protection: never render another
  // manager's editable draft, only a safe explanation (Part "DIRECT URL
  // PROTECTION").
  // ============================================================
  if (step === "blocked") {
    return (
      <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
        <p className="text-lg font-semibold text-zinc-100">Cycle count in progress</p>
        <p className="max-w-sm text-sm text-zinc-400">
          {locationName ? `${locationName}: this` : "This"} count was started by {blockedStartedByName || "another manager"} and can only be resumed by
          that manager.
        </p>
        <Link
          href="/manager/inventory/cycle-count"
          className="mt-2 rounded-full border border-zinc-700 px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
        >
          Back to Cycle Count
        </Link>
      </div>
    );
  }

  // ============================================================
  // counting
  // ============================================================
  if (step === "counting") {
    return (
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <Link href="/manager/inventory/cycle-count" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
            ← Cycle Count
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">Cycle Count</h1>
          <p className="text-sm text-zinc-400">{locationName}</p>
          <p className="mt-1 text-xs text-zinc-500">Count only what you physically verify. Blank items will not be changed.</p>
        </div>

        {error ? <p className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p> : null}

        {staleBanner ? (
          <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">
            <p className="font-semibold">Inventory changed while you were counting.</p>
            <ul className="mt-2 flex flex-col gap-2">
              {staleBanner.map((l) => {
                const item = displayItems.find((x) => x.inventoryItemId === l.inventoryItemId);
                return (
                  <li key={l.inventoryItemId}>
                    <span className="font-medium text-amber-100">{item?.itemName ?? l.inventoryItemId}</span>
                    <span className="ml-2 text-amber-300">
                      was {formatQuantity(l.snapshotExpectedQuantity)}, now {formatQuantity(l.currentExpectedQuantity)}
                      {item ? ` ${item.baseUnitCode}` : ""} -- please recount.
                    </span>
                  </li>
                );
              })}
            </ul>
            <button type="button" onClick={() => setStaleBanner(null)} className="mt-2 text-xs text-amber-400 underline">
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Search or add another item…
            <input
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Find an item not listed below"
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
            />
          </label>
          {itemSearch.trim() !== "" ? (
            <div className="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto">
              {suggestedItems.length === 0 ? (
                <p className="text-sm text-zinc-500">No matching items.</p>
              ) : (
                suggestedItems.slice(0, 25).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleAddItem(item.id)}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>
                      {item.name}
                      <span className="ml-2 text-xs text-zinc-500">{item.categoryName}</span>
                    </span>
                    <span className="text-xs text-amber-400">Add</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {displayItems.length === 0 ? (
          <EmptyState message="No current inventory found at this location. Search above to add an item you physically find." />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Current Inventory</p>
              <p className="text-xs text-zinc-500">
                {displayItems.length} {displayItems.length === 1 ? "item" : "items"}
              </p>
            </div>
            {groupedDisplayItems.map((group) => (
              <div key={group.categoryName} className="flex flex-col gap-2">
                {groupedDisplayItems.length > 1 ? (
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600">{group.categoryName || "Uncategorized"}</p>
                ) : null}
                {group.items.map((item) => (
                  <CycleCountRow
                    key={item.inventoryItemId}
                    item={item}
                    stale={staleItemIds.has(item.inventoryItemId)}
                    onSave={(value) => handleSavePhysicalCount(item, value)}
                    onMarkWaste={(quantity) => handleMarkKnownWaste(item, quantity)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-400">
            {countedLines.length} {countedLines.length === 1 ? "item" : "items"} counted
          </p>
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => setShowCancelModal(true)} className="text-xs text-zinc-500 underline underline-offset-2 hover:text-red-400">
              Cancel Cycle Count
            </button>
            <button
              type="button"
              disabled={countedLines.length === 0}
              onClick={() => setStep("review")}
              className={primaryButtonClass}
            >
              Review Cycle Count →
            </button>
          </div>
        </div>

        {showCancelModal ? (
          <CancelModal
            reason={cancelReason}
            onReasonChange={setCancelReason}
            error={cancelError}
            pending={cancelPending}
            onCancel={() => {
              setShowCancelModal(false);
              setCancelError(null);
            }}
            onConfirm={handleCancel}
          />
        ) : null}
      </div>
    );
  }

  // ============================================================
  // review
  // ============================================================
  if (step === "review") {
    return (
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Review Cycle Count</h1>
          <p className="text-sm text-zinc-400">{locationName}</p>
        </div>
        {error ? <p className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p> : null}
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {countedLines.length} {countedLines.length === 1 ? "ITEM" : "ITEMS"} COUNTED -- {varianceLines.length} {varianceLines.length === 1 ? "VARIANCE" : "VARIANCES"}
        </p>
        <div className="flex flex-col gap-2">
          {countedLines.map((line) => {
            const physical = Number(line.physicalCountQuantity);
            const expected = Number(line.expectedQuantityAtSnapshot);
            const variance = physical - expected;
            return (
              <div key={line.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold text-zinc-100">{line.itemName}</p>
                <div className="mt-1 flex items-baseline justify-between text-sm">
                  <span className="text-zinc-400">
                    {formatQuantity(expected)} → {formatQuantity(physical)} {line.baseUnitCode}
                  </span>
                  {variance === 0 ? (
                    <span className="text-zinc-500">No variance</span>
                  ) : (
                    <span className={variance > 0 ? "font-semibold text-emerald-400" : "font-semibold text-red-400"}>
                      {variance > 0 ? "+" : ""}
                      {formatQuantity(variance)} {line.baseUnitCode}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {unresolvedKnownWasteLines.length > 0 ? (
          <div className="rounded-2xl border border-amber-800/40 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Known Waste Found</p>
            <p className="mt-1 text-xs text-zinc-500">
              These known losses should be recorded as Inventory Waste before final Cycle Count reconciliation.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {unresolvedKnownWasteLines.map((line) => (
                <KnownWasteReviewCard
                  key={line.id}
                  line={line}
                  cycleCountId={cycleCountId!}
                  onRecorded={(updated) => setLines((existing) => (existing ? existing.map((l) => (l.id === line.id ? { ...l, ...updated } : l)) : existing))}
                  onStale={() => {
                    setStaleItemIds(new Set([line.inventoryItemId]));
                    setError(`Inventory changed since ${line.itemName} was counted. Recount it before recording waste.`);
                    setStep("counting");
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-zinc-200">
            Cycle Count Notes *
            <span className="text-xs font-normal text-zinc-500">Briefly explain the count results, any discrepancies, or relevant context.</span>
            <textarea
              value={completionNote}
              onChange={(e) => {
                setCompletionNote(e.target.value);
                if (completionNoteError) setCompletionNoteError(null);
              }}
              placeholder="Example: Dairy inventory was lower than expected due to unrecorded prep usage over the weekend."
              rows={4}
              className="mt-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </label>
          {completionNoteError ? <p className="mt-2 text-xs text-red-400">{completionNoteError}</p> : null}
        </div>

        {unresolvedKnownWasteLines.length > 0 ? (
          <p className="text-center text-xs text-amber-400">Known waste must be recorded before this cycle count can be completed.</p>
        ) : null}

        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={() => setStep("counting")}
            className={secondaryButtonClass}
          >
            Back to Count
          </button>
          <button
            type="button"
            disabled={busy || completionNote.trim() === "" || unresolvedKnownWasteLines.length > 0}
            onClick={handleComplete}
            className={primaryButtonClass}
          >
            {busy ? "Completing…" : "Complete Cycle Count"}
          </button>
        </div>
      </div>
    );
  }

  // ============================================================
  // historical_detail -- read-only, no mutation actions (Part
  // "HISTORICAL DETAIL VIEW" / "CANCELLED DETAIL"). Viewable by any
  // same-org manager (Part "HISTORY ACCESS"), not gated on ownership.
  // ============================================================
  if (step === "historical_detail" && historicalDetail) {
    const detail = historicalDetail;
    const isCancelled = detail.status === "CANCELLED";
    const countedHistoricalLines = (historicalLines ?? []).filter((l) => l.physicalCountQuantity !== null);
    const historicalVarianceCount = countedHistoricalLines.filter(
      (l) => Number(l.physicalCountQuantity) !== Number(l.expectedQuantityAtSnapshot)
    ).length;

    return (
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <Link href="/manager/inventory/cycle-count" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
            ← Cycle Count
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-xl font-semibold text-zinc-100">Cycle Count</h1>
            <StatusBadge label={isCancelled ? "Cancelled" : "Completed"} tone={isCancelled ? "neutral" : "success"} />
          </div>
          <p className="text-sm text-zinc-400">{detail.locationName}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Started</p>
            <p className="mt-1 text-sm text-zinc-200">{formatDateTime(detail.startedAt)}</p>
            <p className="text-sm text-zinc-400">{detail.startedByName}</p>
          </div>
          {!isCancelled ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Completed</p>
              <p className="mt-1 text-sm text-zinc-200">{detail.completedAt ? formatDateTime(detail.completedAt) : "—"}</p>
              <p className="text-sm text-zinc-400">{detail.completedByName}</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Cancelled</p>
              <p className="mt-1 text-sm text-zinc-200">{detail.cancelledAt ? formatDateTime(detail.cancelledAt) : "—"}</p>
              <p className="text-sm text-zinc-400">{detail.cancelledByName}</p>
            </div>
          )}
        </div>

        {!isCancelled ? (
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {countedHistoricalLines.length} {countedHistoricalLines.length === 1 ? "item" : "items"} counted -- {historicalVarianceCount}{" "}
            {historicalVarianceCount === 1 ? "variance" : "variances"}
          </p>
        ) : null}

        {isCancelled ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Cancellation Reason</p>
            <p className="mt-2 text-sm text-zinc-200">{detail.cancellationReason}</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Cycle Count Notes</p>
            {detail.completionNote ? (
              <p className="mt-2 text-sm text-zinc-200">{detail.completionNote}</p>
            ) : (
              <p className="mt-2 text-sm text-zinc-600">No completion note — completed before notes were required.</p>
            )}
          </div>
        )}

        {!isCancelled && countedHistoricalLines.some((l) => l.wasteEventId !== null) ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Known Waste Recorded</p>
            <div className="mt-2 flex flex-col gap-2">
              {countedHistoricalLines
                .filter((l) => l.wasteEventId !== null)
                .map((l) => (
                  <div key={l.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-zinc-200">{l.itemName}</p>
                      <p className="text-xs text-zinc-500">
                        {formatQuantity(Number(l.identifiedWasteQuantity))} {l.baseUnitCode}
                        {l.wasteReasonCode ? ` · ${WASTE_REASON_LABELS[l.wasteReasonCode]}` : ""}
                      </p>
                    </div>
                    <Link href={`/manager/inventory/waste/${l.wasteEventId}`} className="text-xs font-medium text-amber-400 hover:underline">
                      Inventory Waste record →
                    </Link>
                  </div>
                ))}
            </div>
          </div>
        ) : null}

        {countedHistoricalLines.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {isCancelled ? "Draft Observations" : "Cycle Count Variance"}
            </p>
            {isCancelled ? (
              <p className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-3 text-xs text-amber-300">
                No inventory adjustments were applied. This count was cancelled before completion.
              </p>
            ) : null}
            {countedHistoricalLines.map((line) => {
              const physical = Number(line.physicalCountQuantity);
              const expected = Number(line.expectedQuantityAtSnapshot);
              const variance = physical - expected;
              return (
                <div key={line.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <p className="text-sm font-semibold text-zinc-100">{line.itemName}</p>
                  <div className="mt-1 flex items-baseline justify-between text-sm">
                    <span className="text-zinc-400">
                      {formatQuantity(expected)} {line.baseUnitCode} {line.wasteEventId !== null ? "expected (after known waste)" : "expected"} →{" "}
                      {formatQuantity(physical)} {line.baseUnitCode} physical
                    </span>
                    {variance === 0 ? (
                      <span className="text-zinc-500">No variance</span>
                    ) : (
                      <span className={variance > 0 ? "font-semibold text-emerald-400" : "font-semibold text-red-400"}>
                        {line.wasteEventId !== null ? "Remaining unexplained variance" : "Variance"}: {variance > 0 ? "+" : ""}
                        {formatQuantity(variance)} {line.baseUnitCode}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  // ============================================================
  // done
  // ============================================================
  return (
    <div className="mt-4 flex flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
      <p className="text-lg font-semibold text-zinc-100">Cycle Count Completed</p>
      <p className="text-sm text-zinc-400">
        {completedSummary?.countedLineCount ?? 0} items counted -- {completedSummary?.varianceLineCount ?? 0} adjusted
      </p>
      <Link href="/manager/inventory/cycle-count" className={primaryButtonClass}>
        Back to Cycle Count
      </Link>
    </div>
  );
}

function CycleCountRow({
  item,
  stale,
  onSave,
  onMarkWaste,
}: {
  item: DisplayItem;
  stale: boolean;
  onSave: (value: string) => void;
  onMarkWaste: (quantity: string | null) => void;
}) {
  const [value, setValue] = useState(item.physicalCountQuantity ?? "");
  // Adjust local input state DURING render when the saved value changes
  // out from under us (e.g. a stale-recount reset) -- react.dev's own
  // recommended pattern for this, cheaper than an effect + extra render.
  const [lastSeenQuantity, setLastSeenQuantity] = useState(item.physicalCountQuantity);
  if (item.physicalCountQuantity !== lastSeenQuantity) {
    setLastSeenQuantity(item.physicalCountQuantity);
    setValue(item.physicalCountQuantity ?? "");
  }

  const hasCount = item.physicalCountQuantity !== null;
  const physical = hasCount ? Number(item.physicalCountQuantity) : null;
  const expected = Number(item.expectedQuantity);
  const variance = physical !== null ? physical - expected : null;

  // Waste found during count (Part 22/23) -- provisional only, never a
  // ledger write. Only offered for a genuine NEGATIVE variance (Part
  // 30 -- positive variance can never be explained as waste), and only
  // while unresolved (a resolved line's checkbox becomes a read-only
  // summary instead, Phase F never re-editable through this path).
  const [wasteQty, setWasteQty] = useState(item.identifiedWasteQuantity ?? (variance !== null && variance < 0 ? String(-variance) : ""));
  const [lastSeenWasteQty, setLastSeenWasteQty] = useState(item.identifiedWasteQuantity);
  if (item.identifiedWasteQuantity !== lastSeenWasteQty) {
    setLastSeenWasteQty(item.identifiedWasteQuantity);
    setWasteQty(item.identifiedWasteQuantity ?? (variance !== null && variance < 0 ? String(-variance) : ""));
  }
  const wasteChecked = item.identifiedWasteQuantity !== null;

  return (
    <div className={`rounded-2xl border p-4 ${stale ? "border-amber-700 bg-amber-950/20" : "border-zinc-800 bg-zinc-900"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100">{item.itemName}</p>
          <p className="truncate text-xs text-zinc-500">{item.categoryName}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-zinc-500">System Expected</p>
          <p className="text-sm text-zinc-200">
            {formatQuantity(expected)} {item.baseUnitCode}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Physical Count
          <div className="flex items-center gap-2">
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => onSave(value)}
              placeholder="Not counted"
              className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
            />
            <span className="text-xs text-zinc-500">{item.baseUnitCode}</span>
          </div>
        </label>
        {variance !== null ? (
          <div className="text-right">
            <p className="text-xs text-zinc-500">Variance</p>
            <p className={`text-sm font-semibold ${variance === 0 ? "text-zinc-400" : variance > 0 ? "text-emerald-400" : "text-red-400"}`}>
              {variance === 0 ? "0" : `${variance > 0 ? "+" : ""}${formatQuantity(variance)}`} {item.baseUnitCode}
            </p>
          </div>
        ) : null}
      </div>

      {variance !== null && variance < 0 ? (
        item.wasteEventId !== null ? (
          <div className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
            Waste recorded: {formatQuantity(Number(item.identifiedWasteQuantity))} {item.baseUnitCode}
          </div>
        ) : (
          <div className="mt-3 border-t border-zinc-800 pt-3">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={wasteChecked}
                onChange={(e) => {
                  if (e.target.checked) {
                    const fallback = String(-variance);
                    setWasteQty((current) => (current.trim() === "" ? fallback : current));
                    onMarkWaste(wasteQty.trim() === "" ? fallback : wasteQty);
                  } else {
                    onMarkWaste(null);
                  }
                }}
              />
              Waste found during count
            </label>
            {wasteChecked ? (
              <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                Known Waste Quantity
                <input
                  inputMode="decimal"
                  value={wasteQty}
                  onChange={(e) => setWasteQty(e.target.value)}
                  onBlur={() => onMarkWaste(wasteQty)}
                  className="w-24 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
                />
                <span>{item.baseUnitCode}</span>
              </label>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * One line in the Review step's "Known Waste Found" section (Part 24) --
 * pre-fills location/item/quantity (all implicit -- the line already IS
 * scoped to this cycle count's location and this item), and the manager
 * only chooses Reason + Note before recording. This is the ONLY place
 * cycle-count-identified waste actually posts (Phase F); a STALE result
 * means unrelated inventory activity happened since counting and routes
 * back to Counting for a recount (Part 26), writing zero waste.
 */
function KnownWasteReviewCard({
  line,
  cycleCountId,
  onRecorded,
  onStale,
}: {
  line: CycleCountLineDetail;
  cycleCountId: string;
  onRecorded: (updated: Partial<CycleCountLineDetail>) => void;
  onStale: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<WasteReasonCode | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const isNoteOk = reasonCode !== "OTHER" || note.trim() !== "";
  const canSubmit = reasonCode !== null && isNoteOk && !busy;

  async function submit() {
    if (!reasonCode) return;
    setBusy(true);
    setError(null);
    const result = await recordCycleCountLineWasteAction(
      cycleCountId,
      line.inventoryItemId,
      reasonCode,
      note.trim() === "" ? null : note.trim(),
      clientRequestId
    );
    setBusy(false);
    if (!result.ok) {
      if (result.reason === "stale") {
        onStale();
        return;
      }
      setError(result.message);
      return;
    }
    onRecorded({
      wasteEventId: result.result.wasteEventId,
      wasteResolvedAt: new Date().toISOString(),
      wasteReasonCode: reasonCode,
      wasteNote: note.trim() === "" ? null : note.trim(),
      expectedQuantityAtSnapshot: result.result.newExpectedQuantity,
    });
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-100">{line.itemName}</p>
        <p className="text-sm text-zinc-400">
          {formatQuantity(Number(line.identifiedWasteQuantity))} {line.baseUnitCode}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {WASTE_REASON_CODES.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setReasonCode(code)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              reasonCode === code ? "bg-amber-400 text-zinc-950" : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            {WASTE_REASON_LABELS[code]}
          </button>
        ))}
      </div>
      {reasonCode !== null ? (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder={reasonCode === "OTHER" ? "Describe the reason for this waste (required)…" : "Optional note…"}
          className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600"
        />
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="mt-2 w-full rounded-full bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40"
      >
        {busy ? "Recording…" : "Review & Record Waste"}
      </button>
    </div>
  );
}

function CancelModal({
  reason,
  onReasonChange,
  error,
  pending,
  onCancel,
  onConfirm,
}: {
  reason: string;
  onReasonChange: (value: string) => void;
  error: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Cancel Cycle Count</h2>
        <p className="mt-2 text-sm text-zinc-400">This creates no inventory adjustments. The count record is kept, marked cancelled.</p>
        <label className="mt-4 flex flex-col gap-1 text-xs text-zinc-400">
          Reason
          <input
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
        </label>
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded-full bg-red-500 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
          >
            {pending ? "Cancelling…" : "Cancel Count"}
          </button>
          <button type="button" onClick={onCancel} className="text-sm text-zinc-400 underline">
            Keep Working
          </button>
        </div>
      </div>
    </div>
  );
}
