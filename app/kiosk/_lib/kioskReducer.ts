import type { KioskStation } from "@/app/actions/stations";
import type { KioskInventoryItem } from "@/app/actions/inventoryItems";
import type { KioskItemUnitOption } from "@/app/actions/inventoryItemUnits";
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
  stationConfig: StationConfig | null;
  selectedStationId: string | null;
  selectedStationName: string | null;
  stations: KioskStation[] | null;
  items: KioskInventoryItem[] | null;
  selectedItem: KioskInventoryItem | null;
  itemUnits: KioskItemUnitOption[] | null;
  baseUnitName: string | null;
  selectedUnitId: string | null;
  enteredQuantity: string;
  measuredBaseQuantity: string | null;
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
    stationConfig: null,
    selectedStationId: null,
    selectedStationName: null,
    stations: null,
    items: null,
    selectedItem: null,
    itemUnits: null,
    baseUnitName: null,
    selectedUnitId: null,
    enteredQuantity: "",
    measuredBaseQuantity: null,
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
  | { type: "ITEM_UNITS_LOADED"; units: KioskItemUnitOption[]; defaultUnitId: string | null; baseUnitName: string }
  | { type: "UNIT_CHANGED"; unitId: string }
  | { type: "QUANTITY_CHANGED"; value: string }
  | { type: "MEASURED_QUANTITY_CHANGED"; value: string }
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
        itemUnits: null,
        baseUnitName: null,
        selectedUnitId: null,
        enteredQuantity: "",
        measuredBaseQuantity: null,
        step: "quantity_entry",
      };

    case "ITEM_UNITS_LOADED":
      return {
        ...state,
        itemUnits: action.units,
        baseUnitName: action.baseUnitName,
        selectedUnitId: action.defaultUnitId,
        enteredQuantity: "",
        measuredBaseQuantity: null,
      };

    case "UNIT_CHANGED":
      // A stale quantity carried across a unit switch would silently mean a
      // different amount than what's displayed -- always reset.
      return { ...state, selectedUnitId: action.unitId, enteredQuantity: "", measuredBaseQuantity: null };

    case "QUANTITY_CHANGED":
      return { ...state, enteredQuantity: action.value };

    case "MEASURED_QUANTITY_CHANGED":
      return { ...state, measuredBaseQuantity: action.value };

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
        itemUnits: null,
        baseUnitName: null,
        selectedUnitId: null,
        enteredQuantity: "",
        measuredBaseQuantity: null,
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
      return { ...state, step: "success", submitting: false, clientRequestId: null, errorBanner: null };

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
