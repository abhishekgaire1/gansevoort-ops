import type { KioskStation } from "@/app/actions/stations";
import type { KioskInventoryItem } from "@/app/actions/inventoryItems";
import type { WithdrawalUnit } from "@/app/actions/withdrawalUnit";
import type { StationConfig } from "./stationBranch";

/**
 * The entire kiosk flow is one client-side state machine, never a Next.js
 * route transition between steps -- see the approved plan §12. This is
 * what lets kioskToken live purely in memory: a browser refresh remounts
 * app/kiosk/page.tsx, this reducer reinitializes from scratch, and there is
 * no cookie/localStorage/URL param anywhere that could resurrect the
 * previous employee's session.
 */
export type KioskStep =
  | "pin"
  | "station_resolving"
  | "station_picker"
  | "item_select"
  | "quantity_entry"
  | "review"
  | "success";

export interface KioskState {
  step: KioskStep;
  kioskToken: string | null;
  tokenClientIssuedAt: number | null;
  sessionStartedAtClient: number | null;
  lastActivityAt: number;
  refreshing: boolean;
  employeeDisplayName: string | null;
  employeeFirstName: string | null;
  stationConfig: StationConfig | null;
  selectedStationId: string | null;
  selectedStationName: string | null;
  stations: KioskStation[] | null;
  items: KioskInventoryItem[] | null;
  selectedItem: KioskInventoryItem | null;
  /** The item's single canonical withdrawal unit (its own base unit) --
   * see app/lib/kiosk/withdrawalUnit.ts. There is no separate entry-unit
   * selection under the withdrawal-unit simplification. */
  withdrawalUnit: WithdrawalUnit | null;
  /** Set when a selected item turns out not to have its base-unit identity
   * mapping configured -- a master-data problem, not something the
   * employee caused. The item catalog already excludes items in this state
   * (see app/lib/kiosk/inventoryItems.ts), so reaching this is a rare
   * residual/race case; it renders a small inline "Setup required" notice
   * on the quantity screen itself rather than a large error banner. */
  withdrawalUnitUnavailable: boolean;
  enteredQuantity: string;
  /** Generated once at the first submit tap, reused verbatim on retry (see
   * app/actions/withdrawal.ts's idempotency contract), cleared whenever the
   * employee edits inputs or the flow ends. */
  clientRequestId: string | null;
  submitting: boolean;
  errorBanner: { message: string } | null;
}

export function createInitialKioskState(): KioskState {
  const now = Date.now();
  return {
    step: "pin",
    kioskToken: null,
    tokenClientIssuedAt: null,
    sessionStartedAtClient: null,
    lastActivityAt: now,
    refreshing: false,
    employeeDisplayName: null,
    employeeFirstName: null,
    stationConfig: null,
    selectedStationId: null,
    selectedStationName: null,
    stations: null,
    items: null,
    selectedItem: null,
    withdrawalUnit: null,
    withdrawalUnitUnavailable: false,
    enteredQuantity: "",
    clientRequestId: null,
    submitting: false,
    errorBanner: null,
  };
}

export type KioskAction =
  | { type: "PIN_FAILED"; message: string }
  | { type: "RATE_LIMITED" }
  | {
      type: "PIN_VERIFIED";
      kioskToken: string;
      employeeDisplayName: string;
      employeeFirstName: string;
      stationConfig: StationConfig;
      nextStep: Extract<KioskStep, "station_resolving" | "station_picker">;
      autoSelectedStationId: string | null;
      autoSelectedStationName: string | null;
    }
  | { type: "STATION_CONFIRMED" }
  | { type: "REQUEST_CHANGE_STATION" }
  | { type: "STATIONS_LOAD_STARTED" }
  | { type: "STATIONS_LOADED"; stations: KioskStation[] }
  | { type: "STATION_SELECTED"; stationId: string; stationName: string }
  | { type: "ITEMS_LOAD_STARTED" }
  | { type: "ITEMS_LOADED"; items: KioskInventoryItem[] }
  | { type: "ITEM_SELECTED"; item: KioskInventoryItem }
  | { type: "WITHDRAWAL_UNIT_LOADED"; unit: WithdrawalUnit }
  | { type: "WITHDRAWAL_UNIT_UNAVAILABLE" }
  | { type: "QUANTITY_CHANGED"; value: string }
  | { type: "GO_TO_REVIEW" }
  | { type: "BACK_TO_QUANTITY" }
  | { type: "BACK_TO_ITEMS"; message?: string }
  | { type: "SUBMIT_ATTEMPT_STARTED"; clientRequestId: string }
  | { type: "SUBMIT_FAILED"; message: string }
  | { type: "SUBMIT_SUCCESS" }
  | { type: "ACTIVITY_PING" }
  | { type: "TOKEN_REFRESHED"; kioskToken: string }
  | { type: "REFRESHING_TOKEN"; refreshing: boolean }
  | { type: "SESSION_EXPIRED" }
  | { type: "START_OVER" }
  | { type: "DISMISS_SCREEN_ERROR" }
  | { type: "SCREEN_ERROR"; message: string };

export function kioskReducer(state: KioskState, action: KioskAction): KioskState {
  switch (action.type) {
    case "PIN_FAILED":
      return { ...createInitialKioskState(), errorBanner: { message: action.message } };

    case "RATE_LIMITED":
      return {
        ...createInitialKioskState(),
        errorBanner: { message: "Too many attempts. Please wait a moment and try again." },
      };

    case "PIN_VERIFIED": {
      const now = Date.now();
      return {
        ...createInitialKioskState(),
        step: action.nextStep,
        kioskToken: action.kioskToken,
        tokenClientIssuedAt: now,
        sessionStartedAtClient: now,
        lastActivityAt: now,
        employeeDisplayName: action.employeeDisplayName,
        employeeFirstName: action.employeeFirstName,
        stationConfig: action.stationConfig,
        selectedStationId: action.autoSelectedStationId,
        selectedStationName: action.autoSelectedStationName,
      };
    }

    case "STATION_CONFIRMED":
      return { ...state, step: "item_select" };

    case "REQUEST_CHANGE_STATION":
      return { ...state, step: "station_picker" };

    case "STATIONS_LOAD_STARTED":
      return { ...state, step: "station_picker" };

    case "STATIONS_LOADED":
      return { ...state, stations: action.stations };

    case "STATION_SELECTED":
      return { ...state, selectedStationId: action.stationId, selectedStationName: action.stationName, step: "item_select" };

    case "ITEMS_LOAD_STARTED":
      return { ...state, step: "item_select" };

    case "ITEMS_LOADED":
      return { ...state, items: action.items };

    case "ITEM_SELECTED":
      return {
        ...state,
        selectedItem: action.item,
        withdrawalUnit: null,
        withdrawalUnitUnavailable: false,
        enteredQuantity: "",
        step: "quantity_entry",
      };

    case "WITHDRAWAL_UNIT_LOADED":
      return { ...state, withdrawalUnit: action.unit, withdrawalUnitUnavailable: false, enteredQuantity: "" };

    case "WITHDRAWAL_UNIT_UNAVAILABLE":
      return { ...state, withdrawalUnitUnavailable: true };

    case "QUANTITY_CHANGED":
      return { ...state, enteredQuantity: action.value };

    case "GO_TO_REVIEW":
      return { ...state, step: "review", errorBanner: null };

    case "BACK_TO_QUANTITY":
      // Editing inputs makes any prior submit attempt a new one.
      return { ...state, step: "quantity_entry", clientRequestId: null, errorBanner: null };

    case "BACK_TO_ITEMS":
      return {
        ...state,
        step: "item_select",
        selectedItem: null,
        withdrawalUnit: null,
        withdrawalUnitUnavailable: false,
        enteredQuantity: "",
        clientRequestId: null,
        errorBanner: action.message ? { message: action.message } : null,
      };

    case "SUBMIT_ATTEMPT_STARTED":
      // Only adopts the freshly generated id if one isn't already in
      // flight -- a retry of the same attempt reuses whatever is already
      // here, which is exactly what makes recordWithdrawal safe to retry.
      return { ...state, clientRequestId: state.clientRequestId ?? action.clientRequestId, submitting: true, errorBanner: null };

    case "SUBMIT_FAILED":
      // Stays on "review" with every entered field intact -- clientRequestId
      // is deliberately NOT cleared here, so a retry reuses it.
      return { ...state, submitting: false, errorBanner: { message: action.message } };

    case "SUBMIT_SUCCESS":
      // Full reset, not just a step change: employee/station identity must
      // disappear completely on a successful withdrawal, the same as
      // START_OVER/SESSION_EXPIRED -- SuccessState renders nothing
      // employee/item-specific, so there is nothing this loses.
      return { ...createInitialKioskState(), step: "success" };

    case "ACTIVITY_PING":
      return { ...state, lastActivityAt: Date.now() };

    case "TOKEN_REFRESHED":
      return { ...state, kioskToken: action.kioskToken, tokenClientIssuedAt: Date.now(), refreshing: false };

    case "REFRESHING_TOKEN":
      return { ...state, refreshing: action.refreshing };

    case "SESSION_EXPIRED":
      // Full reset, including employee identity and every entered field --
      // the previous employee's session must not linger in any form.
      return {
        ...createInitialKioskState(),
        errorBanner: { message: "Session expired — please enter your PIN again." },
      };

    case "START_OVER":
      return createInitialKioskState();

    case "DISMISS_SCREEN_ERROR":
      return { ...state, errorBanner: null };

    case "SCREEN_ERROR":
      return { ...state, errorBanner: { message: action.message } };

    default:
      return state;
  }
}
