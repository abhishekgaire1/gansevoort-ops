"use client";

import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { verifyPin } from "@/app/actions/pin";
import { listActiveStations } from "@/app/actions/stations";
import { listActiveInventoryItems } from "@/app/actions/inventoryItems";
import { listActiveItemUnits } from "@/app/actions/inventoryItemUnits";
import { refreshKioskSession } from "@/app/actions/kioskSession";
import { recordWithdrawal } from "@/app/actions/withdrawal";
import { createInitialKioskState, kioskReducer } from "@/app/kiosk/_lib/kioskReducer";
import { resolveStationBranch } from "@/app/kiosk/_lib/stationBranch";
import { decideSessionTick } from "@/app/kiosk/_lib/sessionRefresh";
import { isQuantityEntryComplete, resolveQuantityEntryLayout } from "@/app/kiosk/_lib/quantityEntry";
import { KioskShell } from "./KioskShell";
import { KioskHeader } from "./KioskHeader";
import { NumericKeypad } from "./NumericKeypad";
import { PinDisplay } from "./PinDisplay";
import { StationCard } from "./StationCard";
import { ItemSearch } from "./ItemSearch";
import { ItemCard } from "./ItemCard";
import { QuantityEntryForm } from "./QuantityEntryForm";
import { ReviewCard } from "./ReviewCard";
import { SuccessState } from "./SuccessState";
import { ErrorState } from "./ErrorState";

const PIN_LENGTH = 6;
const SESSION_TICK_INTERVAL_MS = 5000;
const GENERIC_NETWORK_ERROR = "Something went wrong. Please try again.";
const GENERIC_SUBMIT_ERROR = "This withdrawal couldn't be completed. You can try again or go back to make changes.";

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
  const handleStartOver = useCallback(() => dispatch({ type: "START_OVER" }), []);

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

  // ---- Item units fetch ---------------------------------------------------
  useEffect(() => {
    if (state.step !== "quantity_entry" || !state.selectedItem || state.itemUnits !== null || !state.kioskToken) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await listActiveItemUnits(state.kioskToken!, state.selectedItem!.id);
        if (cancelled) return;
        if (!result.ok) {
          if (result.reason === "item_not_found") {
            dispatch({ type: "BACK_TO_ITEMS", message: "This item is no longer available. Please choose another." });
          } else {
            dispatch({ type: "SESSION_EXPIRED" });
          }
          return;
        }
        const defaultUnit = result.units.find((unit) => unit.isDefaultEntryUnit) ?? result.units[0] ?? null;
        dispatch({
          type: "ITEM_UNITS_LOADED",
          units: result.units,
          defaultUnitId: defaultUnit?.unitId ?? null,
          baseUnitName: result.baseUnitName,
        });
      } catch {
        if (!cancelled) dispatch({ type: "SCREEN_ERROR", message: GENERIC_NETWORK_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.selectedItem, state.itemUnits, state.kioskToken, retryTick]);

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
  const categories = useMemo(() => {
    if (!state.items) return [];
    const map = new Map<string, string>();
    for (const item of state.items) {
      map.set(item.categoryId, item.categoryName);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [state.items]);

  const filteredItems = useMemo(() => {
    if (!state.items) return [];
    const query = itemQuery.trim().toLowerCase();
    return state.items.filter((item) => {
      const matchesQuery = query === "" || item.name.toLowerCase().includes(query);
      const matchesCategory = activeCategoryId === null || item.categoryId === activeCategoryId;
      return matchesQuery && matchesCategory;
    });
  }, [state.items, itemQuery, activeCategoryId]);

  const selectedUnit = state.itemUnits?.find((unit) => unit.unitId === state.selectedUnitId) ?? null;
  const quantityLayout = selectedUnit ? resolveQuantityEntryLayout(selectedUnit) : null;
  const canContinueQuantity = quantityLayout
    ? isQuantityEntryComplete(quantityLayout, state.enteredQuantity, state.measuredBaseQuantity)
    : false;

  // ---- Submit -------------------------------------------------------------
  const handleSubmit = useCallback(async () => {
    if (!state.kioskToken || !state.selectedItem || !state.selectedUnitId || !state.selectedStationId || !selectedUnit) {
      return;
    }
    const requestId = state.clientRequestId ?? crypto.randomUUID();
    dispatch({ type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: requestId });

    const layout = resolveQuantityEntryLayout(selectedUnit);

    try {
      const result = await recordWithdrawal(state.kioskToken, {
        stationId: state.selectedStationId,
        inventoryItemId: state.selectedItem.id,
        enteredQuantity: state.enteredQuantity,
        enteredUnitId: state.selectedUnitId,
        measuredBaseQuantity: layout.kind === "actual_measurement" ? state.measuredBaseQuantity : null,
        clientRequestId: requestId,
      });

      if (!result.ok) {
        if (result.reason === "invalid_token") {
          dispatch({ type: "SESSION_EXPIRED" });
          return;
        }
        dispatch({ type: "SUBMIT_FAILED", message: GENERIC_SUBMIT_ERROR });
        return;
      }

      dispatch({ type: "SUBMIT_SUCCESS" });
    } catch {
      dispatch({ type: "SUBMIT_FAILED", message: GENERIC_SUBMIT_ERROR });
    }
  }, [
    state.kioskToken,
    state.selectedItem,
    state.selectedUnitId,
    state.selectedStationId,
    state.clientRequestId,
    state.enteredQuantity,
    state.measuredBaseQuantity,
    selectedUnit,
  ]);

  // ---- Render ---------------------------------------------------------------
  let content: ReactNode;

  if (state.step === "pin") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-10">
        <div className="text-center">
          <h1 className="text-3xl font-semibold text-zinc-50">Gansevoort Liberty Market</h1>
          <p className="mt-2 text-lg text-zinc-400">Enter your PIN to begin</p>
        </div>
        <PinDisplay length={PIN_LENGTH} filled={pinDigits.length} />
        {state.errorBanner ? (
          <p role="alert" className="max-w-xs text-center text-base font-medium text-amber-300">
            {state.errorBanner.message}
          </p>
        ) : null}
        <NumericKeypad onDigit={handleDigit} onDelete={handleDeleteDigit} disabled={pinSubmitting} />
      </div>
    );
  } else if (state.step === "station_resolving") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <p className="text-2xl text-zinc-300">Welcome, {state.employeeDisplayName}</p>
        <p className="text-xl text-zinc-400">Station: {state.selectedStationName ?? "—"}</p>
        {state.stationConfig?.canChangeStation ? (
          <button
            type="button"
            onClick={() => dispatch({ type: "REQUEST_CHANGE_STATION" })}
            className="mt-2 rounded-full border border-zinc-700 px-6 py-3 text-base font-medium text-zinc-300 transition hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            Change station
          </button>
        ) : null}
      </div>
    );
  } else if (state.step === "station_picker") {
    content = (
      <>
        <KioskHeader title="Select your station" onStartOver={handleStartOver} />
        {state.errorBanner && state.stations === null ? (
          <ErrorState title={state.errorBanner.message} primaryAction={{ label: "Retry", onClick: handleRetry }} />
        ) : state.stations === null ? (
          <p className="text-lg text-zinc-400">Loading stations…</p>
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
      </>
    );
  } else if (state.step === "item_select") {
    content = (
      <>
        <KioskHeader title="Select an item" onStartOver={handleStartOver} />
        {state.errorBanner ? (
          <div className="mb-4">
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
        />
        {state.items === null ? (
          <p className="text-lg text-zinc-400">Loading items…</p>
        ) : filteredItems.length === 0 ? (
          <p className="text-lg text-zinc-400">No items match your search.</p>
        ) : (
          <div className="grid flex-1 grid-cols-2 gap-4 overflow-y-auto sm:grid-cols-3">
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
      </>
    );
  } else if (state.step === "quantity_entry") {
    content = (
      <>
        <KioskHeader
          title={state.selectedItem?.name ?? ""}
          onBack={() => dispatch({ type: "BACK_TO_ITEMS" })}
          onStartOver={handleStartOver}
        />
        {state.errorBanner ? (
          <div className="mb-4">
            <ErrorState
              title={state.errorBanner.message}
              primaryAction={state.itemUnits === null ? { label: "Retry", onClick: handleRetry } : { label: "Dismiss", onClick: () => dispatch({ type: "DISMISS_SCREEN_ERROR" }) }}
            />
          </div>
        ) : null}
        {state.itemUnits === null ? (
          <p className="text-lg text-zinc-400">Loading options…</p>
        ) : (
          <>
            <QuantityEntryForm
              units={state.itemUnits}
              baseUnitName={state.baseUnitName ?? ""}
              selectedUnitId={state.selectedUnitId}
              onUnitChange={(unitId) => dispatch({ type: "UNIT_CHANGED", unitId })}
              enteredQuantity={state.enteredQuantity}
              onQuantityChange={(value) => dispatch({ type: "QUANTITY_CHANGED", value })}
              measuredBaseQuantity={state.measuredBaseQuantity}
              onMeasuredQuantityChange={(value) => dispatch({ type: "MEASURED_QUANTITY_CHANGED", value })}
            />
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                disabled={!canContinueQuantity}
                onClick={() => dispatch({ type: "GO_TO_REVIEW" })}
                className="rounded-full bg-amber-400 px-10 py-4 text-xl font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-100"
              >
                Continue →
              </button>
            </div>
          </>
        )}
      </>
    );
  } else if (state.step === "review") {
    const rows = [
      { label: "Employee", value: state.employeeDisplayName ?? "" },
      { label: "Station", value: state.selectedStationName ?? "" },
      { label: "Item", value: state.selectedItem?.name ?? "" },
      { label: "Quantity", value: `${state.enteredQuantity} ${selectedUnit?.unitName ?? ""}`.trim() },
    ];
    if (quantityLayout?.kind === "actual_measurement" && state.measuredBaseQuantity) {
      rows.push({ label: "Actual weight", value: `${state.measuredBaseQuantity} ${state.baseUnitName ?? ""}`.trim() });
    }

    content = (
      <>
        <KioskHeader title="Review Withdrawal" onBack={() => dispatch({ type: "BACK_TO_QUANTITY" })} onStartOver={handleStartOver} />
        {state.errorBanner ? (
          <div className="mb-4">
            <ErrorState
              title="This withdrawal couldn't be completed."
              message={state.errorBanner.message}
              primaryAction={{ label: "Try Again", onClick: handleSubmit }}
              secondaryAction={{ label: "Back", onClick: () => dispatch({ type: "BACK_TO_QUANTITY" }) }}
            />
          </div>
        ) : null}
        <ReviewCard rows={rows} />
        <div className="mt-8 flex justify-center gap-4">
          <button
            type="button"
            onClick={() => dispatch({ type: "BACK_TO_QUANTITY" })}
            className="rounded-full border border-zinc-700 px-8 py-4 text-lg font-medium text-zinc-300 transition hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={state.submitting}
            onClick={handleSubmit}
            className="rounded-full bg-amber-400 px-10 py-4 text-xl font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-100"
          >
            {state.submitting ? "Submitting…" : "Confirm & Submit"}
          </button>
        </div>
      </>
    );
  } else {
    content = <SuccessState onDone={handleStartOver} />;
  }

  return <KioskShell onActivity={handleActivity}>{content}</KioskShell>;
}
