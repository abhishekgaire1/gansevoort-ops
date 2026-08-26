"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { verifyPin } from "@/app/actions/pin";
import { listActiveStations } from "@/app/actions/stations";
import { listActiveInventoryItems } from "@/app/actions/inventoryItems";
import { getEmployeeRecentWithdrawnItemIds } from "@/app/actions/recentItems";
import { getInventorySearchSignals } from "@/app/actions/searchSignals";
import { getKioskUsageUnits } from "@/app/actions/withdrawalUnit";
import { getKioskItemAvailabilityAction } from "@/app/actions/inventoryAvailability";
import { refreshKioskSession } from "@/app/actions/kioskSession";
import { recordWithdrawalBatch } from "@/app/actions/withdrawalBatch";
import { computeStockGauge } from "@/app/lib/inventory/stockLevel";
import { stockTrafficLight, stockTrafficLightClass } from "@/app/lib/kiosk/stockTrafficLight";
import { createInitialKioskState, kioskReducer, cartLineKey, type CartLine } from "@/app/kiosk/_lib/kioskReducer";
import { resolveStationBranch } from "@/app/kiosk/_lib/stationBranch";
import { decideSessionTick } from "@/app/kiosk/_lib/sessionRefresh";
import { isValidWithdrawalQuantity } from "@/app/kiosk/_lib/quantityEntry";
import { deriveItemCategories, filterItemsByCategory } from "@/app/kiosk/_lib/itemFilter";
import { rankSearchResults, type SearchCandidateItem } from "@/app/kiosk/_lib/search";
import { KioskShell } from "./KioskShell";
import { KioskScreen } from "./KioskScreen";
import { KioskHeader } from "./KioskHeader";
import { EmployeeStatusBar } from "./EmployeeStatusBar";
import { ItemContextHeader } from "./ItemContextHeader";
import { NumericKeypad } from "./NumericKeypad";
import { QuantityKeypad } from "./QuantityKeypad";
import { PinDisplay } from "./PinDisplay";
import { StationCard } from "./StationCard";
import { ItemSearch } from "./ItemSearch";
import { ItemCard } from "./ItemCard";
import { RecentItemsStrip } from "./RecentItemsStrip";
import { WithdrawalQuantityDisplay } from "./WithdrawalQuantityDisplay";
import { QuantityEntrySkeleton } from "./QuantityEntrySkeleton";
import { StockAvailabilityCard } from "./StockAvailabilityCard";
import { UsageUnitSelector } from "./UsageUnitSelector";
import { SetupRequiredNotice } from "./SetupRequiredNotice";
import { CardGridSkeleton } from "./CardGridSkeleton";
import { CartReviewGroups } from "./CartReviewGroups";
import { SuccessState } from "./SuccessState";
import { ErrorState } from "./ErrorState";

const PIN_LENGTH = 4;
const SESSION_TICK_INTERVAL_MS = 5000;
const GENERIC_NETWORK_ERROR = "Something went wrong. Please try again.";
const GENERIC_SUBMIT_ERROR = "This withdrawal couldn't be completed. You can try again or go back to make changes.";

function formatKioskQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** How much of a location's stock the cart has already claimed for this
 * item -- a UI courtesy only (2A.5 "CART-AWARE AVAILABLE QUANTITY"), never
 * a real reservation. Excludes the line currently being edited, if any,
 * so editing a line's own quantity never double-counts against itself. */
function cartReservedQuantity(cart: CartLine[], inventoryItemId: string, sourceLocationId: string, excludeLineId: string | null): number {
  const line = cart.find((l) => l.id === cartLineKey(inventoryItemId, sourceLocationId) && l.id !== excludeLineId);
  return line ? Number(line.enteredQuantity) || 0 : 0;
}

/**
 * Orchestrator: owns the whole kiosk state machine and is the only
 * component that calls Server Actions directly, so the server-communication
 * surface stays auditable in one place. Deliberately never performs a
 * Next.js route transition between steps -- every "screen" below is a
 * conditional render of this one mounted component tree, which is what
 * lets kioskToken live purely in client memory (see kioskReducer.ts).
 */
export function KioskApp() {
  const [state, dispatch] = useReducer(kioskReducer, undefined, createInitialKioskState);
  const [pinDigits, setPinDigits] = useState("");
  // Derived, not separate state: pinDigits stays at PIN_LENGTH for the
  // whole in-flight verifyPin call (it's only cleared once the call
  // settles), so this needs no setState call of its own -- avoids
  // synchronous setState-in-effect (see the PIN-verification effect below).
  const pinSubmitting = pinDigits.length === PIN_LENGTH;
  const [itemQuery, setItemQuery] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const handleActivity = useCallback(() => dispatch({ type: "ACTIVITY_PING" }), []);
  const handleRetry = useCallback(() => {
    dispatch({ type: "DISMISS_SCREEN_ERROR" });
    setRetryTick((tick) => tick + 1);
  }, []);
  // Raw, unconditional reset -- used by the success screen's Finish
  // action (the cart is already empty by then) and by the confirm
  // dialog's own "Discard & Start Over" button.
  const handleStartOver = useCallback(() => dispatch({ type: "START_OVER" }), []);

  // ---- Start Over (2A.5 Part 22) --------------------------------------------
  // Never silently loses a non-empty cart: gated behind a confirm dialog
  // whenever the cart has items, exactly like Change Station below.
  const [showStartOverConfirm, setShowStartOverConfirm] = useState(false);
  const handleRequestStartOver = useCallback(() => {
    if (state.cart.length > 0) {
      setShowStartOverConfirm(true);
      return;
    }
    dispatch({ type: "START_OVER" });
  }, [state.cart.length]);
  const handleConfirmStartOver = useCallback(() => {
    setShowStartOverConfirm(false);
    dispatch({ type: "START_OVER" });
  }, []);

  // ---- Change Station (2A.5) ------------------------------------------------
  // Reachable from any authenticated screen via the persistent header. If a
  // withdrawal is already in progress (an item mid-selection, not yet added
  // to the cart) OR the cart itself has items, confirm first -- switching
  // stations must never silently carry Station A's cart into Station B.
  // Nothing to lose yet skips the prompt entirely.
  const [showChangeStationConfirm, setShowChangeStationConfirm] = useState(false);
  const handleRequestChangeStation = useCallback(() => {
    if (state.selectedItem !== null || state.cart.length > 0) {
      setShowChangeStationConfirm(true);
      return;
    }
    dispatch({ type: "REQUEST_CHANGE_STATION" });
  }, [state.selectedItem, state.cart.length]);
  const handleConfirmChangeStation = useCallback(() => {
    setShowChangeStationConfirm(false);
    dispatch({ type: "REQUEST_CHANGE_STATION" });
  }, []);

  // ---- Add to Withdrawal / edit an existing cart line (2A.5 Part 2/9) ------
  // Adding never writes inventory -- only updates the cart -- then returns
  // to browsing with a brief non-blocking confirmation. Saving an edit
  // returns to Review Withdrawal instead (no toast; the change is already
  // visible there immediately).
  const [addedToast, setAddedToast] = useState<{ message: string; nonce: number } | null>(null);
  const addedToastNonce = useRef(0);
  useEffect(() => {
    if (!addedToast) return;
    const nonce = addedToast.nonce;
    const timer = setTimeout(() => setAddedToast((current) => (current?.nonce === nonce ? null : current)), 2200);
    return () => clearTimeout(timer);
  }, [addedToast]);

  // Both completion paths share this exact same cart mutation -- only the
  // destination differs (nextStep). The toast only makes sense when
  // landing back on browsing; going straight to Review Withdrawal shows
  // the added item immediately, so no toast is needed there.
  const handleAddToCart = useCallback(
    (nextStep: "item_select" | "review") => {
      if (!state.selectedItem) return;
      const itemName = state.selectedItem.name;
      dispatch({ type: "ADD_TO_CART", nextStep });
      if (nextStep === "item_select") {
        addedToastNonce.current += 1;
        setAddedToast({ message: `Added ${itemName}`, nonce: addedToastNonce.current });
      }
    },
    [state.selectedItem]
  );

  const handleSaveCartLineEdit = useCallback((nextStep: "item_select" | "review") => dispatch({ type: "SAVE_CART_LINE_EDIT", nextStep }), []);
  const handleEditCartLine = useCallback((lineId: string) => dispatch({ type: "EDIT_CART_LINE", lineId }), []);
  const handleRemoveCartLine = useCallback((lineId: string) => dispatch({ type: "REMOVE_CART_LINE", lineId }), []);
  const handleClearCart = useCallback(() => dispatch({ type: "CLEAR_CART" }), []);
  const handleOpenReview = useCallback(() => dispatch({ type: "OPEN_REVIEW" }), []);
  const handleContinueShopping = useCallback(() => dispatch({ type: "BACK_TO_ITEMS" }), []);
  const handleWithdrawMore = useCallback(() => dispatch({ type: "WITHDRAW_MORE" }), []);

  // ---- PIN entry --------------------------------------------------------
  const handleDigit = useCallback(
    (digit: string) => {
      if (pinSubmitting) return;
      setPinDigits((prev) => (prev.length >= PIN_LENGTH ? prev : prev + digit));
    },
    [pinSubmitting]
  );

  const handleDeleteDigit = useCallback(() => {
    if (pinSubmitting) return;
    setPinDigits((prev) => prev.slice(0, -1));
  }, [pinSubmitting]);

  useEffect(() => {
    if (pinDigits.length !== PIN_LENGTH) return;
    let cancelled = false;

    (async () => {
      try {
        const result = await verifyPin(pinDigits);
        if (cancelled) return;

        if (!result.ok) {
          if (result.reason === "rate_limited") {
            dispatch({ type: "RATE_LIMITED" });
          } else {
            dispatch({ type: "PIN_FAILED", message: "Incorrect PIN. Try again." });
          }
          return;
        }

        const stationConfig = {
          defaultStationId: result.defaultStationId,
          defaultStationName: result.defaultStationName,
          autoResolveStation: result.autoResolveStation,
          canChangeStation: result.canChangeStation,
        };
        const branch = resolveStationBranch(stationConfig);

        dispatch({
          type: "PIN_VERIFIED",
          kioskToken: result.kioskToken,
          employeeDisplayName: result.employeeDisplayName,
          employeeFirstName: result.employeeFirstName,
          stationConfig,
          nextStep: branch.kind === "must_pick" ? "station_picker" : "station_resolving",
          autoSelectedStationId: branch.kind === "must_pick" ? null : branch.stationId,
          autoSelectedStationName: branch.kind === "must_pick" ? null : branch.stationName,
        });
      } catch {
        if (!cancelled) dispatch({ type: "PIN_FAILED", message: GENERIC_NETWORK_ERROR });
      } finally {
        if (!cancelled) {
          setPinDigits("");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pinDigits]);

  // ---- Station-resolving brief auto-advance ------------------------------
  useEffect(() => {
    if (state.step !== "station_resolving") return;
    const timer = setTimeout(() => dispatch({ type: "STATION_CONFIRMED" }), 900);
    return () => clearTimeout(timer);
  }, [state.step]);

  // ---- Station list fetch -------------------------------------------------
  useEffect(() => {
    if (state.step !== "station_picker" || state.stations !== null || !state.kioskToken) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await listActiveStations(state.kioskToken!);
        if (cancelled) return;
        if (!result.ok) {
          dispatch({ type: "SESSION_EXPIRED" });
          return;
        }
        dispatch({ type: "STATIONS_LOADED", stations: result.stations });
      } catch {
        if (!cancelled) dispatch({ type: "SCREEN_ERROR", message: GENERIC_NETWORK_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.stations, state.kioskToken, retryTick]);

  // ---- Item catalog fetch ---------------------------------------------------
  useEffect(() => {
    if (state.step !== "item_select" || state.items !== null || !state.kioskToken) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await listActiveInventoryItems(state.kioskToken!);
        if (cancelled) return;
        if (!result.ok) {
          dispatch({ type: "SESSION_EXPIRED" });
          return;
        }
        dispatch({ type: "ITEMS_LOADED", items: result.items });
      } catch {
        if (!cancelled) dispatch({ type: "SCREEN_ERROR", message: GENERIC_NETWORK_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.items, state.kioskToken, retryTick]);

  // ---- Recent items fetch (2A.5 Part C) ------------------------------------
  // Independent of the item-catalog fetch above (different RPC, no shared
  // loading gate) so a slow recent-items lookup never blocks the main
  // grid from rendering. A failure here is non-fatal to the screen -- it
  // simply means no "Recently Used" strip renders, so it degrades
  // silently rather than surfacing a screen-blocking error banner for a
  // convenience feature.
  useEffect(() => {
    if (state.step !== "item_select" || state.recentItemIds !== null || !state.kioskToken) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getEmployeeRecentWithdrawnItemIds(state.kioskToken!);
        if (cancelled) return;
        if (!result.ok) return;
        dispatch({ type: "RECENT_ITEMS_LOADED", itemIds: result.itemIds });
      } catch {
        // Silent -- see comment above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.recentItemIds, state.kioskToken, retryTick]);

  // ---- Search signals fetch (2A.5 Part D) ----------------------------------
  // Same non-blocking treatment as recent items: a failure just means
  // search falls back to canonical-name-only matching (still fully
  // functional), never a screen-blocking error for a search enhancement.
  useEffect(() => {
    if (state.step !== "item_select" || state.searchSignals !== null || !state.kioskToken) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getInventorySearchSignals(state.kioskToken!);
        if (cancelled) return;
        if (!result.ok) return;
        dispatch({ type: "SEARCH_SIGNALS_LOADED", signals: result.signals });
      } catch {
        // Silent -- see comment above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.searchSignals, state.kioskToken, retryTick]);

  // ---- Kiosk usage units fetch -------------------------------------------
  // Under the purchase-versus-usage unit model an employee withdraws in
  // whichever confirmed kiosk usage unit(s) the item has -- one required
  // primary, one optional secondary -- see app/lib/kiosk/withdrawalUnit.ts.
  // The item catalog already excludes items missing a primary (see
  // app/lib/kiosk/inventoryItems.ts), so "unit_not_configured" here means a
  // rare race (master data changed after the catalog was fetched but before
  // this item was selected) -- shown as a small inline notice on this same
  // screen, not a manager-facing configuration error banner.
  useEffect(() => {
    if (
      state.step !== "quantity_entry" ||
      !state.selectedItem ||
      state.usageUnits !== null ||
      state.withdrawalUnitUnavailable ||
      !state.kioskToken
    ) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await getKioskUsageUnits(state.kioskToken!, state.selectedItem!.id);
        if (cancelled) return;
        if (!result.ok) {
          if (result.reason === "item_not_found") {
            dispatch({ type: "BACK_TO_ITEMS", message: "This item is no longer available. Please choose another." });
          } else if (result.reason === "unit_not_configured") {
            dispatch({ type: "WITHDRAWAL_UNIT_UNAVAILABLE" });
          } else {
            dispatch({ type: "SESSION_EXPIRED" });
          }
          return;
        }
        dispatch({ type: "USAGE_UNITS_LOADED", units: result.units });
      } catch {
        if (!cancelled) dispatch({ type: "SCREEN_ERROR", message: GENERIC_NETWORK_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.selectedItem, state.usageUnits, state.withdrawalUnitUnavailable, state.kioskToken, retryTick]);

  // ---- Stock availability fetch (2A.5) -------------------------------------
  // Loaded in parallel with the withdrawal unit, once per selected item --
  // drives the stock card and, when more than one location has stock, the
  // required "Take From" choice. Never client-side pro-rata, never guessed.
  useEffect(() => {
    if (state.step !== "quantity_entry" || !state.selectedItem || state.availableLocations !== null || !state.kioskToken) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await getKioskItemAvailabilityAction(state.kioskToken!, state.selectedItem!.id);
        if (cancelled) return;
        if (!result.ok) {
          dispatch({ type: "SESSION_EXPIRED" });
          return;
        }
        dispatch({ type: "AVAILABILITY_LOADED", locations: result.locations });
      } catch {
        if (!cancelled) dispatch({ type: "SCREEN_ERROR", message: GENERIC_NETWORK_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.selectedItem, state.availableLocations, state.kioskToken, retryTick]);

  // ---- Session refresh scheduler -------------------------------------------
  useEffect(() => {
    if (
      state.step === "pin" ||
      state.step === "success" ||
      !state.kioskToken ||
      state.tokenClientIssuedAt === null ||
      state.sessionStartedAtClient === null
    ) {
      return;
    }

    const interval = setInterval(() => {
      const decision = decideSessionTick({
        now: Date.now() / 1000,
        tokenClientIssuedAt: state.tokenClientIssuedAt! / 1000,
        sessionStartedAtClient: state.sessionStartedAtClient! / 1000,
        lastActivityAt: state.lastActivityAt / 1000,
      });

      if (decision === "expire_ceiling" || decision === "expire_idle") {
        dispatch({ type: "SESSION_EXPIRED" });
        return;
      }
      if (decision === "refresh" && !state.refreshing) {
        dispatch({ type: "REFRESHING_TOKEN", refreshing: true });
        refreshKioskSession(state.kioskToken!)
          .then((result) => {
            if (!result.ok) {
              dispatch({ type: "SESSION_EXPIRED" });
              return;
            }
            dispatch({ type: "TOKEN_REFRESHED", kioskToken: result.kioskToken });
          })
          .catch(() => dispatch({ type: "SESSION_EXPIRED" }));
      }
    }, SESSION_TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [
    state.step,
    state.kioskToken,
    state.tokenClientIssuedAt,
    state.sessionStartedAtClient,
    state.lastActivityAt,
    state.refreshing,
  ]);

  // ---- Derived item-selection data ----------------------------------------
  const categories = useMemo(() => (state.items ? deriveItemCategories(state.items) : []), [state.items]);

  // Category narrows the candidate set first; search ranks within it
  // (2A.5 §21 -- "search + category filters must compose"). An empty
  // query is just the category-filtered browsing list, in catalog order.
  const categoryFilteredItems = useMemo(
    () => (state.items ? filterItemsByCategory(state.items, activeCategoryId) : []),
    [state.items, activeCategoryId]
  );

  const filteredItems = useMemo(() => {
    const trimmedQuery = itemQuery.trim();
    if (trimmedQuery === "") return categoryFilteredItems;

    const candidates: SearchCandidateItem[] = categoryFilteredItems.map((item) => ({
      id: item.id,
      name: item.name,
      categoryName: item.categoryName,
      vendorSkus: state.searchSignals?.[item.id]?.vendorSkus ?? [],
      vendorDescriptions: state.searchSignals?.[item.id]?.vendorDescriptions ?? [],
    }));
    const rankedIds = rankSearchResults(candidates, trimmedQuery).map((c) => c.id);
    const byId = new Map(categoryFilteredItems.map((item) => [item.id, item]));
    return rankedIds.map((id) => byId.get(id)).filter((item) => item !== undefined);
  }, [categoryFilteredItems, itemQuery, state.searchSignals]);

  // Recent is personal, org-wide (not category-scoped), and hidden while
  // actively searching (2A.5 §21) -- derived from the currently-
  // withdrawable item list itself, so a since-depleted recent item is
  // dropped automatically (§12 Recent Stock Rule) rather than needing a
  // second stock check.
  const recentItems = useMemo(() => {
    if (!state.items || !state.recentItemIds || itemQuery.trim() !== "") return [];
    const byId = new Map(state.items.map((item) => [item.id, item]));
    return state.recentItemIds
      .map((id) => byId.get(id))
      .filter((item) => item !== undefined)
      .slice(0, 6);
  }, [state.items, state.recentItemIds, itemQuery]);

  // Cart-aware available quantity (2A.5 "CART-AWARE AVAILABLE QUANTITY"):
  // a UI courtesy only, never a real reservation -- the batch RPC always
  // re-reads authoritative current inventory under locks at submit time
  // regardless of what this shows. Subtracts whatever the cart already
  // holds for this same item+source (excluding the line being edited, if
  // any) from the live balance the server just returned, so the employee
  // sees "7 available" instead of "12" when 5 are already in their cart.
  const effectiveLocations = useMemo(() => {
    if (!state.availableLocations || !state.selectedItem) return state.availableLocations;
    return state.availableLocations.map((location) => ({
      ...location,
      balance: Math.max(
        0,
        location.balance - cartReservedQuantity(state.cart, state.selectedItem!.id, location.locationId, state.editingCartLineId)
      ),
    }));
  }, [state.availableLocations, state.selectedItem, state.cart, state.editingCartLineId]);

  const selectedLocationAvailability = effectiveLocations?.find((l) => l.locationId === state.selectedSourceLocationId) ?? null;
  const outOfStock = state.availableLocations !== null && state.availableLocations.length === 0;
  const needsLocationChoice = (state.availableLocations?.length ?? 0) > 1 && state.selectedSourceLocationId === null;
  const canContinueQuantity =
    isValidWithdrawalQuantity(state.enteredQuantity) &&
    state.selectedSourceLocationId !== null &&
    (selectedLocationAvailability === null || Number(state.enteredQuantity) <= selectedLocationAvailability.balance);

  // ---- Batch submit (2A.5 Part 11) -----------------------------------------
  // The WHOLE cart is submitted as one atomic batch -- never one RPC call
  // per line -- so it can only ever fully succeed or fully roll back.
  const handleSubmit = useCallback(async () => {
    if (!state.kioskToken || !state.selectedStationId || state.cart.length === 0) {
      return;
    }
    const requestId = state.clientRequestId ?? crypto.randomUUID();
    dispatch({ type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: requestId });

    try {
      const result = await recordWithdrawalBatch(state.kioskToken, {
        stationId: state.selectedStationId,
        clientRequestId: requestId,
        cartLines: state.cart.map((line) => ({
          inventoryItemId: line.inventoryItemId,
          sourceLocationId: line.sourceLocationId,
          enteredQuantity: line.enteredQuantity,
          enteredUnitId: line.enteredUnitId,
          measuredBaseQuantity: line.measuredBaseQuantity,
        })),
      });

      if (!result.ok) {
        if (result.reason === "invalid_token") {
          dispatch({ type: "SESSION_EXPIRED" });
          return;
        }
        if (result.reason === "insufficient_inventory") {
          // Resolve item/location NAMES from the cart itself -- the RPC
          // only ever returns identifiers (Part 23: kiosk-safe fields
          // only), and the client already has the display names for
          // everything currently in its own cart.
          const byId = new Map(state.cart.map((line) => [line.id, line]));
          const detail = (result.insufficientLines ?? [])
            .map((l) => {
              const line = byId.get(cartLineKey(l.inventoryItemId, l.sourceLocationId));
              const label = line ? `${line.itemName} (${line.sourceLocationName})` : "One item";
              const unit = line?.unitCode ?? "";
              return `${label}: requested ${formatKioskQuantity(l.requestedQuantity)} ${unit}, only ${formatKioskQuantity(l.availableQuantity)} ${unit} available now.`;
            })
            .join(" ");
          dispatch({ type: "SUBMIT_FAILED", message: detail || result.message });
          return;
        }
        if (result.reason === "invalid_location" || result.reason === "unit_not_authorized") {
          // A chosen location is no longer valid, or an item's kiosk
          // usage unit was reconfigured/deactivated since it was added --
          // force a fresh browsing/unit-load rather than letting the
          // employee retry against a choice that can never succeed.
          dispatch({ type: "BACK_TO_ITEMS", message: result.message });
          return;
        }
        dispatch({ type: "SUBMIT_FAILED", message: GENERIC_SUBMIT_ERROR });
        return;
      }

      dispatch({ type: "BATCH_SUBMIT_SUCCESS", itemCount: state.cart.length });
    } catch {
      dispatch({ type: "SUBMIT_FAILED", message: GENERIC_SUBMIT_ERROR });
    }
  }, [state.kioskToken, state.selectedStationId, state.cart, state.clientRequestId]);

  // ---- Render ---------------------------------------------------------------
  let content: ReactNode;

  if (state.step === "pin") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-10">
        <div className="text-center">
          <h1 className="text-3xl font-semibold text-kiosk-text">Gansevoort Liberty Market</h1>
          <p className="mt-2 text-lg text-kiosk-text-muted">Enter your PIN to begin</p>
        </div>
        <div role="group" aria-label="4-digit employee PIN">
          <PinDisplay length={PIN_LENGTH} filled={pinDigits.length} />
        </div>
        {state.errorBanner ? (
          <p role="alert" className="max-w-xs text-center text-base font-medium text-kiosk-coral-strong">
            {state.errorBanner.message}
          </p>
        ) : null}
        <NumericKeypad onDigit={handleDigit} onDelete={handleDeleteDigit} disabled={pinSubmitting} />
      </div>
    );
  } else if (state.step === "station_resolving") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <p className="text-xl text-kiosk-text-muted">Setting up your station…</p>
        {state.stationConfig?.canChangeStation ? (
          <button
            type="button"
            onClick={() => dispatch({ type: "REQUEST_CHANGE_STATION" })}
            className="mt-2 rounded-full border border-kiosk-border px-6 py-3 text-base font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
          >
            Change station
          </button>
        ) : null}
      </div>
    );
  } else if (state.step === "station_picker") {
    content = (
      <KioskScreen
        header={
          <>
            <KioskHeader title="Select your station" />
            {state.errorBanner && state.stations === null ? (
              <div className="mb-4">
                <ErrorState title={state.errorBanner.message} primaryAction={{ label: "Retry", onClick: handleRetry }} />
              </div>
            ) : null}
          </>
        }
      >
        {state.stations === null ? (
          state.errorBanner ? null : <CardGridSkeleton cardMinHeightClassName="min-h-24" />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {state.stations.map((station) => (
              <StationCard
                key={station.id}
                station={station}
                selected={station.id === state.selectedStationId}
                onSelect={(id) => dispatch({ type: "STATION_SELECTED", stationId: id, stationName: station.name })}
              />
            ))}
          </div>
        )}
      </KioskScreen>
    );
  } else if (state.step === "item_select") {
    content = (
      <KioskScreen
        header={
          <>
            {state.errorBanner ? (
              <div className="mb-3">
                <ErrorState
                  title={state.errorBanner.message}
                  primaryAction={state.items === null ? { label: "Retry", onClick: handleRetry } : { label: "Dismiss", onClick: () => dispatch({ type: "DISMISS_SCREEN_ERROR" }) }}
                />
              </div>
            ) : null}
            <ItemSearch
              query={itemQuery}
              onQueryChange={setItemQuery}
              categories={categories}
              activeCategoryId={activeCategoryId}
              onCategoryChange={setActiveCategoryId}
              recentSlot={
                recentItems.length > 0 ? (
                  <RecentItemsStrip
                    items={recentItems}
                    onSelect={(id) => {
                      const found = state.items!.find((candidate) => candidate.id === id);
                      if (found) dispatch({ type: "ITEM_SELECTED", item: found });
                    }}
                  />
                ) : null
              }
            />
          </>
        }
      >
        {state.items === null ? (
          state.errorBanner ? null : <CardGridSkeleton cardMinHeightClassName="min-h-24" />
        ) : filteredItems.length === 0 ? (
          <p className="text-lg text-kiosk-text-muted">No items match your search.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {filteredItems.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                onSelect={(id) => {
                  const found = state.items!.find((candidate) => candidate.id === id);
                  if (found) dispatch({ type: "ITEM_SELECTED", item: found });
                }}
              />
            ))}
          </div>
        )}
      </KioskScreen>
    );
  } else if (state.step === "quantity_entry") {
    const isEditing = state.editingCartLineId !== null;
    const overAvailable =
      selectedLocationAvailability !== null && isValidWithdrawalQuantity(state.enteredQuantity) && Number(state.enteredQuantity) > selectedLocationAvailability.balance;
    // Two completion paths (never a single ambiguous "Continue"/"Add"):
    // both perform the IDENTICAL cart mutation via handleAddToCart/
    // handleSaveCartLineEdit -- only the nextStep destination differs --
    // and share IDENTICAL enabled/disabled behavior, so neither path can
    // ever bypass quantity/availability validation.
    const continueShoppingLabel = isEditing ? "Save & Continue Shopping" : "Add & Continue Shopping";
    const reviewLabel = isEditing ? "Save & Review Withdrawal →" : "Add & Review Withdrawal →";
    const handleContinueShoppingAction = () => (isEditing ? handleSaveCartLineEdit("item_select") : handleAddToCart("item_select"));
    const handleReviewAction = () => (isEditing ? handleSaveCartLineEdit("review") : handleAddToCart("review"));
    const completionDisabled = !state.usageUnits || !canContinueQuantity;
    const effectiveBalanceByLocationId = new Map((effectiveLocations ?? []).map((l) => [l.locationId, l.balance]));

    content = (
      <KioskScreen
        header={
          <>
            {isEditing ? (
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-kiosk-amber-strong">Editing withdrawal item</p>
            ) : null}
            <ItemContextHeader
              itemName={state.selectedItem?.name ?? ""}
              categoryName={state.selectedItem?.categoryName}
              onBack={() => dispatch({ type: isEditing ? "CANCEL_CART_LINE_EDIT" : "BACK_TO_ITEMS" })}
            />
            {!state.withdrawalUnitUnavailable && state.errorBanner ? (
              <div className="mx-auto mb-3 w-full max-w-[1120px]">
                <ErrorState
                  title={state.errorBanner.message}
                  primaryAction={state.usageUnits === null ? { label: "Retry", onClick: handleRetry } : { label: "Dismiss", onClick: () => dispatch({ type: "DISMISS_SCREEN_ERROR" }) }}
                />
              </div>
            ) : null}
          </>
        }
      >
        {/* One unified withdrawal workspace: source + large quantity on the
            left, keypad on the right, primary actions immediately below --
            never a separate fixed footer floating away from the task.
            max-w-[1120px] (up from the old 960px) gives the now-large
            quantity readout room to breathe without the page reading as
            stretched. */}
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-2.5">
          {state.withdrawalUnitUnavailable ? (
            <SetupRequiredNotice onBack={() => dispatch({ type: "BACK_TO_ITEMS" })} />
          ) : state.usageUnits === null || state.availableLocations === null ? (
            state.errorBanner ? null : <QuantityEntrySkeleton />
          ) : outOfStock ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-lg font-semibold text-kiosk-text">No stock</p>
              <p className="max-w-sm text-base text-kiosk-text-muted">
                No inventory is currently available. Ask a manager if the physical count is incorrect.
              </p>
            </div>
          ) : needsLocationChoice ? (
            // More than one candidate source and none chosen yet -- the
            // withdrawal workspace (quantity + keypad) can't exist without
            // a resolved source, so this replaces it entirely rather than
            // rendering next to an empty keypad column. Once a location is
            // picked here, needsLocationChoice flips false and the SAME
            // location collapses into the compact source card at the top
            // of the workspace below.
            <div className="w-full rounded-2xl border border-kiosk-border bg-kiosk-surface p-4 md:p-5">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-kiosk-text-muted">Take From</p>
              <div className="flex flex-col gap-1.5">
                {state.availableLocations.map((location) => {
                  const effectiveBalance = effectiveBalanceByLocationId.get(location.locationId) ?? location.balance;
                  const locationGauge = computeStockGauge(effectiveBalance, location.fullReferenceQuantity);
                  const locationLight = stockTrafficLight(locationGauge.level);
                  const selected = location.locationId === state.selectedSourceLocationId;
                  return (
                    <button
                      key={location.locationId}
                      type="button"
                      onClick={() => dispatch({ type: "SOURCE_LOCATION_SELECTED", locationId: location.locationId })}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                        selected ? "border-kiosk-amber-strong bg-kiosk-amber/10" : "border-kiosk-border bg-kiosk-surface hover:bg-kiosk-surface-raised"
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                          selected ? "border-kiosk-amber-strong bg-kiosk-amber-strong" : "border-kiosk-border-strong"
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="text-base font-semibold text-kiosk-text">{location.locationName}</span>
                          <span className="text-sm text-kiosk-text-muted">
                            {formatKioskQuantity(effectiveBalance)} {location.baseUnitCode}
                          </span>
                        </span>
                        <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-kiosk-border">
                          <span
                            className={`block h-full ${stockTrafficLightClass(locationLight)}`}
                            style={{ width: `${locationGauge.level === null ? 100 : locationGauge.fillPercent}%` }}
                          />
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            // Source resolved (either the only candidate, auto-selected, or
            // explicitly chosen above) -- the compact source card and the
            // large quantity readout share the left column; the keypad
            // fills the right column; a hairline border divides them on
            // landscape/tablet widths only (removed entirely once the grid
            // collapses to one column on narrow viewports).
            <div className="w-full rounded-2xl border border-kiosk-border bg-kiosk-surface p-4 md:p-5">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-[0.45fr_0.55fr]">
                <div className="flex flex-col gap-3 md:border-r md:border-kiosk-border md:pr-5">
                  <StockAvailabilityCard
                    location={effectiveLocations!.find((l) => l.locationId === state.selectedSourceLocationId) ?? effectiveLocations![0]}
                  />
                  {state.usageUnits.needsSelector ? (
                    <UsageUnitSelector
                      primary={state.usageUnits.primary}
                      secondary={state.usageUnits.secondary!}
                      selectedUnitId={state.selectedUsageUnitId ?? state.usageUnits.primary.unitId}
                      onSelect={(unitId) => dispatch({ type: "USAGE_UNIT_SELECTED", unitId })}
                    />
                  ) : null}
                  {(() => {
                    const chosenUnit =
                      state.usageUnits!.secondary && state.selectedUsageUnitId === state.usageUnits!.secondary.unitId
                        ? state.usageUnits!.secondary
                        : state.usageUnits!.primary;
                    // Weigh-at-kiosk restoration: a measured unit shows the
                    // ITEM's own base unit here, never the selected usage
                    // unit's code -- measured_base_quantity is always
                    // expressed in the base unit regardless of which slot
                    // was chosen, and no conversion factor is ever shown or
                    // requested for a measured unit.
                    return (
                      <WithdrawalQuantityDisplay
                        value={state.enteredQuantity}
                        unit={chosenUnit.requiresActualMeasurement ? state.usageUnits!.baseUnitCode : chosenUnit.unitCode}
                        label={chosenUnit.requiresActualMeasurement ? "Measure at Withdrawal" : "Withdraw Quantity"}
                      />
                    );
                  })()}
                  {overAvailable && selectedLocationAvailability !== null ? (
                    <p role="alert" className="text-sm font-medium text-kiosk-coral-strong">
                      Only {formatKioskQuantity(selectedLocationAvailability.balance)} {selectedLocationAvailability.baseUnitCode} are currently available.
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center justify-center md:pl-5">
                  <QuantityKeypad value={state.enteredQuantity} onChange={(value) => dispatch({ type: "QUANTITY_CHANGED", value })} />
                </div>
              </div>
              {/* column-reverse + sm:row: on a narrow stack the LAST
                  DOM child (the primary Review action) renders on
                  top; at sm+ it flips to a normal row so the
                  secondary action sits on the left ("I need more
                  things") and the primary sits on the right ("I am
                  done selecting things"). */}
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row">
                <button
                  type="button"
                  disabled={completionDisabled}
                  onClick={handleContinueShoppingAction}
                  className="w-full rounded-full border border-kiosk-amber/40 bg-kiosk-surface-raised px-8 py-3 text-base font-medium text-kiosk-text transition hover:bg-kiosk-border disabled:border-kiosk-border disabled:bg-transparent disabled:text-kiosk-text-muted disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber sm:w-auto sm:flex-1"
                >
                  {continueShoppingLabel}
                </button>
                <button
                  type="button"
                  disabled={completionDisabled}
                  onClick={handleReviewAction}
                  className="w-full rounded-full bg-kiosk-amber px-8 py-3 text-base font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong sm:w-auto sm:flex-1"
                >
                  {reviewLabel}
                </button>
              </div>
            </div>
          )}
        </div>
      </KioskScreen>
    );
  } else if (state.step === "review") {
    content = (
      <KioskScreen
        header={
          <>
            <KioskHeader title="Review Withdrawal" onBack={handleContinueShopping} />
            <p className="-mt-2 mb-3 text-sm text-kiosk-text-muted">Review the items below before submitting.</p>
            {state.errorBanner ? (
              <div className="mb-4">
                <ErrorState
                  title="This withdrawal couldn't be completed."
                  message={state.errorBanner.message}
                  primaryAction={{ label: "Try Again", onClick: handleSubmit }}
                  secondaryAction={{ label: "Edit Withdrawal", onClick: () => dispatch({ type: "DISMISS_SCREEN_ERROR" }) }}
                />
              </div>
            ) : null}
          </>
        }
      >
        {/* No footer prop here (unlike quantity_entry) -- Review Withdrawal's
            actions live in the normal scrollable flow, immediately after the
            content, instead of being pinned to the bottom of a flex-1
            region. A pinned footer left a large dead gap between content and
            the buttons whenever the cart was small; a 10+ item cart still
            scrolls normally to reach them, which is the accepted tradeoff
            for a review screen (unlike the keypad, where the primary action
            must always stay visible without scrolling). */}
        <div className="flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-kiosk-text-subtle">
            {state.cart.length} {state.cart.length === 1 ? "ITEM" : "ITEMS"}
          </p>
          <CartReviewGroups cart={state.cart} onEdit={handleEditCartLine} onRemove={handleRemoveCartLine} />
          <div className="rounded-2xl border border-kiosk-border bg-kiosk-surface-raised px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-kiosk-text-muted">Employee</span>
              <span className="text-sm font-medium text-kiosk-text">{state.employeeDisplayName}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-4">
              <span className="text-sm text-kiosk-text-muted">Station</span>
              <span className="text-sm font-medium text-kiosk-text">{state.selectedStationName}</span>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-kiosk-border pt-4">
            <div className="flex flex-col justify-center gap-3 sm:flex-row">
              <button
                type="button"
                onClick={handleContinueShopping}
                className="rounded-full border border-kiosk-border px-8 py-4 text-lg font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
              >
                Continue Shopping
              </button>
              <button
                type="button"
                disabled={state.submitting || state.cart.length === 0}
                onClick={handleSubmit}
                className="rounded-full bg-kiosk-amber px-10 py-4 text-xl font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
              >
                {state.submitting ? "Submitting…" : "Confirm & Submit →"}
              </button>
            </div>
            <button
              type="button"
              onClick={handleClearCart}
              className="text-center text-sm font-medium text-kiosk-text-subtle underline-offset-2 transition hover:text-kiosk-coral-strong hover:underline"
            >
              Clear Withdrawal
            </button>
          </div>
        </div>
      </KioskScreen>
    );
  } else {
    content = (
      <SuccessState
        itemCount={state.successSummary?.itemCount ?? 0}
        stationName={state.successSummary?.stationName ?? ""}
        onWithdrawMore={handleWithdrawMore}
        onFinish={handleStartOver}
      />
    );
  }

  const showEmployeeStatusBar = state.step !== "pin" && state.step !== "success" && state.employeeFirstName !== null;

  return (
    <KioskShell onActivity={handleActivity}>
      {showEmployeeStatusBar ? (
        <EmployeeStatusBar
          employeeFirstName={state.employeeFirstName!}
          stationName={state.selectedStationName}
          onStartOver={handleRequestStartOver}
          canChangeStation={state.stationConfig?.canChangeStation ?? false}
          onChangeStation={handleRequestChangeStation}
          screenLabel={state.step === "item_select" ? "Inventory" : undefined}
          cartCount={state.cart.length}
          onOpenReview={handleOpenReview}
        />
      ) : null}
      {content}
      {addedToast ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div className="rounded-full border border-kiosk-border bg-kiosk-surface px-5 py-2.5 text-sm font-medium text-kiosk-text shadow-lg">
            {addedToast.message}
          </div>
        </div>
      ) : null}
      {showChangeStationConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-kiosk-border bg-kiosk-surface p-5 text-center">
            <p className="text-base font-semibold text-kiosk-text">Changing station will clear your current withdrawal.</p>
            {state.cart.length > 0 ? (
              <p className="mt-1 text-sm text-kiosk-text-muted">
                You currently have {state.cart.length} {state.cart.length === 1 ? "item" : "items"} selected.
              </p>
            ) : null}
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={handleConfirmChangeStation}
                className="rounded-full bg-kiosk-amber px-6 py-3 text-base font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
              >
                {state.cart.length > 0 ? "Clear & Change Station" : "Change Station"}
              </button>
              <button
                type="button"
                onClick={() => setShowChangeStationConfirm(false)}
                className="rounded-full border border-kiosk-border px-6 py-3 text-base font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showStartOverConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-kiosk-border bg-kiosk-surface p-5 text-center">
            <p className="text-base font-semibold text-kiosk-text">
              You have {state.cart.length} {state.cart.length === 1 ? "item" : "items"} in your withdrawal.
            </p>
            <p className="mt-1 text-sm text-kiosk-text-muted">Starting over will discard them.</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowStartOverConfirm(false)}
                className="rounded-full bg-kiosk-amber px-6 py-3 text-base font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
              >
                Keep Working
              </button>
              <button
                type="button"
                onClick={handleConfirmStartOver}
                className="rounded-full border border-kiosk-border px-6 py-3 text-base font-medium text-kiosk-coral-strong transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
              >
                Discard &amp; Start Over
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </KioskShell>
  );
}
