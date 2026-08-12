"use client";

import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { verifyPin } from "@/app/actions/pin";
import { listActiveStations } from "@/app/actions/stations";
import { listActiveInventoryItems } from "@/app/actions/inventoryItems";
import { getWithdrawalUnit } from "@/app/actions/withdrawalUnit";
import { refreshKioskSession } from "@/app/actions/kioskSession";
import { recordWithdrawal } from "@/app/actions/withdrawal";
import { createInitialKioskState, kioskReducer } from "@/app/kiosk/_lib/kioskReducer";
import { resolveStationBranch } from "@/app/kiosk/_lib/stationBranch";
import { decideSessionTick } from "@/app/kiosk/_lib/sessionRefresh";
import { isValidWithdrawalQuantity } from "@/app/kiosk/_lib/quantityEntry";
import { deriveItemCategories, filterItems } from "@/app/kiosk/_lib/itemFilter";
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
import { ValueCard } from "./ValueCard";
import { QuantityEntrySkeleton } from "./QuantityEntrySkeleton";
import { SetupRequiredNotice } from "./SetupRequiredNotice";
import { CardGridSkeleton } from "./CardGridSkeleton";
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

  // ---- Withdrawal unit fetch --------------------------------------------
  // Under the withdrawal-unit simplification an employee always withdraws
  // in the item's own base unit -- see app/lib/kiosk/withdrawalUnit.ts. The
  // item catalog already excludes items missing that mapping (see
  // app/lib/kiosk/inventoryItems.ts), so "unit_not_configured" here means a
  // rare race (master data changed after the catalog was fetched but before
  // this item was selected) -- shown as a small inline notice on this same
  // screen, not a manager-facing configuration error banner.
  useEffect(() => {
    if (
      state.step !== "quantity_entry" ||
      !state.selectedItem ||
      state.withdrawalUnit !== null ||
      state.withdrawalUnitUnavailable ||
      !state.kioskToken
    ) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await getWithdrawalUnit(state.kioskToken!, state.selectedItem!.id);
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
        dispatch({ type: "WITHDRAWAL_UNIT_LOADED", unit: result.unit });
      } catch {
        if (!cancelled) dispatch({ type: "SCREEN_ERROR", message: GENERIC_NETWORK_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.selectedItem, state.withdrawalUnit, state.withdrawalUnitUnavailable, state.kioskToken, retryTick]);

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

  const filteredItems = useMemo(
    () => (state.items ? filterItems(state.items, itemQuery, activeCategoryId) : []),
    [state.items, itemQuery, activeCategoryId]
  );

  const canContinueQuantity = isValidWithdrawalQuantity(state.enteredQuantity);

  // ---- Submit -------------------------------------------------------------
  const handleSubmit = useCallback(async () => {
    if (!state.kioskToken || !state.selectedItem || !state.withdrawalUnit || !state.selectedStationId) {
      return;
    }
    const requestId = state.clientRequestId ?? crypto.randomUUID();
    dispatch({ type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: requestId });

    try {
      const result = await recordWithdrawal(state.kioskToken, {
        stationId: state.selectedStationId,
        inventoryItemId: state.selectedItem.id,
        enteredQuantity: state.enteredQuantity,
        enteredUnitId: state.withdrawalUnit.baseUnitId,
        measuredBaseQuantity: null,
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
    state.withdrawalUnit,
    state.selectedStationId,
    state.clientRequestId,
    state.enteredQuantity,
  ]);

  // ---- Render ---------------------------------------------------------------
  let content: ReactNode;

  if (state.step === "pin") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-10">
        <div className="text-center">
          <h1 className="text-3xl font-semibold text-kiosk-text">Gansevoort Liberty Market</h1>
          <p className="mt-2 text-lg text-kiosk-text-muted">Enter your PIN to begin</p>
        </div>
        <PinDisplay length={PIN_LENGTH} filled={pinDigits.length} />
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
    content = (
      <KioskScreen
        centerBody
        header={
          <>
            <ItemContextHeader
              itemName={state.selectedItem?.name ?? ""}
              trackingBasis={state.withdrawalUnit?.baseUnitType ?? ""}
              baseUnitName={state.withdrawalUnit?.baseUnitName ?? ""}
              onBack={() => dispatch({ type: "BACK_TO_ITEMS" })}
            />
            {!state.withdrawalUnitUnavailable ? (
              <div className="mb-4 min-h-32">
                {state.errorBanner ? (
                  <ErrorState
                    title={state.errorBanner.message}
                    primaryAction={state.withdrawalUnit === null ? { label: "Retry", onClick: handleRetry } : { label: "Dismiss", onClick: () => dispatch({ type: "DISMISS_SCREEN_ERROR" }) }}
                  />
                ) : null}
              </div>
            ) : null}
          </>
        }
        footer={
          <div className="flex justify-center">
            <button
              type="button"
              disabled={!state.withdrawalUnit || !canContinueQuantity}
              onClick={() => dispatch({ type: "GO_TO_REVIEW" })}
              className="w-full max-w-xs rounded-full bg-kiosk-amber px-10 py-4 text-xl font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
            >
              Continue →
            </button>
          </div>
        }
      >
        {state.withdrawalUnitUnavailable ? (
          <SetupRequiredNotice onBack={() => dispatch({ type: "BACK_TO_ITEMS" })} />
        ) : state.withdrawalUnit === null ? (
          state.errorBanner ? null : <QuantityEntrySkeleton />
        ) : (
          <div className="flex w-full max-w-xs flex-col items-center gap-6">
            <ValueCard label="Withdraw Quantity" value={state.enteredQuantity} unit={state.withdrawalUnit.baseUnitCode} />
            <QuantityKeypad
              value={state.enteredQuantity}
              onChange={(value) => dispatch({ type: "QUANTITY_CHANGED", value })}
            />
          </div>
        )}
      </KioskScreen>
    );
  } else if (state.step === "review") {
    const rows = [
      { label: "Employee", value: state.employeeDisplayName ?? "" },
      { label: "Station", value: state.selectedStationName ?? "" },
      { label: "Item", value: state.selectedItem?.name ?? "" },
      { label: "Quantity", value: `${state.enteredQuantity} ${state.withdrawalUnit?.baseUnitCode ?? ""}`.trim() },
    ];

    content = (
      <KioskScreen
        header={
          <>
            <KioskHeader title="Review Withdrawal" onBack={() => dispatch({ type: "BACK_TO_QUANTITY" })} />
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
          </>
        }
        footer={
          <div className="flex justify-center gap-4">
            <button
              type="button"
              onClick={() => dispatch({ type: "BACK_TO_QUANTITY" })}
              className="rounded-full border border-kiosk-border px-8 py-4 text-lg font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={state.submitting}
              onClick={handleSubmit}
              className="rounded-full bg-kiosk-amber px-10 py-4 text-xl font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
            >
              {state.submitting ? "Submitting…" : "Confirm & Submit"}
            </button>
          </div>
        }
      >
        <ReviewCard rows={rows} />
      </KioskScreen>
    );
  } else {
    content = <SuccessState onDone={handleStartOver} />;
  }

  const showEmployeeStatusBar = state.step !== "pin" && state.step !== "success" && state.employeeFirstName !== null;

  return (
    <KioskShell onActivity={handleActivity}>
      {showEmployeeStatusBar ? (
        <EmployeeStatusBar
          employeeFirstName={state.employeeFirstName!}
          stationName={state.selectedStationName}
          onStartOver={handleStartOver}
          screenLabel={state.step === "item_select" ? "Inventory" : undefined}
        />
      ) : null}
      {content}
    </KioskShell>
  );
}
