import type { KioskStation } from "@/app/actions/stations";
import type { KioskInventoryItem } from "@/app/actions/inventoryItems";
import type { KioskUsageUnits } from "@/app/actions/withdrawalUnit";
import type { KioskLocationAvailability } from "@/app/actions/inventoryAvailability";
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

/**
 * ONE cart line = one (inventory item, source storage location) pair
 * (2A.5 multi-item cart). Same item from the SAME source combines into
 * this one line (quantities add); the same item from a DIFFERENT source
 * is a separate line, since they represent different physical inventory.
 * `id` is the stable identity used for combining, editing, and removal --
 * always exactly `${inventoryItemId}::${sourceLocationId}`, never a
 * random id, so "does this line already exist" is a plain lookup rather
 * than a scan-and-compare. Deliberately carries no price/cost (CLAUDE.md).
 * Provisional UI state only -- nothing here is written to inventory until
 * the whole cart is submitted via record_inventory_withdrawal_batch.
 */
export interface CartLine {
  id: string;
  inventoryItemId: string;
  itemName: string;
  categoryName: string;
  sourceLocationId: string;
  sourceLocationName: string;
  enteredQuantity: string;
  enteredUnitId: string;
  /** Code of whichever kiosk usage unit (primary or secondary) was
   * selected when this line was added/last saved -- NOT necessarily the
   * item's base unit under the purchase-versus-usage unit model. */
  unitCode: string;
  /** Non-null only when the selected usage unit is "measure at
   * withdrawal" (weigh-at-kiosk restoration) -- the same value the
   * employee typed into enteredQuantity, carried through as the
   * authoritative measured base quantity the server must use directly,
   * never an invented conversion. Null for a fixed-conversion unit. */
  measuredBaseQuantity: string | null;
  /** The item's own base unit code -- always populated, but only
   * DISPLAYED in place of unitCode when measuredBaseQuantity is set
   * (weigh-at-kiosk restoration): "8 LB" (measured, base unit), never "8
   * BOX" (which would misleadingly read as a count of boxes). */
  baseUnitCode: string;
}

export function cartLineKey(inventoryItemId: string, sourceLocationId: string): string {
  return `${inventoryItemId}::${sourceLocationId}`;
}

/**
 * Applies one line into a cart, combining with whatever line (if any)
 * already occupies the same identity (item + source location) after
 * `excludeLineId` is removed first. Used for BOTH a fresh Add to
 * Withdrawal (excludeLineId null -- combines with the cart's existing
 * line for this item+source, per Part 2's "5 + 3 = 8" example) and
 * saving an edit (excludeLineId is the line being edited -- removing it
 * first means an unchanged item+source lands back on a fresh insert of
 * exactly the edited quantity, while a source changed to coincide with a
 * DIFFERENT existing line still combines with that line, consistent with
 * "same item+source always combines" everywhere in the cart).
 */
function applyCartLine(cart: CartLine[], excludeLineId: string | null, line: CartLine): CartLine[] {
  const remaining = excludeLineId === null ? cart : cart.filter((existing) => existing.id !== excludeLineId);
  const idx = remaining.findIndex((existing) => existing.id === line.id);
  if (idx === -1) return [...remaining, line];

  const existing = remaining[idx];
  const combinedQuantity = String((Number(existing.enteredQuantity) || 0) + (Number(line.enteredQuantity) || 0));
  // measuredBaseQuantity combines the same additive way -- two separate
  // weighings of the same item/source really did add that much base
  // quantity together. Only combines when BOTH lines are measured (the
  // same physical unit choice produced both); existing.measuredBaseQuantity
  // is null exactly when this combine can't apply (different unit mode),
  // which the caller never allows to reach here in practice.
  const combinedMeasured =
    existing.measuredBaseQuantity !== null && line.measuredBaseQuantity !== null
      ? String((Number(existing.measuredBaseQuantity) || 0) + (Number(line.measuredBaseQuantity) || 0))
      : line.measuredBaseQuantity;
  const updated = [...remaining];
  updated[idx] = { ...line, enteredQuantity: combinedQuantity, measuredBaseQuantity: combinedMeasured };
  return updated;
}

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
  /** Last 6 distinct items THIS employee (state.employeeDisplayName's own
   * appUserId, via the kiosk token -- never a client-supplied id)
   * successfully withdrew, newest distinct item first (2A.5 §12-14). Raw
   * ids only -- KioskApp derives the actually-displayed recent cards by
   * intersecting these against `items`, so a since-depleted item is
   * dropped automatically rather than needing its own stock check. Only
   * a COMMITTED batch submission ever changes what this reflects on next
   * fetch -- adding an item to the cart never writes inventory, so it can
   * never affect Recent (2A.5 Part 20). */
  recentItemIds: string[] | null;
  /** Confirmed vendor SKU/description search signals, keyed by
   * inventory_item_id (2A.5 §16 Part D) -- null while loading. */
  searchSignals: Record<string, { vendorSkus: string[]; vendorDescriptions: string[] }> | null;
  /** The multi-item withdrawal cart (2A.5). Provisional session UI state
   * only -- see CartLine's own doc comment. Belongs to the CURRENT
   * authenticated session/station; cleared on Start Over, on a confirmed
   * Change Station, and after a successful batch submission. */
  cart: CartLine[];
  /** Set while the quantity/source screen is editing an EXISTING cart
   * line (reached via Review Withdrawal's Edit control) rather than
   * adding a new one -- drives both the screen's own "Editing withdrawal
   * item" / "Save Changes" presentation and where Back/Save return to
   * (Review Withdrawal, never inventory browsing). Holds the ORIGINAL
   * line's id, since the employee may change its source location (and
   * therefore what its id would be) before saving. */
  editingCartLineId: string | null;
  selectedItem: KioskInventoryItem | null;
  /** The item's confirmed kiosk usage units -- one required primary, one
   * optional secondary -- see app/lib/kiosk/withdrawalUnit.ts. Null while
   * loading or when nothing is selected yet. */
  usageUnits: KioskUsageUnits | null;
  /** Which of usageUnits.primary/secondary is currently chosen for entry
   * -- always a unitId that matches one of them once usageUnits is
   * loaded. Defaults to primary the moment usageUnits loads unless a
   * pending edit (see EDIT_CART_LINE) asks to preserve a specific unit. */
  selectedUsageUnitId: string | null;
  /** Set when a selected item turns out not to have a confirmed primary
   * usage unit configured -- a master-data problem, not something the
   * employee caused. The item catalog already excludes items in this state
   * (see app/lib/kiosk/inventoryItems.ts), so reaching this is a rare
   * residual/race case; it renders a small inline "Setup required" notice
   * on the quantity screen itself rather than a large error banner. */
  withdrawalUnitUnavailable: boolean;
  /** Every storage location with a nonzero current balance for the
   * selected item (2A.5) -- null while loading. An empty array (not
   * null) means genuinely no stock anywhere, never a fake 0%. */
  availableLocations: KioskLocationAvailability[] | null;
  /** The exact physical source location this withdrawal will reduce --
   * auto-set when availableLocations has exactly one entry, otherwise
   * requires an explicit employee choice among several. Never
   * pro-rata/guessed. */
  selectedSourceLocationId: string | null;
  enteredQuantity: string;
  /** Generated once per BATCH checkout attempt (the whole cart, not one
   * line), reused verbatim on retry (see app/actions/withdrawalBatch.ts's
   * idempotency contract), cleared whenever the cart changes or the
   * checkout ends. */
  clientRequestId: string | null;
  submitting: boolean;
  errorBanner: { message: string } | null;
  /** Set by a successful batch submission, read once by the success
   * screen (2A.5 Part 21), then cleared by whichever of Withdraw
   * More/Finish the employee picks. */
  successSummary: { itemCount: number; stationName: string } | null;
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
    recentItemIds: null,
    searchSignals: null,
    cart: [],
    editingCartLineId: null,
    selectedItem: null,
    usageUnits: null,
    selectedUsageUnitId: null,
    withdrawalUnitUnavailable: false,
    availableLocations: null,
    selectedSourceLocationId: null,
    enteredQuantity: "",
    clientRequestId: null,
    submitting: false,
    errorBanner: null,
    successSummary: null,
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
  | { type: "RECENT_ITEMS_LOADED"; itemIds: string[] }
  | { type: "SEARCH_SIGNALS_LOADED"; signals: Record<string, { vendorSkus: string[]; vendorDescriptions: string[] }> }
  | { type: "ITEM_SELECTED"; item: KioskInventoryItem }
  | { type: "USAGE_UNITS_LOADED"; units: KioskUsageUnits }
  | { type: "WITHDRAWAL_UNIT_UNAVAILABLE" }
  | { type: "USAGE_UNIT_SELECTED"; unitId: string }
  | { type: "AVAILABILITY_LOADED"; locations: KioskLocationAvailability[] }
  | { type: "SOURCE_LOCATION_SELECTED"; locationId: string }
  | { type: "QUANTITY_CHANGED"; value: string }
  | { type: "ADD_TO_CART"; nextStep: Extract<KioskStep, "item_select" | "review"> }
  | { type: "EDIT_CART_LINE"; lineId: string }
  | { type: "SAVE_CART_LINE_EDIT"; nextStep: Extract<KioskStep, "item_select" | "review"> }
  | { type: "CANCEL_CART_LINE_EDIT" }
  | { type: "REMOVE_CART_LINE"; lineId: string }
  | { type: "CLEAR_CART" }
  | { type: "OPEN_REVIEW" }
  | { type: "BACK_TO_ITEMS"; message?: string }
  | { type: "SUBMIT_ATTEMPT_STARTED"; clientRequestId: string }
  | { type: "SUBMIT_FAILED"; message: string }
  | { type: "BATCH_SUBMIT_SUCCESS"; itemCount: number }
  | { type: "WITHDRAW_MORE" }
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
      // Milestone 2A.5: reachable at any point in the authenticated flow
      // now (a persistent header control), not only immediately after
      // login -- so any in-progress withdrawal selection AND the whole
      // cart must be cleared here, never carried from the old station
      // into the new one (multi-item cart: "MUST NOT silently retain the
      // cart"). Safe to apply unconditionally: these fields are already
      // empty when there was nothing in progress, so clearing them again
      // is a no-op there. The caller is responsible for confirming with
      // the employee first when there IS something to lose (see
      // KioskApp's change-station confirm dialog).
      return {
        ...state,
        step: "station_picker",
        // Recent is refreshed on every Change Station (2A.5 §15) -- cheap
        // and keeps it honest if a withdrawal happened elsewhere since
        // this session started. The org-wide item catalog and search
        // signals are unaffected by station and are deliberately left
        // alone -- they aren't station-scoped, so refetching them here
        // would just be wasted work.
        recentItemIds: null,
        cart: [],
        editingCartLineId: null,
        selectedItem: null,
        usageUnits: null,
        selectedUsageUnitId: null,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: null,
        enteredQuantity: "",
        clientRequestId: null,
        errorBanner: null,
      };

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

    case "RECENT_ITEMS_LOADED":
      return { ...state, recentItemIds: action.itemIds };

    case "SEARCH_SIGNALS_LOADED":
      return { ...state, searchSignals: action.signals };

    case "ITEM_SELECTED":
      return {
        ...state,
        selectedItem: action.item,
        editingCartLineId: null,
        usageUnits: null,
        selectedUsageUnitId: null,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: null,
        enteredQuantity: "",
        step: "quantity_entry",
      };

    case "USAGE_UNITS_LOADED": {
      // Deliberately does NOT reset enteredQuantity: ITEM_SELECTED already
      // clears it for a fresh add, and EDIT_CART_LINE deliberately
      // pre-populates it with the cart line's existing quantity before
      // this fires -- resetting it here would wipe that back out as soon
      // as the fresh unit/availability reload completes.
      //
      // Preserves a pending selection the same way AVAILABILITY_LOADED
      // preserves a pending source location: EDIT_CART_LINE stashes the
      // cart line's own entered unit into selectedUsageUnitId BEFORE this
      // fires (usageUnits is still null then); once the authoritative
      // options arrive, keep that choice only if it's still a genuine
      // option, otherwise fall back to primary. A fresh add (ITEM_SELECTED
      // nulled selectedUsageUnitId) always lands on primary here.
      const candidateIds = [action.units.primary.unitId, action.units.secondary?.unitId ?? null];
      const preserved = state.selectedUsageUnitId !== null && candidateIds.includes(state.selectedUsageUnitId) ? state.selectedUsageUnitId : action.units.primary.unitId;
      return { ...state, usageUnits: action.units, withdrawalUnitUnavailable: false, selectedUsageUnitId: preserved };
    }

    case "WITHDRAWAL_UNIT_UNAVAILABLE":
      return { ...state, withdrawalUnitUnavailable: true };

    case "USAGE_UNIT_SELECTED":
      // Changing the selected unit must never silently reuse an
      // incompatible quantity (approved-plan §11) -- "5" typed against a
      // primary CASE means something different against a secondary EACH.
      // Chosen behavior: RESET, never preserve-with-relabel. A no-op
      // reselect of the already-active unit leaves the quantity alone.
      if (action.unitId === state.selectedUsageUnitId) return state;
      return { ...state, selectedUsageUnitId: action.unitId, enteredQuantity: "" };

    case "AVAILABILITY_LOADED": {
      // Auto-select only when there is EXACTLY one candidate location --
      // zero means genuinely out of stock (handled by the UI, never
      // guessed here). When editing an existing cart line, its ORIGINAL
      // source location is already selected before this fires (see
      // EDIT_CART_LINE below) -- preserve that choice across the fresh
      // reload instead of clobbering it back to null, as long as it's
      // still a genuine candidate; otherwise fall back to the normal
      // single-candidate auto-select / explicit-choice-required rule.
      const preserved =
        state.selectedSourceLocationId !== null && action.locations.some((l) => l.locationId === state.selectedSourceLocationId)
          ? state.selectedSourceLocationId
          : action.locations.length === 1
            ? action.locations[0].locationId
            : null;
      return { ...state, availableLocations: action.locations, selectedSourceLocationId: preserved };
    }

    case "SOURCE_LOCATION_SELECTED":
      return { ...state, selectedSourceLocationId: action.locationId, enteredQuantity: "" };

    case "QUANTITY_CHANGED":
      return { ...state, enteredQuantity: action.value };

    case "ADD_TO_CART": {
      // Fresh add from browsing: never writes inventory -- only updates
      // the cart -- then continues to whichever screen the employee
      // chose (2A.5 dual completion paths): "Add & Continue Shopping"
      // (nextStep "item_select", so they can immediately pick the next
      // item) or "Add & Review Withdrawal" (nextStep "review", skipping
      // the extra trip through browsing on the last item). Both share
      // this exact same cart mutation -- only the destination differs.
      // Combines into an existing line for the same item+source
      // (quantities add); a different source stays a separate line.
      if (!state.selectedItem || !state.usageUnits || !state.selectedSourceLocationId || !state.availableLocations) return state;
      const location = state.availableLocations.find((l) => l.locationId === state.selectedSourceLocationId);
      if (!location) return state;
      const chosenUnit =
        state.usageUnits.secondary && state.selectedUsageUnitId === state.usageUnits.secondary.unitId ? state.usageUnits.secondary : state.usageUnits.primary;

      const line: CartLine = {
        id: cartLineKey(state.selectedItem.id, state.selectedSourceLocationId),
        inventoryItemId: state.selectedItem.id,
        itemName: state.selectedItem.name,
        categoryName: state.selectedItem.categoryName,
        sourceLocationId: state.selectedSourceLocationId,
        sourceLocationName: location.locationName,
        enteredQuantity: state.enteredQuantity,
        enteredUnitId: chosenUnit.unitId,
        unitCode: chosenUnit.unitCode,
        measuredBaseQuantity: chosenUnit.requiresActualMeasurement ? state.enteredQuantity : null,
        baseUnitCode: state.usageUnits.baseUnitCode,
      };

      return {
        ...state,
        cart: applyCartLine(state.cart, null, line),
        step: action.nextStep,
        selectedItem: null,
        usageUnits: null,
        selectedUsageUnitId: null,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: null,
        enteredQuantity: "",
        clientRequestId: null,
        errorBanner: null,
      };
    }

    case "EDIT_CART_LINE": {
      // Reached from Review Withdrawal's Edit control (Part 9). Reuses
      // the quantity_entry screen -- editingCartLineId is what makes it
      // present as "Editing withdrawal item" / "Save Changes" and
      // return to Review (not browsing) on Back/Save. Re-fetches
      // usageUnits/availableLocations fresh (nulled below) so the
      // employee edits against current live stock, not a stale snapshot
      // from whenever the line was originally added; the line's ORIGINAL
      // source is pre-selected and preserved across that reload (see
      // AVAILABILITY_LOADED above).
      const line = state.cart.find((l) => l.id === action.lineId);
      const item = line ? (state.items?.find((i) => i.id === line.inventoryItemId) ?? null) : null;
      if (!line || !item) return state;

      return {
        ...state,
        step: "quantity_entry",
        editingCartLineId: line.id,
        selectedItem: item,
        usageUnits: null,
        // Tentative -- confirmed/overridden by USAGE_UNITS_LOADED once the
        // authoritative options for this item are back (see its own
        // comment for why this mirrors AVAILABILITY_LOADED's pattern).
        selectedUsageUnitId: line.enteredUnitId,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: line.sourceLocationId,
        enteredQuantity: line.enteredQuantity,
        errorBanner: null,
      };
    }

    case "SAVE_CART_LINE_EDIT": {
      if (!state.editingCartLineId || !state.selectedItem || !state.usageUnits || !state.selectedSourceLocationId || !state.availableLocations) {
        return state;
      }
      const location = state.availableLocations.find((l) => l.locationId === state.selectedSourceLocationId);
      if (!location) return state;
      const chosenUnit =
        state.usageUnits.secondary && state.selectedUsageUnitId === state.usageUnits.secondary.unitId ? state.usageUnits.secondary : state.usageUnits.primary;

      const line: CartLine = {
        id: cartLineKey(state.selectedItem.id, state.selectedSourceLocationId),
        inventoryItemId: state.selectedItem.id,
        itemName: state.selectedItem.name,
        categoryName: state.selectedItem.categoryName,
        sourceLocationId: state.selectedSourceLocationId,
        sourceLocationName: location.locationName,
        enteredQuantity: state.enteredQuantity,
        enteredUnitId: chosenUnit.unitId,
        unitCode: chosenUnit.unitCode,
        measuredBaseQuantity: chosenUnit.requiresActualMeasurement ? state.enteredQuantity : null,
        baseUnitCode: state.usageUnits.baseUnitCode,
      };

      return {
        ...state,
        cart: applyCartLine(state.cart, state.editingCartLineId, line),
        step: action.nextStep,
        editingCartLineId: null,
        selectedItem: null,
        usageUnits: null,
        selectedUsageUnitId: null,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: null,
        enteredQuantity: "",
        // The cart just changed -- any prior failed-submit attempt/error
        // now refers to a stale payload (see REMOVE_CART_LINE).
        clientRequestId: null,
        errorBanner: null,
      };
    }

    case "CANCEL_CART_LINE_EDIT":
      // Back/cancel out of an edit never mutates the cart -- the line
      // being edited was never touched until Save (Part 9).
      return {
        ...state,
        step: "review",
        editingCartLineId: null,
        selectedItem: null,
        usageUnits: null,
        selectedUsageUnitId: null,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: null,
        enteredQuantity: "",
        errorBanner: null,
      };

    case "REMOVE_CART_LINE": {
      const cart = state.cart.filter((line) => line.id !== action.lineId);
      // If the cart becomes empty, return to inventory browsing (Part 9).
      // clientRequestId/errorBanner are cleared here too -- the payload a
      // prior failed submit attempt referred to (and any error message
      // about it) is now stale the moment the cart itself changes, even
      // when the employee never left the review screen to do it.
      return { ...state, cart, step: cart.length === 0 ? "item_select" : state.step, clientRequestId: null, errorBanner: null };
    }

    case "CLEAR_CART":
      return { ...state, cart: [], step: "item_select", clientRequestId: null, errorBanner: null };

    case "OPEN_REVIEW":
      return { ...state, step: "review", errorBanner: null };

    case "BACK_TO_ITEMS":
      // Also used as "Continue Shopping" from Review Withdrawal (Part
      // 10) -- the cart is deliberately NOT touched here, only ever by
      // an explicit Remove/Clear/successful submission.
      return {
        ...state,
        step: "item_select",
        editingCartLineId: null,
        selectedItem: null,
        usageUnits: null,
        selectedUsageUnitId: null,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: null,
        enteredQuantity: "",
        clientRequestId: null,
        errorBanner: action.message ? { message: action.message } : null,
      };

    case "SUBMIT_ATTEMPT_STARTED":
      // Only adopts the freshly generated id if one isn't already in
      // flight -- a retry of the same attempt reuses whatever is already
      // here, which is exactly what makes the batch submission safe to
      // retry (one client_request_id per checkout, not per line).
      return { ...state, clientRequestId: state.clientRequestId ?? action.clientRequestId, submitting: true, errorBanner: null };

    case "SUBMIT_FAILED":
      // Stays on "review" with the cart and every entered field intact --
      // clientRequestId is deliberately NOT cleared here, so a retry
      // reuses it.
      return { ...state, submitting: false, errorBanner: { message: action.message } };

    case "BATCH_SUBMIT_SUCCESS":
      // Unlike the old single-item SUBMIT_SUCCESS, this does NOT clear
      // employee/station identity or kioskToken -- Withdraw More (Part
      // 21) needs to stay authenticated at the same session station.
      // Only the just-submitted cart and any in-progress selection are
      // cleared; `items`/`recentItemIds` are deliberately left as-is
      // here (WITHDRAW_MORE is what forces their refresh, matching
      // "refresh inventory / refresh Recently Used" applying only once
      // the employee actually continues).
      return {
        ...state,
        step: "success",
        successSummary: { itemCount: action.itemCount, stationName: state.selectedStationName ?? "" },
        cart: [],
        editingCartLineId: null,
        selectedItem: null,
        usageUnits: null,
        selectedUsageUnitId: null,
        withdrawalUnitUnavailable: false,
        availableLocations: null,
        selectedSourceLocationId: null,
        enteredQuantity: "",
        clientRequestId: null,
        submitting: false,
        errorBanner: null,
      };

    case "WITHDRAW_MORE":
      // Same employee, same current session station, kioskToken
      // untouched -- only the submitted cart/success summary clear, and
      // items/recentItemIds are forced to refetch (Part 21: "refresh
      // inventory," "refresh Recently Used") by nulling them out here.
      return {
        ...state,
        step: "item_select",
        successSummary: null,
        items: null,
        recentItemIds: null,
      };

    case "ACTIVITY_PING":
      return { ...state, lastActivityAt: Date.now() };

    case "TOKEN_REFRESHED":
      return { ...state, kioskToken: action.kioskToken, tokenClientIssuedAt: Date.now(), refreshing: false };

    case "REFRESHING_TOKEN":
      return { ...state, refreshing: action.refreshing };

    case "SESSION_EXPIRED":
      // Full reset, including employee identity, the cart, and every
      // entered field -- the previous employee's session must not linger
      // in any form.
      return {
        ...createInitialKioskState(),
        errorBanner: { message: "Session expired — please enter your PIN again." },
      };

    case "START_OVER":
      // Full reset, including the cart -- the caller is responsible for
      // confirming with the employee first when the cart is non-empty
      // (Part 22), exactly like Change Station.
      return createInitialKioskState();

    case "DISMISS_SCREEN_ERROR":
      return { ...state, errorBanner: null };

    case "SCREEN_ERROR":
      return { ...state, errorBanner: { message: action.message } };

    default:
      return state;
  }
}
